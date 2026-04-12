package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const helperVersion = "0.2.2"
const autoUpdateInterval = 6 * time.Hour
const autoUpdatePollInterval = 5 * time.Second
const commandPollTimeout = 15 * time.Second
const commandWorkerCount = 4
const retryBackoff = 2 * time.Second
const heartbeatInterval = 15 * time.Second

type rootFlag []string

func (r *rootFlag) String() string {
	return strings.Join(*r, ",")
}

func (r *rootFlag) Set(value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return errors.New("root value cannot be empty")
	}
	*r = append(*r, trimmed)
	return nil
}

type Config struct {
	ServerURL     string            `json:"serverUrl"`
	DeviceID      string            `json:"deviceId"`
	DeviceToken   string            `json:"deviceToken"`
	AllowedRoots  map[string]string `json:"allowedRoots"`
	Limits        LimitsConfig      `json:"limits"`
	Stage         StageConfig       `json:"stage"`
	HelperVersion string            `json:"helperVersion"`
}

type LimitsConfig struct {
	MaxReadBytes   int64 `json:"maxReadBytes"`
	MaxStageBytes  int64 `json:"maxStageBytes"`
	MaxFindResults int   `json:"maxFindResults"`
}

type StageConfig struct {
	AllowedExtensions []string `json:"allowedExtensions"`
}

type legacyDefaultSignature struct {
	roots             map[string]string
	allowedExtensions []string
}

type allowedRoot struct {
	Alias string `json:"alias"`
	Path  string `json:"path"`
}

type pairRequest struct {
	Code          string        `json:"code"`
	Platform      string        `json:"platform,omitempty"`
	DeviceName    string        `json:"deviceName,omitempty"`
	HelperVersion string        `json:"helperVersion,omitempty"`
	AllowedRoots  []allowedRoot `json:"allowedRoots,omitempty"`
}

type bootstrapRequest struct {
	Token         string        `json:"token"`
	Platform      string        `json:"platform,omitempty"`
	DeviceName    string        `json:"deviceName,omitempty"`
	HelperVersion string        `json:"helperVersion,omitempty"`
	AllowedRoots  []allowedRoot `json:"allowedRoots,omitempty"`
}

type pairResponse struct {
	Device struct {
		ID            string        `json:"id"`
		Token         string        `json:"token"`
		SessionID     string        `json:"sessionId"`
		Platform      string        `json:"platform"`
		DeviceName    string        `json:"deviceName"`
		HelperVersion string        `json:"helperVersion"`
		AllowedRoots  []allowedRoot `json:"allowedRoots"`
	} `json:"device"`
}

type heartbeatRequest struct {
	Platform      string            `json:"platform,omitempty"`
	DeviceName    string            `json:"deviceName,omitempty"`
	HelperVersion string            `json:"helperVersion,omitempty"`
	AllowedRoots  map[string]string `json:"allowedRoots,omitempty"`
}

type commandEnvelope struct {
	Command *bridgeCommand `json:"command"`
}

type bridgeCommand struct {
	ID    string                 `json:"id"`
	Name  string                 `json:"name"`
	Args  map[string]interface{} `json:"args"`
	State string                 `json:"state"`
}

type commandResultPayload struct {
	Result map[string]interface{} `json:"result,omitempty"`
	Error  string                 `json:"error,omitempty"`
}

type stageFinalizeResponse struct {
	Asset map[string]interface{} `json:"asset"`
}

type bootstrapSpec struct {
	ServerURL    string            `json:"serverUrl"`
	Token        string            `json:"token"`
	AllowedRoots map[string]string `json:"allowedRoots"`
}

type helperReleaseManifest struct {
	Release struct {
		Version      string `json:"version"`
		Platform     string `json:"platform"`
		Arch         string `json:"arch"`
		Filename     string `json:"filename"`
		SizeBytes    int64  `json:"sizeBytes"`
		Sha256       string `json:"sha256"`
		PublishedAt  string `json:"publishedAt"`
		DownloadURL  string `json:"downloadUrl"`
		DownloadPath string `json:"downloadPath"`
	} `json:"release"`
}

type listEntry struct {
	Name       string `json:"name"`
	RelPath    string `json:"relPath"`
	Kind       string `json:"kind"`
	Size       int64  `json:"size,omitempty"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(1)
	}

	var err error
	switch os.Args[1] {
	case "pair":
		err = runPair(os.Args[2:])
	case "bootstrap":
		err = runBootstrap(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "run":
		err = runRun(os.Args[2:])
	case "doctor":
		err = runDoctor(os.Args[2:])
	case "--help", "-h", "help":
		printHelp()
		return
	default:
		err = fmt.Errorf("unknown command: %s", os.Args[1])
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Println(`remotelab-helper

Usage:
  remotelab-helper pair --server <url> --code <pairing-code> [--root alias=path ...]
  remotelab-helper bootstrap [--file <path> | --server <url> --token <bootstrap-token>] [--root alias=path ...]
  remotelab-helper serve
  remotelab-helper run [--file <path>] [--root alias=path ...]
  remotelab-helper doctor

Notes:
  - pair stores config under the platform user config directory.
  - bootstrap redeems a one-time first-launch token and writes the device config.
  - serve runs the heartbeat and command loop.
  - run bootstraps first if needed, then enters the serve loop.
  - if no roots are provided, the helper exposes the machine in read-only mode using OS-level root aliases`)
}

func runPair(argv []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	serverURL := fs.String("server", "", "RemoteLab base URL")
	code := fs.String("code", "", "pairing code")
	var roots rootFlag
	fs.Var(&roots, "root", "allowed root in alias=path form")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	if strings.TrimSpace(*serverURL) == "" {
		return errors.New("--server is required")
	}
	if strings.TrimSpace(*code) == "" {
		return errors.New("--code is required")
	}

	cfg := defaultConfig()
	cfg.ServerURL = normalizeBaseURL(*serverURL)
	cfg.AllowedRoots = parseRootFlags(roots)

	hostname, _ := os.Hostname()
	reqBody := pairRequest{
		Code:          strings.TrimSpace(*code),
		Platform:      runtime.GOOS,
		DeviceName:    hostname,
		HelperVersion: helperVersion,
		AllowedRoots:  mapToAllowedRoots(cfg.AllowedRoots),
	}

	var response pairResponse
	if err := doJSONRequest(http.MethodPost, cfg.ServerURL+"/api/local-bridge/pair", "", reqBody, &response); err != nil {
		return err
	}
	if strings.TrimSpace(response.Device.ID) == "" || strings.TrimSpace(response.Device.Token) == "" {
		return errors.New("pairing succeeded but device credentials were missing")
	}

	cfg.DeviceID = response.Device.ID
	cfg.DeviceToken = response.Device.Token
	if len(response.Device.AllowedRoots) > 0 {
		cfg.AllowedRoots = allowedRootsToMap(response.Device.AllowedRoots)
	}
	cfg.HelperVersion = helperVersion

	if err := saveConfig(cfg); err != nil {
		return err
	}

	fmt.Printf("paired device %s\n", cfg.DeviceID)
	return nil
}

func runBootstrap(argv []string) error {
	fs := flag.NewFlagSet("bootstrap", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	serverURL := fs.String("server", "", "RemoteLab base URL")
	token := fs.String("token", "", "bootstrap token")
	filePath := fs.String("file", "", "bootstrap spec file")
	var roots rootFlag
	fs.Var(&roots, "root", "allowed root in alias=path form")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	_, err := performBootstrap(*serverURL, *token, *filePath, parseRootFlags(roots))
	return err
}

func runRun(argv []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	serverURL := fs.String("server", "", "RemoteLab base URL")
	token := fs.String("token", "", "bootstrap token")
	filePath := fs.String("file", "", "bootstrap spec file")
	var roots rootFlag
	fs.Var(&roots, "root", "allowed root in alias=path form")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		cfg, err = performBootstrap(*serverURL, *token, *filePath, parseRootFlags(roots))
		if err != nil {
			return err
		}
	}
	if strings.TrimSpace(cfg.DeviceID) == "" || strings.TrimSpace(cfg.DeviceToken) == "" || strings.TrimSpace(cfg.ServerURL) == "" {
		cfg, err = performBootstrap(*serverURL, *token, *filePath, parseRootFlags(roots))
		if err != nil {
			return err
		}
	}
	return serveLoop(cfg)
}

func runServe(argv []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if strings.TrimSpace(cfg.DeviceID) == "" || strings.TrimSpace(cfg.DeviceToken) == "" || strings.TrimSpace(cfg.ServerURL) == "" {
		return errors.New("config is missing serverUrl/deviceId/deviceToken; run pair first")
	}
	return serveLoop(cfg)
}

func serveLoop(cfg Config) error {
	hostname, _ := os.Hostname()
	stopCh := make(chan struct{})
	var workers sync.WaitGroup
	var activeCommands atomic.Int32

	workers.Add(1)
	go func() {
		defer workers.Done()
		runHeartbeatLoop(cfg, hostname, stopCh)
	}()

	for index := 0; index < commandWorkerCount; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			runCommandWorker(cfg, &activeCommands, stopCh)
		}()
	}

	defer func() {
		close(stopCh)
		workers.Wait()
	}()

	lastUpdateCheck := time.Time{}
	for {
		if (lastUpdateCheck.IsZero() || time.Since(lastUpdateCheck) >= autoUpdateInterval) && activeCommands.Load() == 0 {
			updated, err := maybeAutoUpdate(cfg)
			lastUpdateCheck = time.Now()
			if err != nil {
				fmt.Fprintf(os.Stderr, "auto update check failed: %v\n", err)
			}
			if updated {
				return nil
			}
		}
		time.Sleep(autoUpdatePollInterval)
	}
}

func runHeartbeatLoop(cfg Config, hostname string, stopCh <-chan struct{}) {
	for {
		if err := sendHeartbeat(cfg, hostname); err != nil {
			fmt.Fprintf(os.Stderr, "heartbeat failed: %v\n", err)
			if !sleepOrStop(retryBackoff, stopCh) {
				return
			}
			continue
		}
		if !sleepOrStop(heartbeatInterval, stopCh) {
			return
		}
	}
}

func sendHeartbeat(cfg Config, hostname string) error {
	hbReq := heartbeatRequest{
		Platform:      runtime.GOOS,
		DeviceName:    hostname,
		HelperVersion: helperVersion,
		AllowedRoots:  cfg.AllowedRoots,
	}
	return doDeviceJSONRequest(
		http.MethodPost,
		cfg,
		fmt.Sprintf("/api/local-bridge/devices/%s/heartbeat", url.PathEscape(cfg.DeviceID)),
		hbReq,
		nil,
	)
}

func runCommandWorker(cfg Config, activeCommands *atomic.Int32, stopCh <-chan struct{}) {
	for {
		select {
		case <-stopCh:
			return
		default:
		}

		var envelope commandEnvelope
		nextPath := fmt.Sprintf(
			"/api/local-bridge/devices/%s/commands/next?timeoutMs=%d",
			url.PathEscape(cfg.DeviceID),
			int(commandPollTimeout/time.Millisecond),
		)
		if err := doDeviceJSONRequest(http.MethodGet, cfg, nextPath, nil, &envelope); err != nil {
			fmt.Fprintf(os.Stderr, "next command failed: %v\n", err)
			if !sleepOrStop(retryBackoff, stopCh) {
				return
			}
			continue
		}
		if envelope.Command == nil || strings.TrimSpace(envelope.Command.ID) == "" {
			continue
		}

		payload := commandResultPayload{}
		func() {
			activeCommands.Add(1)
			defer activeCommands.Add(-1)
			result, resultErr := executeCommand(cfg, envelope.Command)
			if resultErr != nil {
				payload.Error = resultErr.Error()
				return
			}
			payload.Result = result
		}()

		resultPath := fmt.Sprintf("/api/local-bridge/devices/%s/commands/%s/result", url.PathEscape(cfg.DeviceID), url.PathEscape(envelope.Command.ID))
		if err := doDeviceJSONRequest(http.MethodPost, cfg, resultPath, payload, nil); err != nil {
			fmt.Fprintf(os.Stderr, "submit result failed: %v\n", err)
			if !sleepOrStop(retryBackoff, stopCh) {
				return
			}
		}
	}
}

func sleepOrStop(duration time.Duration, stopCh <-chan struct{}) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-stopCh:
		return false
	case <-timer.C:
		return true
	}
}

func runDoctor(argv []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	configPath, _ := resolveConfigPath()
	fmt.Printf("config: %s\n", configPath)
	fmt.Printf("server: %s\n", cfg.ServerURL)
	fmt.Printf("deviceId: %s\n", cfg.DeviceID)
	fmt.Printf("roots:\n")
	for alias, path := range cfg.AllowedRoots {
		fmt.Printf("  - %s=%s\n", alias, path)
	}
	return nil
}

func defaultConfig() Config {
	return Config{
		AllowedRoots: map[string]string{},
		Limits: LimitsConfig{
			MaxReadBytes:   64 * 1024,
			MaxStageBytes:  256 * 1024 * 1024,
			MaxFindResults: 200,
		},
		Stage:         StageConfig{},
		HelperVersion: helperVersion,
	}
}

func resolveConfigPath() (string, error) {
	root, err := resolveHelperStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "config.json"), nil
}

func resolveBootstrapPath() (string, error) {
	root, err := resolveHelperStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "bootstrap.json"), nil
}

func resolveHelperStateDir() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "RemoteLabHelper"), nil
}

func resolveManagedBinaryPath() (string, error) {
	root, err := resolveHelperStateDir()
	if err != nil {
		return "", err
	}
	filename := fmt.Sprintf("remotelab-helper-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		filename += ".exe"
	}
	return filepath.Join(root, "bin", filename), nil
}

func loadConfig() (Config, error) {
	path, err := resolveConfigPath()
	if err != nil {
		return Config{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	defaults := defaultConfig()
	cfg := defaults
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	cfg.ServerURL = normalizeBaseURL(cfg.ServerURL)
	cfg = applyInternalReadAllDefaults(cfg)
	cfg.Stage.AllowedExtensions = mergeAllowedExtensions(nil, cfg.Stage.AllowedExtensions)
	return cfg, nil
}

func saveConfig(cfg Config) error {
	path, err := resolveConfigPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func loadBootstrapSpec(path string) (bootstrapSpec, string, error) {
	resolvedPath := strings.TrimSpace(path)
	if resolvedPath == "" {
		var err error
		resolvedPath, err = resolveBootstrapPath()
		if err != nil {
			return bootstrapSpec{}, "", err
		}
	}
	data, err := os.ReadFile(resolvedPath)
	if err != nil {
		return bootstrapSpec{}, resolvedPath, err
	}
	spec := bootstrapSpec{}
	if err := json.Unmarshal(data, &spec); err != nil {
		return bootstrapSpec{}, resolvedPath, err
	}
	spec.ServerURL = normalizeBaseURL(spec.ServerURL)
	spec.Token = strings.TrimSpace(spec.Token)
	if spec.AllowedRoots == nil {
		spec.AllowedRoots = map[string]string{}
	}
	return spec, resolvedPath, nil
}

func performBootstrap(serverURL string, token string, filePath string, rootOverrides map[string]string) (Config, error) {
	spec := bootstrapSpec{
		ServerURL: normalizeBaseURL(serverURL),
		Token:     strings.TrimSpace(token),
	}
	loadedSpecPath := ""
	if spec.ServerURL == "" || spec.Token == "" || len(rootOverrides) == 0 {
		loadedSpec, loadedPath, err := loadBootstrapSpec(filePath)
		if err == nil {
			loadedSpecPath = loadedPath
			if spec.ServerURL == "" {
				spec.ServerURL = loadedSpec.ServerURL
			}
			if spec.Token == "" {
				spec.Token = loadedSpec.Token
			}
			if len(rootOverrides) == 0 {
				rootOverrides = loadedSpec.AllowedRoots
			}
		} else if filePath != "" || (spec.ServerURL == "" || spec.Token == "") {
			return Config{}, err
		}
	}
	if spec.ServerURL == "" {
		return Config{}, errors.New("bootstrap serverUrl is required")
	}
	if spec.Token == "" {
		return Config{}, errors.New("bootstrap token is required")
	}
	if len(rootOverrides) == 0 {
		rootOverrides = detectDefaultAllowedRoots()
	}

	hostname, _ := os.Hostname()
	reqBody := bootstrapRequest{
		Token:         spec.Token,
		Platform:      runtime.GOOS,
		DeviceName:    hostname,
		HelperVersion: helperVersion,
		AllowedRoots:  mapToAllowedRoots(rootOverrides),
	}

	var response pairResponse
	if err := doJSONRequest(http.MethodPost, spec.ServerURL+"/api/local-bridge/bootstrap/redeem", "", reqBody, &response); err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(response.Device.ID) == "" || strings.TrimSpace(response.Device.Token) == "" {
		return Config{}, errors.New("bootstrap succeeded but device credentials were missing")
	}

	cfg := defaultConfig()
	cfg.ServerURL = spec.ServerURL
	cfg.DeviceID = response.Device.ID
	cfg.DeviceToken = response.Device.Token
	if len(response.Device.AllowedRoots) > 0 {
		cfg.AllowedRoots = allowedRootsToMap(response.Device.AllowedRoots)
	} else {
		cfg.AllowedRoots = rootOverrides
	}
	cfg.HelperVersion = helperVersion
	if err := saveConfig(cfg); err != nil {
		return Config{}, err
	}
	if loadedSpecPath != "" {
		_ = os.Remove(loadedSpecPath)
	}
	fmt.Printf("bootstrapped device %s\n", cfg.DeviceID)
	return cfg, nil
}

func detectDefaultAllowedRoots() map[string]string {
	roots := map[string]string{}
	homeDir, _ := os.UserHomeDir()
	homeDir = strings.TrimSpace(homeDir)

	switch runtime.GOOS {
	case "windows":
		for drive := 'C'; drive <= 'Z'; drive++ {
			rootPath := fmt.Sprintf("%c:\\", drive)
			info, err := os.Stat(rootPath)
			if err == nil && info.IsDir() {
				roots[strings.ToLower(string(drive))] = rootPath
			}
		}
	default:
		roots["root"] = string(filepath.Separator)
		if homeDir != "" {
			roots["home"] = homeDir
		}
		if runtime.GOOS == "darwin" {
			if info, err := os.Stat("/Volumes"); err == nil && info.IsDir() {
				roots["volumes"] = "/Volumes"
			}
		}
	}

	if len(roots) == 0 && homeDir != "" {
		roots["home"] = homeDir
	}
	return roots
}

func normalizeBaseURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func parseRootFlags(flags []string) map[string]string {
	roots := map[string]string{}
	for _, entry := range flags {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) != 2 {
			continue
		}
		alias := strings.TrimSpace(parts[0])
		path := strings.TrimSpace(parts[1])
		if alias == "" || path == "" {
			continue
		}
		roots[alias] = path
	}
	return roots
}

func mapToAllowedRoots(input map[string]string) []allowedRoot {
	out := make([]allowedRoot, 0, len(input))
	for alias, path := range input {
		out = append(out, allowedRoot{Alias: alias, Path: path})
	}
	return out
}

func allowedRootsToMap(input []allowedRoot) map[string]string {
	out := map[string]string{}
	for _, entry := range input {
		alias := strings.TrimSpace(entry.Alias)
		path := strings.TrimSpace(entry.Path)
		if alias == "" || path == "" {
			continue
		}
		out[alias] = path
	}
	return out
}

func legacyDefaultConfigSignature() legacyDefaultSignature {
	roots := map[string]string{}
	homeDir, err := os.UserHomeDir()
	if err == nil {
		homeDir = strings.TrimSpace(homeDir)
	}
	if homeDir != "" {
		candidates := []struct {
			alias string
			name  string
		}{
			{alias: "desktop", name: "Desktop"},
			{alias: "documents", name: "Documents"},
			{alias: "downloads", name: "Downloads"},
		}
		for _, candidate := range candidates {
			path := filepath.Join(homeDir, candidate.name)
			info, statErr := os.Stat(path)
			if statErr == nil && info.IsDir() {
				roots[candidate.alias] = path
			}
		}
		if len(roots) == 0 {
			roots["home"] = homeDir
		}
	}

	return legacyDefaultSignature{
		roots: roots,
		allowedExtensions: []string{
			".rvt", ".dwg", ".ifc", ".pdf",
			".txt", ".md", ".markdown", ".csv", ".tsv", ".log",
			".json", ".yml", ".yaml", ".xml", ".toml", ".ini",
			".docx", ".xlsx", ".sql", ".html", ".css", ".js", ".ts", ".tsx", ".jsx",
		},
	}
}

func sameStringMap(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if strings.TrimSpace(right[key]) != strings.TrimSpace(value) {
			return false
		}
	}
	return true
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := map[string]int{}
	for _, value := range left {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" {
			continue
		}
		seen[normalized] += 1
	}
	for _, value := range right {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" {
			continue
		}
		count := seen[normalized]
		if count <= 0 {
			return false
		}
		seen[normalized] = count - 1
	}
	for _, count := range seen {
		if count != 0 {
			return false
		}
	}
	return true
}

func applyInternalReadAllDefaults(cfg Config) Config {
	legacy := legacyDefaultConfigSignature()
	if len(cfg.AllowedRoots) == 0 || sameStringMap(cfg.AllowedRoots, legacy.roots) {
		cfg.AllowedRoots = detectDefaultAllowedRoots()
	}
	if sameStringSet(cfg.Stage.AllowedExtensions, legacy.allowedExtensions) {
		cfg.Stage.AllowedExtensions = nil
	}
	return cfg
}

var httpClient = &http.Client{
	Timeout: 45 * time.Second,
}

func doJSONRequest(method, endpoint, bearerToken string, body interface{}, out interface{}) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if strings.TrimSpace(bearerToken) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(bearerToken))
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		var payload map[string]interface{}
		_ = json.Unmarshal(raw, &payload)
		if message, ok := payload["error"].(string); ok && strings.TrimSpace(message) != "" {
			return errors.New(message)
		}
		return fmt.Errorf("request failed with status %d", resp.StatusCode)
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func doBinaryRequest(method, endpoint, bearerToken string, outPath string) error {
	req, err := http.NewRequest(method, endpoint, nil)
	if err != nil {
		return err
	}
	if strings.TrimSpace(bearerToken) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(bearerToken))
	}

	downloadClient := &http.Client{Timeout: 5 * time.Minute}
	resp, err := downloadClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("request failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return err
	}
	file, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := io.Copy(file, resp.Body); err != nil {
		return err
	}
	return nil
}

func doDeviceJSONRequest(method string, cfg Config, path string, body interface{}, out interface{}) error {
	return doJSONRequest(method, cfg.ServerURL+path, cfg.DeviceToken, body, out)
}

func doReleaseJSONRequest(cfg Config, path string, out interface{}) error {
	return doJSONRequest(http.MethodGet, cfg.ServerURL+path, "", nil, out)
}

func executeCommand(cfg Config, command *bridgeCommand) (map[string]interface{}, error) {
	switch command.Name {
	case "list":
		return executeList(cfg, command.Args)
	case "find":
		return executeFind(cfg, command.Args)
	case "stat":
		return executeStat(cfg, command.Args)
	case "read_text":
		return executeReadText(cfg, command.Args)
	case "stage":
		return executeStage(cfg, command)
	case "pack":
		return executePack(cfg, command)
	default:
		return nil, fmt.Errorf("unsupported command: %s", command.Name)
	}
}

func executeList(cfg Config, args map[string]interface{}) (map[string]interface{}, error) {
	rootAlias := getStringArg(args, "rootAlias")
	relPath := getStringArg(args, "relPath")
	if relPath == "" {
		relPath = "."
	}
	maxDepth := int(getInt64Arg(args, "depth", 1))
	targetPath, rootPath, err := resolveAllowedPath(cfg, rootAlias, relPath)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(targetPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		entry, err := buildListEntry(rootPath, targetPath, info)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"entries": []listEntry{entry}}, nil
	}

	entries := []listEntry{}
	if err := walkList(rootPath, targetPath, 0, maxDepth, &entries); err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": entries}, nil
}

func walkList(rootPath, dir string, depth, maxDepth int, out *[]listEntry) error {
	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range dirEntries {
		fullPath := filepath.Join(dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			return err
		}
		item, err := buildListEntry(rootPath, fullPath, info)
		if err != nil {
			return err
		}
		*out = append(*out, item)
		if info.IsDir() && depth+1 < maxDepth {
			if err := walkList(rootPath, fullPath, depth+1, maxDepth, out); err != nil {
				return err
			}
		}
	}
	return nil
}

func executeFind(cfg Config, args map[string]interface{}) (map[string]interface{}, error) {
	rootAlias := getStringArg(args, "rootAlias")
	relPath := getStringArg(args, "relPath")
	if relPath == "" {
		relPath = "."
	}
	query := strings.ToLower(getStringArg(args, "query"))
	glob := getStringArg(args, "glob")
	maxResults := int(getInt64Arg(args, "maxResults", int64(cfg.Limits.MaxFindResults)))
	if maxResults <= 0 {
		maxResults = cfg.Limits.MaxFindResults
	}

	targetPath, rootPath, err := resolveAllowedPath(cfg, rootAlias, relPath)
	if err != nil {
		return nil, err
	}

	entries := []listEntry{}
	err = filepath.WalkDir(targetPath, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if len(entries) >= maxResults {
			return io.EOF
		}
		if path == targetPath {
			return nil
		}
		name := strings.ToLower(d.Name())
		rel, err := filepath.Rel(rootPath, path)
		if err != nil {
			return err
		}
		matchQuery := query == "" || strings.Contains(name, query) || strings.Contains(strings.ToLower(rel), query)
		matchGlob := true
		if glob != "" {
			matchGlob, err = filepath.Match(glob, d.Name())
			if err != nil {
				return err
			}
		}
		if !matchQuery || !matchGlob {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		entry, err := buildListEntry(rootPath, path, info)
		if err != nil {
			return err
		}
		entries = append(entries, entry)
		return nil
	})
	if errors.Is(err, io.EOF) {
		err = nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entries": entries}, nil
}

func executeStat(cfg Config, args map[string]interface{}) (map[string]interface{}, error) {
	rootAlias := getStringArg(args, "rootAlias")
	relPath := getStringArg(args, "relPath")
	targetPath, rootPath, err := resolveAllowedPath(cfg, rootAlias, relPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(targetPath)
	if err != nil {
		return nil, err
	}
	entry, err := buildListEntry(rootPath, targetPath, info)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"entry": entry}, nil
}

func executeReadText(cfg Config, args map[string]interface{}) (map[string]interface{}, error) {
	rootAlias := getStringArg(args, "rootAlias")
	relPath := getStringArg(args, "relPath")
	targetPath, _, err := resolveAllowedPath(cfg, rootAlias, relPath)
	if err != nil {
		return nil, err
	}

	offset := getInt64Arg(args, "offset", 0)
	maxBytes := getInt64Arg(args, "maxBytes", cfg.Limits.MaxReadBytes)
	if maxBytes <= 0 || maxBytes > cfg.Limits.MaxReadBytes {
		maxBytes = cfg.Limits.MaxReadBytes
	}
	file, err := os.Open(targetPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}

	buffer := make([]byte, maxBytes)
	n, readErr := file.Read(buffer)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return nil, readErr
	}
	content := string(buffer[:n])
	return map[string]interface{}{
		"content":   content,
		"offset":    offset,
		"readBytes": n,
	}, nil
}

func executeStage(cfg Config, command *bridgeCommand) (map[string]interface{}, error) {
	rootAlias := getStringArg(command.Args, "rootAlias")
	relPath := getStringArg(command.Args, "relPath")
	targetPath, _, err := resolveAllowedPath(cfg, rootAlias, relPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(targetPath)
	if err != nil {
		return nil, err
	}
	if info.Size() > cfg.Limits.MaxStageBytes {
		return nil, fmt.Errorf("file exceeds maxStageBytes: %d", info.Size())
	}
	if !extensionAllowed(cfg, filepath.Ext(targetPath)) {
		return nil, fmt.Errorf("file extension is not allowed: %s", filepath.Ext(targetPath))
	}

	file, err := os.Open(targetPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	contentType := getStringArg(command.Args, "mimeType")
	if strings.TrimSpace(contentType) == "" {
		contentType = "application/octet-stream"
	}

	uploadPath := fmt.Sprintf("/api/local-bridge/devices/%s/commands/%s/upload", url.PathEscape(cfg.DeviceID), url.PathEscape(command.ID))
	if err := doDeviceUpload(cfg, uploadPath, contentType, file); err != nil {
		return nil, err
	}

	finalizePath := fmt.Sprintf("/api/local-bridge/devices/%s/commands/%s/upload/finalize", url.PathEscape(cfg.DeviceID), url.PathEscape(command.ID))
	var finalizeResp stageFinalizeResponse
	if err := doDeviceJSONRequest(http.MethodPost, cfg, finalizePath, map[string]interface{}{
		"sizeBytes": info.Size(),
	}, &finalizeResp); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"uploadedSizeBytes": info.Size(),
		"asset":             finalizeResp.Asset,
	}, nil
}

func executePack(cfg Config, command *bridgeCommand) (map[string]interface{}, error) {
	rootAlias := getStringArg(command.Args, "rootAlias")
	relPath := getStringArg(command.Args, "relPath")
	targetPath, _, err := resolveAllowedPath(cfg, rootAlias, relPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(targetPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("pack target is not a directory: %s", relPath)
	}

	var excludes []string
	if raw, ok := command.Args["exclude"]; ok {
		if arr, ok := raw.([]interface{}); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
					excludes = append(excludes, strings.TrimSpace(s))
				}
			}
		}
	}

	pr, pw := io.Pipe()

	var packErr error
	var fileCount int64
	var rawBytes int64

	go func() {
		gw := gzip.NewWriter(pw)
		tw := tar.NewWriter(gw)

		walkErr := filepath.WalkDir(targetPath, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // skip unreadable entries
			}
			rel, err := filepath.Rel(targetPath, path)
			if err != nil {
				return nil
			}
			relSlash := filepath.ToSlash(rel)

			for _, pattern := range excludes {
				if matched, _ := filepath.Match(pattern, relSlash); matched {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if matched, _ := filepath.Match(pattern, filepath.Base(relSlash)); matched {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
			}

			info, err := d.Info()
			if err != nil {
				return nil
			}

			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return nil
			}
			header.Name = relSlash
			if d.IsDir() {
				header.Name += "/"
			}

			if err := tw.WriteHeader(header); err != nil {
				return err
			}

			if !d.IsDir() && info.Mode().IsRegular() {
				f, err := os.Open(path)
				if err != nil {
					return nil // skip unreadable files
				}
				n, copyErr := io.Copy(tw, f)
				f.Close()
				if copyErr != nil {
					return copyErr
				}
				atomic.AddInt64(&fileCount, 1)
				atomic.AddInt64(&rawBytes, n)
			}
			return nil
		})

		tw.Close()
		gw.Close()
		if walkErr != nil {
			packErr = walkErr
		}
		pw.CloseWithError(walkErr)
	}()

	uploadPath := fmt.Sprintf("/api/local-bridge/devices/%s/commands/%s/upload", url.PathEscape(cfg.DeviceID), url.PathEscape(command.ID))
	if err := doDeviceUpload(cfg, uploadPath, "application/gzip", pr); err != nil {
		return nil, fmt.Errorf("pack upload failed: %w", err)
	}
	if packErr != nil {
		return nil, fmt.Errorf("pack archive failed: %w", packErr)
	}

	finalizePath := fmt.Sprintf("/api/local-bridge/devices/%s/commands/%s/upload/finalize", url.PathEscape(cfg.DeviceID), url.PathEscape(command.ID))
	var finalizeResp stageFinalizeResponse
	if err := doDeviceJSONRequest(http.MethodPost, cfg, finalizePath, map[string]interface{}{}, &finalizeResp); err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"packedFiles": atomic.LoadInt64(&fileCount),
		"packedBytes": atomic.LoadInt64(&rawBytes),
		"asset":       finalizeResp.Asset,
	}, nil
}

func doDeviceUpload(cfg Config, path string, contentType string, body io.Reader) error {
	req, err := http.NewRequest(http.MethodPut, cfg.ServerURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.DeviceToken)
	req.Header.Set("Content-Type", contentType)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

func resolveAllowedPath(cfg Config, rootAlias string, relPath string) (string, string, error) {
	rootPath, ok := cfg.AllowedRoots[rootAlias]
	if !ok || strings.TrimSpace(rootPath) == "" {
		return "", "", fmt.Errorf("unknown root alias: %s", rootAlias)
	}

	rootAbs, err := filepath.Abs(rootPath)
	if err != nil {
		return "", "", err
	}
	target := filepath.Join(rootAbs, filepath.Clean(relPath))
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return "", "", err
	}

	rootEval := rootAbs
	if resolved, err := filepath.EvalSymlinks(rootAbs); err == nil {
		rootEval = resolved
	}
	targetEval := targetAbs
	if resolved, err := filepath.EvalSymlinks(targetAbs); err == nil {
		targetEval = resolved
	}

	relCheck, err := filepath.Rel(rootEval, targetEval)
	if err != nil {
		return "", "", err
	}
	if relCheck == ".." || strings.HasPrefix(relCheck, ".."+string(filepath.Separator)) {
		return "", "", errors.New("path escapes allowed root")
	}
	return targetEval, rootEval, nil
}

func buildListEntry(rootPath, fullPath string, info os.FileInfo) (listEntry, error) {
	relPath, err := filepath.Rel(rootPath, fullPath)
	if err != nil {
		return listEntry{}, err
	}
	entry := listEntry{
		Name:       filepath.Base(fullPath),
		RelPath:    filepath.ToSlash(relPath),
		Kind:       "file",
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
	}
	if info.IsDir() {
		entry.Kind = "dir"
	} else {
		entry.Size = info.Size()
	}
	if entry.RelPath == "." {
		entry.RelPath = "."
	}
	return entry, nil
}

func getStringArg(args map[string]interface{}, key string) string {
	value, ok := args[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprintf("%v", typed))
	}
}

func getInt64Arg(args map[string]interface{}, key string, fallback int64) int64 {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case json.Number:
		n, err := typed.Int64()
		if err == nil {
			return n
		}
	case string:
		if typed == "" {
			return fallback
		}
		var n int64
		_, err := fmt.Sscan(typed, &n)
		if err == nil {
			return n
		}
	}
	return fallback
}

func extensionAllowed(cfg Config, ext string) bool {
	if len(cfg.Stage.AllowedExtensions) == 0 {
		return true
	}
	normalized := strings.ToLower(strings.TrimSpace(ext))
	for _, candidate := range cfg.Stage.AllowedExtensions {
		if normalized == strings.ToLower(strings.TrimSpace(candidate)) {
			return true
		}
	}
	return false
}

func mergeAllowedExtensions(defaults []string, existing []string) []string {
	merged := make([]string, 0, len(defaults)+len(existing))
	seen := map[string]bool{}
	appendUnique := func(values []string) {
		for _, value := range values {
			normalized := strings.ToLower(strings.TrimSpace(value))
			if normalized == "" || seen[normalized] {
				continue
			}
			seen[normalized] = true
			merged = append(merged, normalized)
		}
	}
	appendUnique(defaults)
	appendUnique(existing)
	return merged
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func helperReleaseManifestPath() string {
	return fmt.Sprintf("/api/local-bridge/helper/releases/latest?platform=%s&arch=%s", url.QueryEscape(runtime.GOOS), url.QueryEscape(runtime.GOARCH))
}

func resolveReleaseDownloadURL(cfg Config, manifest helperReleaseManifest) string {
	if strings.TrimSpace(manifest.Release.DownloadURL) != "" {
		return strings.TrimSpace(manifest.Release.DownloadURL)
	}
	if strings.TrimSpace(manifest.Release.DownloadPath) == "" {
		return ""
	}
	if strings.HasPrefix(manifest.Release.DownloadPath, "http://") || strings.HasPrefix(manifest.Release.DownloadPath, "https://") {
		return strings.TrimSpace(manifest.Release.DownloadPath)
	}
	return normalizeBaseURL(cfg.ServerURL) + manifest.Release.DownloadPath
}

func replaceFileAtomically(sourcePath, targetPath string) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		_ = os.Remove(targetPath)
	}
	return os.Rename(sourcePath, targetPath)
}

func maybeAutoUpdate(cfg Config) (bool, error) {
	managedPath, err := resolveManagedBinaryPath()
	if err != nil {
		return false, err
	}
	currentPath, err := os.Executable()
	if err != nil {
		return false, err
	}

	var manifest helperReleaseManifest
	if err := doReleaseJSONRequest(cfg, helperReleaseManifestPath(), &manifest); err != nil {
		return false, err
	}

	releaseHash := strings.TrimSpace(manifest.Release.Sha256)
	if releaseHash == "" {
		return false, errors.New("helper release manifest missing sha256")
	}
	currentHash, err := fileSHA256(currentPath)
	if err != nil {
		return false, err
	}
	if strings.EqualFold(currentHash, releaseHash) {
		return false, nil
	}

	downloadURL := resolveReleaseDownloadURL(cfg, manifest)
	if downloadURL == "" {
		return false, errors.New("helper release manifest missing download URL")
	}

	tempPath := managedPath + ".download"
	if err := doBinaryRequest(http.MethodGet, downloadURL, "", tempPath); err != nil {
		return false, err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tempPath, 0o755); err != nil {
			_ = os.Remove(tempPath)
			return false, err
		}
	}
	downloadHash, err := fileSHA256(tempPath)
	if err != nil {
		_ = os.Remove(tempPath)
		return false, err
	}
	if !strings.EqualFold(downloadHash, releaseHash) {
		_ = os.Remove(tempPath)
		return false, fmt.Errorf("downloaded helper checksum mismatch")
	}
	if err := replaceFileAtomically(tempPath, managedPath); err != nil {
		_ = os.Remove(tempPath)
		return false, err
	}
	fmt.Fprintf(os.Stderr, "updated helper to %s\n", strings.TrimSpace(manifest.Release.Version))

	if filepath.Clean(currentPath) != filepath.Clean(managedPath) {
		fmt.Fprintf(
			os.Stderr,
			"auto update installed managed helper at %s but current executable is %s; restart using the managed helper path to apply %s\n",
			managedPath,
			currentPath,
			strings.TrimSpace(manifest.Release.Version),
		)
		return false, nil
	}
	if runtime.GOOS == "windows" {
		return false, nil
	}
	if err := reexecHelperBinary(managedPath); err != nil {
		return false, err
	}
	return true, nil
}

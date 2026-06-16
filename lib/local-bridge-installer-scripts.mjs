function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/+$/, '');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function powershellSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

function buildDownloadPath({ token, platform, format }) {
  const params = new URLSearchParams();
  params.set('bootstrapToken', trimString(token));
  params.set('platform', trimString(platform));
  params.set('format', trimString(format));
  return `/api/local-bridge/bootstrap/installers/download?${params.toString()}`;
}

function buildDownloadUrl(baseUrl, options) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const path = buildDownloadPath(options);
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

function buildMacScript(baseUrl, token) {
  return `#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${shellQuote(baseUrl)}
BOOTSTRAP_TOKEN=${shellQuote(token)}
HELPER_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/RemoteLabHelper/bin"
HELPER_PATH="$HELPER_DIR/remotelab-helper"
STATE_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/RemoteLabHelper"
LOG_FILE="$STATE_DIR/helper.log"

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "amd64" ;;
    *)
      echo "Unsupported macOS architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

download_helper() {
  local url="$1"
  local target="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
    return
  fi
  echo "curl or wget is required to install RemoteLab Helper." >&2
  exit 1
}

ARCH="$(detect_arch)"
DOWNLOAD_URL="$BASE_URL/api/local-bridge/helper/releases/download?platform=darwin&arch=$ARCH"

mkdir -p "$HELPER_DIR" "$STATE_DIR"
TMP_PATH="$(mktemp "$HELPER_DIR/remotelab-helper.XXXXXX")"
trap 'rm -f "$TMP_PATH"' EXIT
download_helper "$DOWNLOAD_URL" "$TMP_PATH"
chmod +x "$TMP_PATH"
mv "$TMP_PATH" "$HELPER_PATH"
trap - EXIT

ROOT_ARGS=()
add_root_if_present() {
  local alias="$1"
  local path="$2"
  if [ -d "$path" ]; then
    ROOT_ARGS+=(--root "$alias=$path")
  fi
}

add_root_if_present desktop "$HOME/Desktop"
add_root_if_present documents "$HOME/Documents"
add_root_if_present downloads "$HOME/Downloads"

if [ "\${#ROOT_ARGS[@]}" -eq 0 ]; then
  ROOT_ARGS+=(--root "home=$HOME")
fi

nohup "$HELPER_PATH" run --server "$BASE_URL" --token "$BOOTSTRAP_TOKEN" "\${ROOT_ARGS[@]}" >>"$LOG_FILE" 2>&1 &

echo
echo "RemoteLab Helper started in the background."
echo "Log file: $LOG_FILE"
echo "You can close this window."
read -r -p "Press Enter to finish..."
`;
}

function buildLinuxScript(baseUrl, token) {
  return `#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${shellQuote(baseUrl)}
BOOTSTRAP_TOKEN=${shellQuote(token)}
HELPER_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/RemoteLabHelper/bin"
HELPER_PATH="$HELPER_DIR/remotelab-helper"
STATE_DIR="\${XDG_STATE_HOME:-$HOME/.local/state}/RemoteLabHelper"
LOG_FILE="$STATE_DIR/helper.log"

detect_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "amd64" ;;
    *)
      echo "Unsupported Linux architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

download_helper() {
  local url="$1"
  local target="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
    return
  fi
  echo "curl or wget is required to install RemoteLab Helper." >&2
  exit 1
}

ARCH="$(detect_arch)"
DOWNLOAD_URL="$BASE_URL/api/local-bridge/helper/releases/download?platform=linux&arch=$ARCH"

mkdir -p "$HELPER_DIR" "$STATE_DIR"
TMP_PATH="$(mktemp "$HELPER_DIR/remotelab-helper.XXXXXX")"
trap 'rm -f "$TMP_PATH"' EXIT
download_helper "$DOWNLOAD_URL" "$TMP_PATH"
chmod +x "$TMP_PATH"
mv "$TMP_PATH" "$HELPER_PATH"
trap - EXIT

ROOT_ARGS=()
add_root_if_present() {
  local alias="$1"
  local path="$2"
  if [ -d "$path" ]; then
    ROOT_ARGS+=(--root "$alias=$path")
  fi
}

add_root_if_present desktop "$HOME/Desktop"
add_root_if_present documents "$HOME/Documents"
add_root_if_present downloads "$HOME/Downloads"

if [ "\${#ROOT_ARGS[@]}" -eq 0 ]; then
  ROOT_ARGS+=(--root "home=$HOME")
fi

nohup "$HELPER_PATH" run --server "$BASE_URL" --token "$BOOTSTRAP_TOKEN" "\${ROOT_ARGS[@]}" >>"$LOG_FILE" 2>&1 &

echo "RemoteLab Helper started in the background."
echo "Log file: $LOG_FILE"
`;
}

function buildWindowsCmdScript(baseUrl, token) {
  return `@echo off
setlocal

set "BASE_URL=${baseUrl.replace(/"/g, '""')}"
set "BOOTSTRAP_TOKEN=${token.replace(/"/g, '""')}"
set "HELPER_DIR=%APPDATA%\\RemoteLabHelper\\bin"
set "HELPER_PATH=%HELPER_DIR%\\remotelab-helper.exe"

if not exist "%HELPER_DIR%" mkdir "%HELPER_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "Invoke-WebRequest -UseBasicParsing '%BASE_URL%/api/local-bridge/helper/releases/download?platform=windows&arch=amd64' -OutFile '%HELPER_PATH%';" ^
  "$roots = @();" ^
  "if (Test-Path \"$env:USERPROFILE\\Desktop\")   { $roots += @('--root', \"desktop=$env:USERPROFILE\\Desktop\") };" ^
  "if (Test-Path \"$env:USERPROFILE\\Documents\") { $roots += @('--root', \"documents=$env:USERPROFILE\\Documents\") };" ^
  "if (Test-Path \"$env:USERPROFILE\\Downloads\") { $roots += @('--root', \"downloads=$env:USERPROFILE\\Downloads\") };" ^
  "if ($roots.Count -eq 0) { $roots += @('--root', \"home=$env:USERPROFILE\") };" ^
  "Start-Process -FilePath '%HELPER_PATH%' -ArgumentList @('run','--server','%BASE_URL%','--token','%BOOTSTRAP_TOKEN%') + $roots;"

if errorlevel 1 (
  echo Failed to install or start RemoteLab Helper.
  pause
  exit /b 1
)

echo RemoteLab Helper started.
pause
`;
}

function buildWindowsPs1Script(baseUrl, token) {
  const quotedBaseUrl = powershellSingleQuote(baseUrl);
  const quotedToken = powershellSingleQuote(token);
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$baseUrl = '${quotedBaseUrl}'
$bootstrapToken = '${quotedToken}'
$helperDir = Join-Path $env:APPDATA 'RemoteLabHelper\\bin'
$helperPath = Join-Path $helperDir 'remotelab-helper.exe'

New-Item -ItemType Directory -Force -Path $helperDir | Out-Null
Invoke-WebRequest -UseBasicParsing "$baseUrl/api/local-bridge/helper/releases/download?platform=windows&arch=amd64" -OutFile $helperPath

$roots = @()
if (Test-Path "$env:USERPROFILE\\Desktop")   { $roots += @('--root', "desktop=$env:USERPROFILE\\Desktop") }
if (Test-Path "$env:USERPROFILE\\Documents") { $roots += @('--root', "documents=$env:USERPROFILE\\Documents") }
if (Test-Path "$env:USERPROFILE\\Downloads") { $roots += @('--root', "downloads=$env:USERPROFILE\\Downloads") }
if ($roots.Count -eq 0) { $roots += @('--root', "home=$env:USERPROFILE") }

Start-Process -FilePath $helperPath -ArgumentList @('run','--server',$baseUrl,'--token',$bootstrapToken) + $roots
Write-Host 'RemoteLab Helper started.'
`;
}

export function buildLocalBridgeBootstrapInstaller(options = {}) {
  const token = trimString(options.token);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const platform = trimString(options.platform).toLowerCase();
  const format = trimString(options.format).toLowerCase();

  if (!token) {
    throw new Error('bootstrap token is required');
  }
  if (!baseUrl) {
    throw new Error('baseUrl is required');
  }

  if (platform === 'darwin' && format === 'command') {
    return {
      filename: 'Install-RemoteLab-Helper.command',
      contentType: 'text/plain; charset=utf-8',
      body: buildMacScript(baseUrl, token),
    };
  }
  if (platform === 'linux' && format === 'sh') {
    return {
      filename: 'install-remotelab-helper.sh',
      contentType: 'text/x-shellscript; charset=utf-8',
      body: buildLinuxScript(baseUrl, token),
    };
  }
  if (platform === 'windows' && format === 'cmd') {
    return {
      filename: 'Install-RemoteLab-Helper.cmd',
      contentType: 'text/plain; charset=utf-8',
      body: buildWindowsCmdScript(baseUrl, token),
    };
  }
  if (platform === 'windows' && format === 'ps1') {
    return {
      filename: 'Install-RemoteLab-Helper.ps1',
      contentType: 'text/plain; charset=utf-8',
      body: buildWindowsPs1Script(baseUrl, token),
    };
  }

  throw new Error(`Unsupported installer target: ${platform}/${format}`);
}

export function buildLocalBridgeBootstrapInstallers(baseUrl, token) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedToken = trimString(token);
  return {
    mac: {
      label: 'macOS',
      downloadUrl: buildDownloadUrl(normalizedBaseUrl, {
        token: normalizedToken,
        platform: 'darwin',
        format: 'command',
      }),
    },
    linux: {
      label: 'Linux',
      downloadUrl: buildDownloadUrl(normalizedBaseUrl, {
        token: normalizedToken,
        platform: 'linux',
        format: 'sh',
      }),
    },
    windows: {
      label: 'Windows',
      downloadUrl: buildDownloadUrl(normalizedBaseUrl, {
        token: normalizedToken,
        platform: 'windows',
        format: 'cmd',
      }),
      powershellUrl: buildDownloadUrl(normalizedBaseUrl, {
        token: normalizedToken,
        platform: 'windows',
        format: 'ps1',
      }),
    },
  };
}

export function buildLocalBridgeBootstrapCommandHints(baseUrl, token) {
  const installers = buildLocalBridgeBootstrapInstallers(baseUrl, token);
  const macUrl = installers.mac.downloadUrl;
  const linuxUrl = installers.linux.downloadUrl;
  const windowsCmdUrl = installers.windows.downloadUrl;
  const windowsPs1Url = installers.windows.powershellUrl;
  return {
    mac: `bash <(curl -fsSL ${shellQuote(macUrl)})`,
    linux: `bash <(curl -fsSL ${shellQuote(linuxUrl)})`,
    windows_cmd: `powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing '${powershellSingleQuote(windowsCmdUrl)}' -OutFile $env:TEMP\\Install-RemoteLab-Helper.cmd; & $env:TEMP\\Install-RemoteLab-Helper.cmd"`,
    windows_powershell: `irm '${powershellSingleQuote(windowsPs1Url)}' | iex`,
  };
}

export function buildLocalBridgeBootstrapInstallBundle(baseUrl, token) {
  return {
    installers: buildLocalBridgeBootstrapInstallers(baseUrl, token),
    commands: buildLocalBridgeBootstrapCommandHints(baseUrl, token),
  };
}

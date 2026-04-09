#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFile } from 'child_process';

import { PUBLIC_BASE_URL } from '../lib/config.mjs';
import { createSessionLocalBridgeBootstrap } from '../chat/local-bridge-session.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const execFileAsync = promisify(execFile);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/build-local-helper-bundle.mjs --session <session-id> [options]

Options:
  --session <id>           Required RemoteLab session id
  --server-url <url>       Public base URL to embed into bootstrap
  --output <path>          Output zip path (default: /tmp/remotelab-helper-mac-<session>.zip)
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const options = {
    sessionId: '',
    serverUrl: '',
    outputPath: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--session':
        options.sessionId = trimString(argv[i + 1]);
        i += 1;
        break;
      case '--server-url':
        options.serverUrl = trimString(argv[i + 1]);
        i += 1;
        break;
      case '--output':
        options.outputPath = trimString(argv[i + 1]);
        i += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function resolveDefaultServerUrl() {
  if (trimString(PUBLIC_BASE_URL)) return trimString(PUBLIC_BASE_URL);
  try {
    const config = await readFile('/etc/cloudflared/config.yml', 'utf8');
    const match = config.match(/-\s+hostname:\s*([^\s]+)\s*\n\s*service:\s*http:\/\/127\.0\.0\.1:7690\b/);
    if (match?.[1]) return `https://${match[1]}`;
  } catch {}
  return '';
}

function buildStarterScript() {
  return `#!/bin/bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/Library/Application Support/RemoteLabHelper"
LOG_DIR="$HOME/Library/Logs/RemoteLabHelper"
PID_FILE="$CONFIG_DIR/helper.pid"
BOOTSTRAP_SRC="$SELF_DIR/bootstrap.json"
BIN_DIR="$CONFIG_DIR/bin"
mkdir -p "$CONFIG_DIR" "$LOG_DIR"
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    osascript -e 'display notification "RemoteLab Helper is already running." with title "RemoteLab Helper"' >/dev/null 2>&1 || true
    exit 0
  fi
fi
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) BUNDLE_BIN="$SELF_DIR/remotelab-helper-darwin-arm64"; MANAGED_BIN="$BIN_DIR/remotelab-helper-darwin-arm64" ;;
  x86_64) BUNDLE_BIN="$SELF_DIR/remotelab-helper-darwin-amd64"; MANAGED_BIN="$BIN_DIR/remotelab-helper-darwin-amd64" ;;
  *) echo "Unsupported Mac architecture: $ARCH"; exit 1 ;;
esac
mkdir -p "$BIN_DIR"
chmod +x "$BUNDLE_BIN"
if [[ ! -f "$MANAGED_BIN" ]]; then
  cp -f "$BUNDLE_BIN" "$MANAGED_BIN"
  chmod +x "$MANAGED_BIN"
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$MANAGED_BIN" >/dev/null 2>&1 || true
  fi
fi
if [[ ! -f "$CONFIG_DIR/config.json" ]] && [[ -f "$BOOTSTRAP_SRC" ]]; then
  cp "$BOOTSTRAP_SRC" "$CONFIG_DIR/bootstrap.json"
fi
nohup "$MANAGED_BIN" run >> "$LOG_DIR/helper.log" 2>&1 &
echo $! > "$PID_FILE"
osascript -e 'display notification "RemoteLab Helper started. Return to RemoteLab and continue in the same session." with title "RemoteLab Helper"' >/dev/null 2>&1 || true
exit 0
`;
}

function buildStopScript() {
  return `#!/bin/bash
set -euo pipefail
CONFIG_DIR="$HOME/Library/Application Support/RemoteLabHelper"
PID_FILE="$CONFIG_DIR/helper.pid"
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" || true
  fi
  rm -f "$PID_FILE"
fi
osascript -e 'display notification "RemoteLab Helper stopped." with title "RemoteLab Helper"' >/dev/null 2>&1 || true
exit 0
`;
}

function buildReadme(serverUrl) {
  return `RemoteLab Helper Mac bundle

Bundled server URL:
${serverUrl}

Recommended:
1. Unzip this folder on your Mac.
2. Double-click "Start RemoteLab Helper.command".
3. If macOS blocks it the first time, right-click it and choose Open once.
4. Return to the same RemoteLab session and continue there.

What happens after the first launch:
- The starter installs the helper binary into your user config directory.
- Future launches keep using the managed copy instead of the download folder.
- The helper can later fetch newer binaries from RemoteLab without asking you to re-download the app manually.

To stop the helper later, run "Stop RemoteLab Helper.command".
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.sessionId) {
    throw new Error('--session is required');
  }

  const serverUrl = trimString(options.serverUrl) || await resolveDefaultServerUrl();
  if (!serverUrl) {
    throw new Error('No public server URL available. Pass --server-url explicitly.');
  }

  const bootstrap = await createSessionLocalBridgeBootstrap(options.sessionId);
  const bundleDir = resolve('/tmp', `remotelab-helper-mac-${options.sessionId}`);
  const outputPath = resolve(options.outputPath || join('/tmp', `${basename(bundleDir)}.zip`));
  const localHelperDir = join(repoRoot, 'local-helper');

  await rm(bundleDir, { recursive: true, force: true });
  await rm(outputPath, { force: true });
  await mkdir(bundleDir, { recursive: true });

  await execFileAsync('go', ['build', '-o', join(bundleDir, 'remotelab-helper-darwin-arm64'), './cmd/remotelab-helper'], {
    cwd: localHelperDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64' },
  });
  await execFileAsync('go', ['build', '-o', join(bundleDir, 'remotelab-helper-darwin-amd64'), './cmd/remotelab-helper'], {
    cwd: localHelperDir,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'amd64' },
  });

  await writeFile(join(bundleDir, 'bootstrap.json'), JSON.stringify({
    serverUrl,
    token: bootstrap.token,
  }, null, 2), 'utf8');
  await writeFile(join(bundleDir, 'Start RemoteLab Helper.command'), buildStarterScript(), 'utf8');
  await writeFile(join(bundleDir, 'Stop RemoteLab Helper.command'), buildStopScript(), 'utf8');
  await writeFile(join(bundleDir, 'README.txt'), buildReadme(serverUrl), 'utf8');
  await chmod(join(bundleDir, 'Start RemoteLab Helper.command'), 0o755);
  await chmod(join(bundleDir, 'Stop RemoteLab Helper.command'), 0o755);

  await execFileAsync('zip', ['-qry', outputPath, basename(bundleDir)], {
    cwd: dirname(bundleDir),
    env: process.env,
  });

  process.stdout.write(`${JSON.stringify({
    bundleDir,
    outputPath,
    serverUrl,
    bootstrap,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});

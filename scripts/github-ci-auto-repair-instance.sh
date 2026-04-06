#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ACTION="${1:-install}"
LABEL="com.remotelab.github-ci-auto-repair"
CONFIG_DIR="$HOME/.config/remotelab/github-ci-auto-repair"
CONFIG_PATH="$CONFIG_DIR/config.json"
LAST_RUN_PATH="$CONFIG_DIR/last-run.json"
LOG_PATH="$CONFIG_DIR/monitor.log"
ERROR_LOG_PATH="$CONFIG_DIR/monitor.error.log"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
GH_BIN="${GH_BIN:-$(command -v gh)}"

mkdir -p "$CONFIG_DIR" "$HOME/Library/LaunchAgents"

ensure_default_config() {
  if [[ -f "$CONFIG_PATH" ]]; then
    return 0
  fi

  cat > "$CONFIG_PATH" <<EOF
{
  "enabled": true,
  "repo": "Ninglo/remotelab",
  "branches": ["main", "master"],
  "events": ["push"],
  "workflows": ["CI"],
  "chatBaseUrl": "http://127.0.0.1:7690",
  "sessionFolder": "$ROOT_DIR",
  "sessionTool": "codex",
  "thinking": false,
  "bootstrapHours": 24,
  "limit": 20,
  "settleMinutes": 5,
  "maxLogLines": 120,
  "maxLogChars": 12000,
  "intervalSeconds": 300,
  "ghBin": "$GH_BIN"
}
EOF
  echo "created default config: $CONFIG_PATH"
}

config_number() {
  local key="$1"
  local fallback="$2"
  "$NODE_BIN" - <<'EOF' "$CONFIG_PATH" "$key" "$fallback"
const fs = require('fs/promises');
const [configPath, key, fallback] = process.argv.slice(2);
(async () => {
  try {
    const value = JSON.parse(await fs.readFile(configPath, 'utf8'))?.[key];
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      process.stdout.write(String(parsed));
      process.exit(0);
    }
  } catch {}
  process.stdout.write(String(fallback));
})().catch(() => {
  process.stdout.write(String(fallback));
});
EOF
}

agent_loaded() {
  launchctl list 2>/dev/null | grep -q "$LABEL"
}

render_plist() {
  local interval
  interval="$(config_number intervalSeconds 300)"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$ROOT_DIR/scripts/github-ci-auto-repair-runner.mjs</string>
        <string>--config</string>
        <string>$CONFIG_PATH</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH</string>
        <key>GH_BIN</key>
        <string>$GH_BIN</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>$interval</integer>
    <key>WorkingDirectory</key>
    <string>$ROOT_DIR</string>
    <key>StandardOutPath</key>
    <string>$LOG_PATH</string>
    <key>StandardErrorPath</key>
    <string>$ERROR_LOG_PATH</string>
</dict>
</plist>
EOF
}

load_agent() {
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
}

unload_agent() {
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
}

show_status() {
  if agent_loaded; then
    local info pid exit_code
    info="$(launchctl list 2>/dev/null | grep "$LABEL" || true)"
    pid="$(echo "$info" | awk '{print $1}')"
    exit_code="$(echo "$info" | awk '{print $2}')"
    echo "$LABEL is loaded"
    if [[ -n "$pid" && "$pid" != "-" ]]; then
      echo "pid: $pid"
    else
      echo "pid: not running (scheduled)"
    fi
    if [[ -n "$exit_code" ]]; then
      echo "last exit: $exit_code"
    fi
  else
    echo "$LABEL is not loaded"
  fi

  echo "plist: $PLIST_PATH"
  echo "config: $CONFIG_PATH"
  echo "stdout log: $LOG_PATH"
  echo "stderr log: $ERROR_LOG_PATH"

  if [[ -f "$LAST_RUN_PATH" ]]; then
    echo "last run summary:"
    "$NODE_BIN" - <<'EOF' "$LAST_RUN_PATH"
const fs = require('fs/promises');
const path = process.argv[2];
(async () => {
  const data = JSON.parse(await fs.readFile(path, 'utf8'));
  const compact = {
    status: data.status,
    finishedAt: data.finishedAt,
    triggered: Array.isArray(data.monitor?.triggered) ? data.monitor.triggered.length : undefined,
    skipped: Array.isArray(data.monitor?.skipped) ? data.monitor.skipped.length : undefined,
    repo: data.monitor?.repo,
  };
  process.stdout.write(`${JSON.stringify(compact, null, 2)}\n`);
})().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
EOF
  fi
}

show_logs() {
  tail -n 80 "$LOG_PATH" "$ERROR_LOG_PATH" 2>/dev/null || true
}

run_now() {
  "$NODE_BIN" "$ROOT_DIR/scripts/github-ci-auto-repair-runner.mjs" --config "$CONFIG_PATH"
}

sync_agent() {
  ensure_default_config
  render_plist
  if agent_loaded; then
    load_agent
  fi
  echo "synced launch agent: $PLIST_PATH"
}

case "$ACTION" in
  install|start)
    ensure_default_config
    render_plist
    load_agent
    echo "installed and loaded $LABEL"
    echo "config: $CONFIG_PATH"
    ;;
  stop)
    unload_agent
    echo "stopped $LABEL"
    ;;
  restart)
    ensure_default_config
    render_plist
    load_agent
    echo "restarted $LABEL"
    ;;
  uninstall)
    unload_agent
    rm -f "$PLIST_PATH"
    echo "uninstalled $LABEL"
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  run-now)
    ensure_default_config
    run_now
    ;;
  sync)
    sync_agent
    ;;
  *)
    echo "usage: $0 {install|start|stop|restart|uninstall|status|logs|run-now|sync}" >&2
    exit 1
    ;;
esac

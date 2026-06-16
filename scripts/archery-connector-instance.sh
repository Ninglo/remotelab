#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ACTION="${1:-start}"
CONFIG_DIR="${REMOTELAB_CONFIG_DIR:-$HOME/.config/remotelab}/archery-connector"
CONFIG_PATH="$CONFIG_DIR/config.json"
PID_FILE="$CONFIG_DIR/connector.pid"
LOG_PATH="$CONFIG_DIR/connector.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SURFACE_PATH="${REMOTELAB_CONFIG_DIR:-$HOME/.config/remotelab}/connector-surfaces/archery.json"

mkdir -p "$CONFIG_DIR"

write_default_config() {
  if [[ -f "$CONFIG_PATH" ]]; then
    return 0
  fi

  cat > "$CONFIG_PATH" <<EOF
{
  "port": 7796,
  "host": "127.0.0.1",
  "deliveryMode": "direct",
  "threadMode": "athlete",
  "tool": "codex",
  "sessionTool": "codex",
  "sourceName": "Archery",
  "group": "Training",
  "chatBaseUrl": "http://127.0.0.1:7690",
  "authTokenFile": "$HOME/.config/remotelab/auth.json",
  "sessionFolder": "$HOME/.remotelab/workspace",
  "replyPollTimeoutMs": 600000,
  "replyPollIntervalMs": 1500,
  "ingestToken": ""
}
EOF
}

running_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    return 1
  fi

  if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -q 'connectors/archery/index.mjs'; then
    printf '%s\n' "$pid"
    return 0
  fi

  rm -f "$PID_FILE"
  return 1
}

configured_port() {
  write_default_config
  "$NODE_BIN" -e "const fs=require('fs'); const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(Number(raw.port)||7796)" "$CONFIG_PATH"
}

listener_pid() {
  local port line pid
  port="$(configured_port)"
  line="$(ss -ltnp 2>/dev/null | awk -v port=":${port}" '$4 ~ (port "$") { print; exit }')"
  if [[ -z "$line" ]]; then
    return 1
  fi
  pid="$(printf '%s\n' "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if ! ps -p "$pid" -o command= 2>/dev/null | grep -q 'connectors/archery/index.mjs'; then
    return 1
  fi
  printf '%s\n' "$pid"
}

start_instance() {
  local pid
  if pid="$(running_pid)" || pid="$(listener_pid)"; then
    printf '%s\n' "$pid" > "$PID_FILE"
    echo "archery connector already running (pid $pid)"
    echo "config: $CONFIG_PATH"
    echo "log: $LOG_PATH"
    return 0
  fi

  write_default_config
  printf '\n=== start %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_PATH"

  (
    cd "$ROOT_DIR"
    nohup setsid env \
      PATH="$PATH" \
      HOME="$HOME" \
      USER="${USER:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      "$NODE_BIN" connectors/archery/index.mjs --state-dir "$CONFIG_DIR" >> "$LOG_PATH" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$PID_FILE"
  )

  for _ in $(seq 1 40); do
    if pid="$(listener_pid)" || pid="$(running_pid)"; then
      printf '%s\n' "$pid" > "$PID_FILE"
      echo "started archery connector (pid $pid)"
      echo "config: $CONFIG_PATH"
      echo "log: $LOG_PATH"
      return 0
    fi
    sleep 0.25
  done

  echo "failed to start archery connector" >&2
  tail -n 80 "$LOG_PATH" >&2 || true
  exit 1
}

stop_instance() {
  local pid
  if ! pid="$(running_pid)" && ! pid="$(listener_pid)"; then
    rm -f "$PID_FILE"
    echo "archery connector is already stopped"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      rm -f "$SURFACE_PATH"
      echo "stopped archery connector (pid $pid)"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  rm -f "$SURFACE_PATH"
  echo "force-stopped archery connector (pid $pid)"
}

show_status() {
  local pid
  if ! pid="$(running_pid)" && ! pid="$(listener_pid)"; then
    echo "archery connector is not running"
    echo "config: $CONFIG_PATH"
    echo "log: $LOG_PATH"
    return 1
  fi

  printf '%s\n' "$pid" > "$PID_FILE"

  echo "archery connector is running"
  echo "pid: $pid"
  echo "config: $CONFIG_PATH"
  echo "log: $LOG_PATH"
  ps -p "$pid" -o pid=,ppid=,user=,lstart=,command=
}

show_logs() {
  tail -n 80 "$LOG_PATH"
}

case "$ACTION" in
  start)
    start_instance
    ;;
  stop)
    stop_instance
    ;;
  restart)
    stop_instance
    start_instance
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac

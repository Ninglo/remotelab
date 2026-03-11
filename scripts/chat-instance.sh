#!/bin/bash
set -euo pipefail

ACTION="${1:-}"
shift || true

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/remotelab"

if [[ "$(uname)" == "Darwin" ]]; then
  DEFAULT_LOG_DIR="$HOME/Library/Logs"
else
  DEFAULT_LOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/remotelab/logs"
fi

PORT=""
NAME=""
LOG_PATH=""
NODE_BIN="${NODE_BIN:-$(command -v node)}"

usage() {
  cat <<'EOF'
Usage:
  scripts/chat-instance.sh <start|stop|restart|status|logs> [options]

Options:
  --port <port>    Chat server port (required)
  --name <name>    Optional label used for pid/log filenames
  --log <path>     Explicit log path override
  --node <path>    Explicit node binary override

Examples:
  scripts/chat-instance.sh restart --port 7695 --name scratch
  scripts/chat-instance.sh status --port 7695
  scripts/chat-instance.sh logs --port 7695

Notes:
  - This is for optional ad-hoc chat-server instances started manually on arbitrary ports.
  - Production service management still uses launchd/systemd via `remotelab restart chat`.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    --name)
      NAME="$2"
      shift 2
      ;;
    --log)
      LOG_PATH="$2"
      shift 2
      ;;
    --node)
      NODE_BIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  usage >&2
  exit 1
fi

if [[ -z "$PORT" ]]; then
  echo "Missing required argument: --port <port>" >&2
  usage >&2
  exit 1
fi

INSTANCE_TAG="${NAME:-$PORT}"
LOG_PATH="${LOG_PATH:-$DEFAULT_LOG_DIR/chat-server-${INSTANCE_TAG}.log}"
PID_FILE="$CONFIG_DIR/chat-server-${INSTANCE_TAG}.pid"

mkdir -p "$CONFIG_DIR" "$(dirname "$LOG_PATH")"

listener_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

wait_for_bind() {
  for _ in $(seq 1 40); do
    local pid
    pid="$(listener_pid)"
    if [[ -n "$pid" ]]; then
      echo "$pid"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

stop_instance() {
  local pid
  pid="$(listener_pid)"
  if [[ -z "$pid" ]]; then
    rm -f "$PID_FILE"
    echo "chat-server on :$PORT is already stopped"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped :$PORT (pid $pid)"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "force-stopped :$PORT (pid $pid)"
}

start_instance() {
  local pid
  pid="$(listener_pid)"
  if [[ -n "$pid" ]]; then
    echo "chat-server already listening on :$PORT (pid $pid)"
    echo "log: $LOG_PATH"
    return 0
  fi

  printf '\n=== start %s (port %s) ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$PORT" >> "$LOG_PATH"

  (
    cd "$ROOT_DIR"
    nohup env \
      CHAT_PORT="$PORT" \
      PATH="$PATH" \
      HOME="$HOME" \
      USER="${USER:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}" \
      TMPDIR="${TMPDIR:-/tmp}" \
      "$NODE_BIN" chat-server.mjs >> "$LOG_PATH" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )

  pid="$(wait_for_bind)" || {
    echo "failed to start chat-server on :$PORT" >&2
    tail -n 40 "$LOG_PATH" >&2 || true
    exit 1
  }

  echo "started :$PORT (pid $pid)"
  echo "log: $LOG_PATH"
}

show_status() {
  local pid
  pid="$(listener_pid)"
  if [[ -z "$pid" ]]; then
    echo "chat-server on :$PORT is not running"
    echo "log: $LOG_PATH"
    return 1
  fi

  echo "chat-server listening on :$PORT"
  echo "pid: $pid"
  echo "log: $LOG_PATH"
  ps -p "$pid" -o pid=,ppid=,user=,lstart=,command=
}

show_logs() {
  tail -n 60 "$LOG_PATH"
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
    echo "Unknown action: $ACTION" >&2
    usage >&2
    exit 1
    ;;
esac

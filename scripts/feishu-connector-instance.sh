#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ACTION="${1:-start}"
CONFIG_DIR="$HOME/.config/remotelab/feishu-connector"
PID_FILE="$CONFIG_DIR/connector.pid"
LOG_PATH="$CONFIG_DIR/connector.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

mkdir -p "$CONFIG_DIR"

running_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    return 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
    return 0
  fi

  rm -f "$PID_FILE"
  return 1
}

wait_for_ready() {
  local pid
  pid="$1"
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if [[ -f "$LOG_PATH" ]] && grep -q 'persistent connection ready' "$LOG_PATH"; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_instance() {
  local pid
  if pid="$(running_pid)"; then
    echo "feishu connector already running (pid $pid)"
    echo "log: $LOG_PATH"
    return 0
  fi

  printf '\n=== start %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_PATH"

  (
    cd "$ROOT_DIR"
    nohup env \
      PATH="$PATH" \
      HOME="$HOME" \
      USER="${USER:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      "$NODE_BIN" scripts/feishu-connector.mjs >> "$LOG_PATH" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )

  pid="$(cat "$PID_FILE")"
  if ! wait_for_ready "$pid"; then
    echo "failed to start feishu connector" >&2
    tail -n 80 "$LOG_PATH" >&2 || true
    exit 1
  fi

  echo "started feishu connector (pid $pid)"
  echo "log: $LOG_PATH"
}

stop_instance() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    echo "feishu connector is already stopped"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped feishu connector (pid $pid)"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "force-stopped feishu connector (pid $pid)"
}

show_status() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "feishu connector is not running"
    echo "log: $LOG_PATH"
    return 1
  fi

  echo "feishu connector is running"
  echo "pid: $pid"
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

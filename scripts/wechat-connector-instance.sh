#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ACTION="${1:-start}"

resolve_home_dir() {
  if [[ -n "${HOME:-}" ]]; then
    printf '%s\n' "$HOME"
    return 0
  fi

  local passwd_entry passwd_home
  passwd_entry="$(getent passwd "$(id -u)" 2>/dev/null || true)"
  passwd_home="$(printf '%s' "$passwd_entry" | cut -d: -f6)"
  if [[ -n "$passwd_home" ]]; then
    printf '%s\n' "$passwd_home"
    return 0
  fi

  printf '/root\n'
}

resolve_remotelab_config_root() {
  if [[ -n "${REMOTELAB_CONFIG_DIR:-}" ]]; then
    printf '%s\n' "$REMOTELAB_CONFIG_DIR"
    return 0
  fi
  if [[ -n "${REMOTELAB_INSTANCE_ROOT:-}" ]]; then
    printf '%s\n' "$REMOTELAB_INSTANCE_ROOT/config"
    return 0
  fi
  printf '%s\n' "$RUNTIME_HOME/.config/remotelab"
}

RUNTIME_HOME="$(resolve_home_dir)"
CONFIG_ROOT="$(resolve_remotelab_config_root)"
CONFIG_DIR="$CONFIG_ROOT/wechat-connector"
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
  local starter_pid log_offset tail_offset pid
  starter_pid="$1"
  log_offset="${2:-0}"
  tail_offset=$((log_offset + 1))
  for _ in $(seq 1 40); do
    if pid="$(running_pid)"; then
      if [[ -f "$LOG_PATH" ]] && tail -c +"$tail_offset" "$LOG_PATH" 2>/dev/null | grep -q 'poller ready'; then
        printf '%s\n' "$pid"
        return 0
      fi
    fi
    if ! kill -0 "$starter_pid" 2>/dev/null && ! running_pid >/dev/null 2>&1; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

start_instance() {
  local pid starter_pid ready_pid log_offset
  if pid="$(running_pid)"; then
    echo "wechat connector already running (pid $pid)"
    echo "log: $LOG_PATH"
    return 0
  fi

  log_offset=0
  if [[ -f "$LOG_PATH" ]]; then
    log_offset="$(wc -c < "$LOG_PATH" 2>/dev/null || printf '0')"
  fi
  printf '\n=== start %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_PATH"

  starter_pid="$(
    cd "$ROOT_DIR"
    setsid env \
      PATH="$PATH" \
      HOME="$RUNTIME_HOME" \
      USER="${USER:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      "$NODE_BIN" scripts/wechat-connector.mjs >> "$LOG_PATH" 2>&1 < /dev/null &
    echo $!
  )"
  if ! ready_pid="$(wait_for_ready "$starter_pid" "$log_offset")"; then
    echo "failed to start wechat connector" >&2
    tail -n 80 "$LOG_PATH" >&2 || true
    exit 1
  fi

  echo "started wechat connector (pid $ready_pid)"
  echo "log: $LOG_PATH"
}

stop_instance() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    echo "wechat connector is already stopped"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped wechat connector (pid $pid)"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "force-stopped wechat connector (pid $pid)"
}

show_status() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "wechat connector is not running"
    echo "log: $LOG_PATH"
    return 1
  fi

  echo "wechat connector is running"
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

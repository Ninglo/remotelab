#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ACTION="${1:-start}"
if [[ $# -gt 0 ]]; then
  shift
fi
NODE_BIN="${NODE_BIN:-$(command -v node)}"
DEFAULT_CONFIG_ROOT="${REMOTELAB_CONFIG_DIR:-$HOME/.config/remotelab}"
DEFAULT_CONFIG_PATH="$DEFAULT_CONFIG_ROOT/feishu-connector/config.json"
CONFIG_PATH="${REMOTELAB_FEISHU_CONFIG_PATH:-$DEFAULT_CONFIG_PATH}"
CONFIG_EXPLICIT=false
if [[ -n "${REMOTELAB_FEISHU_CONFIG_PATH:-}" ]]; then
  CONFIG_EXPLICIT=true
fi
SYSTEMD_UNIT="${REMOTELAB_FEISHU_CONNECTOR_SYSTEMD_UNIT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "missing value for --config" >&2
        exit 2
      fi
      CONFIG_PATH="$2"
      CONFIG_EXPLICIT=true
      shift 2
      ;;
    --systemd-unit)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "missing value for --systemd-unit" >&2
        exit 2
      fi
      SYSTEMD_UNIT="$2"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$CONFIG_EXPLICIT" == false && -z "$SYSTEMD_UNIT" ]]; then
  SYSTEMD_UNIT="remotelab-feishu-connector.service"
fi
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "feishu connector config does not exist: $CONFIG_PATH" >&2
  exit 2
fi

CONFIG_PATH="$(cd -- "$(dirname -- "$CONFIG_PATH")" && pwd)/$(basename -- "$CONFIG_PATH")"
CONFIG_DIR="$(dirname -- "$CONFIG_PATH")"
STORAGE_DIR="$(
  cd "$ROOT_DIR"
  "$NODE_BIN" --input-type=module -e '
    import { readFile } from "fs/promises";
    import { dirname, resolve } from "path";
    const configPath = process.argv[1];
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const storageDir = typeof config.storageDir === "string" ? config.storageDir.trim() : "";
    console.log(storageDir ? resolve(storageDir) : dirname(configPath));
  ' "$CONFIG_PATH"
)"
PID_FILE="$STORAGE_DIR/connector.pid"
LOG_PATH="$STORAGE_DIR/connector.log"

mkdir -p "$STORAGE_DIR"

systemd_main_pid() {
  if [[ -z "$SYSTEMD_UNIT" ]]; then
    return 1
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi
  if ! systemctl is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
    return 1
  fi

  local pid
  pid="$(systemctl show "$SYSTEMD_UNIT" --property=MainPID --value 2>/dev/null || true)"
  if [[ -z "$pid" || "$pid" == "0" ]]; then
    return 1
  fi
  printf '%s\n' "$pid"
}

process_matches_config() {
  local pid command_line
  pid="$1"
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command_line" != *"scripts/feishu-connector.mjs"* ]]; then
    return 1
  fi
  if [[ "$command_line" == *"--config $CONFIG_PATH"* || "$command_line" == *"--config=$CONFIG_PATH"* ]]; then
    return 0
  fi
  if [[ "$CONFIG_PATH" == "$DEFAULT_CONFIG_PATH" && "$command_line" != *"--config"* ]]; then
    return 0
  fi
  return 1
}

validate_pid_file() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    rm -f "$PID_FILE"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    return 0
  fi
  if ! process_matches_config "$pid"; then
    echo "refusing to operate on pid $pid: process does not match config $CONFIG_PATH" >&2
    exit 2
  fi
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

  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
    return 0
  fi

  rm -f "$PID_FILE"
  return 1
}

wait_for_ready() {
  local pid log_offset tail_offset
  pid="$1"
  log_offset="${2:-0}"
  tail_offset=$((log_offset + 1))
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if [[ -f "$LOG_PATH" ]] && tail -c +"$tail_offset" "$LOG_PATH" 2>/dev/null | grep -q 'persistent connection ready'; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_instance() {
  local pid systemd_pid log_offset
  if systemd_pid="$(systemd_main_pid)"; then
    if pid="$(running_pid)" && [[ "$pid" != "$systemd_pid" ]]; then
      kill "$pid" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "stopped duplicate instance feishu connector (pid $pid); systemd owns the connector"
    fi
    echo "feishu connector already running under systemd ($SYSTEMD_UNIT, pid $systemd_pid)"
    echo "not starting a second Feishu event consumer"
    return 0
  fi

  if pid="$(running_pid)"; then
    echo "feishu connector already running (pid $pid)"
    echo "log: $LOG_PATH"
    return 0
  fi

  log_offset=0
  if [[ -f "$LOG_PATH" ]]; then
    log_offset="$(wc -c < "$LOG_PATH" 2>/dev/null || printf '0')"
  fi
  printf '\n=== start %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_PATH"

  (
    cd "$ROOT_DIR"
    nohup env \
      PATH="$PATH" \
      HOME="$HOME" \
      USER="${USER:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      "$NODE_BIN" scripts/feishu-connector.mjs --config "$CONFIG_PATH" >> "$LOG_PATH" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )

  pid="$(cat "$PID_FILE")"
  if ! wait_for_ready "$pid" "$log_offset"; then
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
  local pid systemd_pid
  if systemd_pid="$(systemd_main_pid)"; then
    echo "systemd feishu connector is running"
    echo "config: $CONFIG_PATH"
    echo "unit: $SYSTEMD_UNIT"
    echo "pid: $systemd_pid"
    ps -p "$systemd_pid" -o pid=,ppid=,user=,lstart=,command=
    if pid="$(running_pid)" && [[ "$pid" != "$systemd_pid" ]]; then
      echo
      echo "duplicate instance feishu connector is also running"
      echo "pid: $pid"
      echo "log: $LOG_PATH"
      ps -p "$pid" -o pid=,ppid=,user=,lstart=,command=
      return 2
    fi
    return 0
  fi

  if ! pid="$(running_pid)"; then
    echo "feishu connector is not running"
    echo "log: $LOG_PATH"
    return 1
  fi

  echo "feishu connector is running"
  echo "config: $CONFIG_PATH"
  echo "pid: $pid"
  echo "log: $LOG_PATH"
  ps -p "$pid" -o pid=,ppid=,user=,lstart=,command=
}

show_logs() {
  tail -n 80 "$LOG_PATH"
}

validate_pid_file

case "$ACTION" in
  start)
    start_instance
    ;;
  stop)
    stop_instance
    ;;
  restart)
    if systemd_pid="$(systemd_main_pid)"; then
      systemctl restart "$SYSTEMD_UNIT"
      echo "restarted systemd feishu connector ($SYSTEMD_UNIT)"
      show_status
    else
      stop_instance
      start_instance
    fi
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs} [--config PATH] [--systemd-unit UNIT]" >&2
    exit 1
    ;;
esac

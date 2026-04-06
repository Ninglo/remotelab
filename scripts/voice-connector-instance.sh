#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
ACTION="${1:-start}"
CONFIG_DIR="$HOME/.config/remotelab/voice-connector"
CONFIG_PATH="$CONFIG_DIR/config.json"
PID_FILE="$CONFIG_DIR/connector.pid"
LOG_PATH="$CONFIG_DIR/connector.log"
LAUNCHER_PATH="$CONFIG_DIR/start-connector-terminal.sh"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
START_MODE="${VOICE_CONNECTOR_START_MODE:-auto}"

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

resolved_start_mode() {
  case "$START_MODE" in
    auto)
      if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
        printf '%s\n' 'bootstrap'
      else
        printf '%s\n' 'nohup'
      fi
      ;;
    bootstrap|terminal|nohup)
      printf '%s\n' "$START_MODE"
      ;;
    *)
      printf '%s\n' 'nohup'
      ;;
  esac
}

start_instance_nohup() {
  (
    cd "$ROOT_DIR"
    nohup env \
      PATH="$PATH" \
      HOME="$HOME" \
      USER="${USER:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      "$NODE_BIN" scripts/voice-connector.mjs --config "$CONFIG_PATH" >> "$LOG_PATH" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )
}

start_instance_terminal() {
  cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $(printf '%q' "$ROOT_DIR")
echo \$\$ > $(printf '%q' "$PID_FILE")
exec env \
  PATH=$(printf '%q' "$PATH") \
  HOME=$(printf '%q' "$HOME") \
  USER=$(printf '%q' "${USER:-}") \
  SHELL=$(printf '%q' "${SHELL:-/bin/bash}") \
  $(printf '%q' "$NODE_BIN") scripts/voice-connector.mjs --config $(printf '%q' "$CONFIG_PATH") >> $(printf '%q' "$LOG_PATH") 2>&1
EOF
  chmod +x "$LAUNCHER_PATH"

  osascript <<APPLESCRIPT >/dev/null
tell application "Terminal"
  activate
  do script "bash $(printf '%q' "$LAUNCHER_PATH")"
end tell
APPLESCRIPT
}

start_instance_bootstrap() {
  cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $(printf '%q' "$ROOT_DIR")
nohup env \
  PATH=$(printf '%q' "$PATH") \
  HOME=$(printf '%q' "$HOME") \
  USER=$(printf '%q' "${USER:-}") \
  SHELL=$(printf '%q' "${SHELL:-/bin/bash}") \
  $(printf '%q' "$NODE_BIN") scripts/voice-connector.mjs --config $(printf '%q' "$CONFIG_PATH") >> $(printf '%q' "$LOG_PATH") 2>&1 < /dev/null &
echo \$! > $(printf '%q' "$PID_FILE")
exit 0
EOF
  chmod +x "$LAUNCHER_PATH"

  osascript <<APPLESCRIPT >/dev/null
tell application "Terminal"
  set bootstrapTab to do script "bash $(printf '%q' "$LAUNCHER_PATH")"
  repeat 20 times
    delay 0.2
    try
      if not (busy of bootstrapTab) then exit repeat
    end try
  end repeat
  try
    set bootstrapWindow to first window whose selected tab is bootstrapTab
    close bootstrapWindow saving no
  end try
end tell
APPLESCRIPT
}

start_instance() {
  local pid mode
  if pid="$(running_pid)"; then
    echo "voice connector already running (pid $pid)"
    echo "config: $CONFIG_PATH"
    echo "log: $LOG_PATH"
    return 0
  fi

  if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "voice connector config not found: $CONFIG_PATH" >&2
    exit 1
  fi

  printf '\n=== start %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_PATH"

  rm -f "$PID_FILE"
  mode="$(resolved_start_mode)"
  if [[ "$mode" == "bootstrap" ]]; then
    start_instance_bootstrap
  elif [[ "$mode" == "terminal" ]]; then
    start_instance_terminal
  else
    start_instance_nohup
  fi

  for _ in $(seq 1 60); do
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    else
      pid=""
    fi
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "started voice connector (pid $pid)"
      echo "mode: $mode"
      echo "config: $CONFIG_PATH"
      echo "log: $LOG_PATH"
      return 0
    fi
    sleep 0.5
  done

  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "started voice connector (pid $pid)"
    echo "mode: $mode"
    echo "config: $CONFIG_PATH"
    echo "log: $LOG_PATH"
    return 0
  fi

  echo "failed to start voice connector" >&2
  tail -n 80 "$LOG_PATH" >&2 || true
  exit 1
}

stop_instance() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    echo "voice connector is already stopped"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped voice connector (pid $pid)"
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "force-stopped voice connector (pid $pid)"
}

show_status() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "voice connector is not running"
    echo "config: $CONFIG_PATH"
    echo "log: $LOG_PATH"
    return 1
  fi

  echo "voice connector is running"
  echo "pid: $pid"
  echo "config: $CONFIG_PATH"
  echo "log: $LOG_PATH"
  ps -p "$pid" -o pid=,ppid=,user=,lstart=,command=
}

show_logs() {
  tail -n 80 "$LOG_PATH"
}

read_config_value() {
  local expression
  expression="$1"
  "$NODE_BIN" -e "const fs=require('fs/promises'); (async()=>{ const cfg=JSON.parse(await fs.readFile(process.argv[1], 'utf8')); const value=(${expression}); if (value === undefined || value === null) process.exit(0); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); })().catch((error)=>{ console.error(error?.message || error); process.exit(1); });" "$CONFIG_PATH"
}

resolve_asr_python() {
  if [[ -n "${VOICE_CONNECTOR_ASR_PYTHON:-}" ]]; then
    printf '%s\n' "$VOICE_CONNECTOR_ASR_PYTHON"
    return 0
  fi
  if [[ -x "$HOME/.tmp/asr-venv/bin/python" ]]; then
    printf '%s\n' "$HOME/.tmp/asr-venv/bin/python"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  return 1
}

run_input_probe() {
  local python_bin
  if ! python_bin="$(resolve_asr_python)"; then
    echo "input probe unavailable: no Python runtime found" >&2
    return 1
  fi
  "$python_bin" "$ROOT_DIR/scripts/voice-utterance-loop.py" --probe-input
}

run_downstream_check() {
  local prompt output
  prompt="$1"
  output="$($NODE_BIN "$ROOT_DIR/scripts/voice-connector.mjs" --config "$CONFIG_PATH" --text "$prompt" --no-speak 2>&1)" || {
    printf '%s\n' "$output"
    return 1
  }
  printf '%s\n' "$output"
  printf '%s\n' "$output" | rg -q '语音后半段链路正常'
}

run_wake_self_check() {
  local prompt wake_command wake_keyword voice_name temp_dir audio_path wake_output wake_event connector_output
  prompt="$1"
  wake_command="$(read_config_value 'cfg?.wake?.command || ""')"
  wake_keyword="$(read_config_value 'cfg?.wake?.keyword || ""')"
  if [[ -z "$wake_command" || -z "$wake_keyword" ]]; then
    echo "wake self-check unavailable: wake command or keyword is missing" >&2
    return 1
  fi
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v say >/dev/null 2>&1; then
    echo "wake self-check unavailable: synthetic wake audio is only wired for macOS with 'say'" >&2
    return 1
  fi

  temp_dir="$(mktemp -d)"
  audio_path="$temp_dir/voice-self-check.aiff"
  voice_name="${VOICE_CONNECTOR_SELF_CHECK_VOICE:-Tingting}"
  if ! say -v "$voice_name" -o "$audio_path" "${wake_keyword}${prompt}" >/dev/null 2>&1; then
    if ! say -o "$audio_path" "${wake_keyword}${prompt}" >/dev/null 2>&1; then
      rm -rf "$temp_dir"
      echo "wake self-check unavailable: failed to synthesize test audio" >&2
      return 1
    fi
  fi

  wake_output="$(bash -lc "$wake_command --test-file $(printf '%q' "$audio_path")" 2>&1)" || {
    printf '%s\n' "$wake_output"
    rm -rf "$temp_dir"
    return 1
  }
  printf '%s\n' "$wake_output"
  wake_event="$(printf '%s\n' "$wake_output" | awk '/^\{/{line=$0} END{print line}')"
  if [[ -z "$wake_event" ]]; then
    rm -rf "$temp_dir"
    echo "wake self-check failed: wake command did not emit an event" >&2
    return 1
  fi

  connector_output="$(printf '%s\n' "$wake_event" | $NODE_BIN "$ROOT_DIR/scripts/voice-connector.mjs" --config "$CONFIG_PATH" --stdin --no-speak 2>&1)" || {
    printf '%s\n' "$connector_output"
    rm -rf "$temp_dir"
    return 1
  }
  printf '%s\n' "$connector_output"
  rm -rf "$temp_dir"
  printf '%s\n' "$connector_output" | rg -q '语音后半段链路正常'
}

check_instance() {
  local prompt input_ok downstream_ok
  prompt='这是一次语音链路自检，请只回复：语音后半段链路正常。'
  input_ok=0
  downstream_ok=0

  echo "voice connector self-check"
  echo "config: $CONFIG_PATH"

  echo "--- input probe ---"
  if run_input_probe; then
    input_ok=1
  fi

  echo "--- wake simulation ---"
  if run_wake_self_check "$prompt"; then
    downstream_ok=1
  else
    echo "--- direct downstream fallback ---"
    if run_downstream_check "$prompt"; then
      downstream_ok=1
    fi
  fi

  if [[ "$input_ok" -eq 1 && "$downstream_ok" -eq 1 ]]; then
    echo "self-check result: live mic and downstream chain look healthy"
    return 0
  fi
  if [[ "$input_ok" -ne 1 && "$downstream_ok" -eq 1 ]]; then
    echo "self-check result: downstream chain is healthy, but no live input device is currently available"
    return 2
  fi
  echo "self-check result: voice chain check failed"
  return 1
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
  check)
    check_instance
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs|check}" >&2
    exit 1
    ;;
esac

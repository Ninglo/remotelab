#!/bin/bash
# Restart one or all RemoteLab services.
# Usage:
#   restart.sh          — restart all services
#   restart.sh chat     — restart only chat-server
#   restart.sh tunnel   — restart only cloudflared

set -e

SERVICE="${1:-all}"

# Detect OS
if [[ "$(uname)" == "Darwin" ]]; then
    OS_TYPE="macos"
else
    OS_TYPE="linux"
fi

# ── macOS: launchctl ──────────────────────────────────────────────────────────
restart_launchd() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  local name="$2"

  if [ ! -f "$plist" ]; then
    echo "  $name: plist not found, skipping"
    return
  fi

  if launchctl list | grep -q "$label"; then
    launchctl stop "$label" 2>/dev/null || true
    sleep 1
    echo "  $name: restarted ($(launchctl list | grep "$label" | awk '{print "pid="$1}'))"
  else
    launchctl load "$plist" 2>/dev/null
    echo "  $name: loaded"
  fi
}

# ── Linux: systemd --user ─────────────────────────────────────────────────────
restart_systemd() {
  local unit="$1"
  local name="$2"

  if ! systemctl --user list-unit-files "${unit}.service" &>/dev/null; then
    echo "  $name: service unit not found, skipping"
    return
  fi

  systemctl --user restart "${unit}.service" 2>/dev/null && \
    echo "  $name: restarted" || \
    echo "  $name: failed to restart (check: journalctl --user -u ${unit})"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
restart_service() {
  local name="$1"
  local launchd_label="$2"
  local systemd_unit="$3"

  if [[ "$OS_TYPE" == "macos" ]]; then
    restart_launchd "$launchd_label" "$name"
  else
    restart_systemd "$systemd_unit" "$name"
  fi
}

case "$SERVICE" in
  chat)
    echo "Restarting chat-server..."
    restart_service "chat-server" "com.chatserver.claude" "remotelab-chat"
    ;;
  tunnel)
    echo "Restarting cloudflared..."
    restart_service "cloudflared" "com.cloudflared.tunnel" "remotelab-tunnel"
    ;;
  all)
    echo "Restarting all services..."
    restart_service "chat-server" "com.chatserver.claude"  "remotelab-chat"
    restart_service "cloudflared" "com.cloudflared.tunnel" "remotelab-tunnel"
    ;;
  *)
    echo "Unknown service: $SERVICE"
    echo "Usage: restart.sh [chat|tunnel|all]"
    exit 1
    ;;
esac

echo "Done!"

#!/bin/bash
# Restart RemoteLab services.
# Usage:
#   restart.sh          — restart all services
#   restart.sh chat     — restart owner + all guest chat surfaces
#   restart.sh tunnel   — restart only cloudflared
#   restart.sh mainland — restart only natapp mainland proxy

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
  local uid
  uid="$(id -u)"
  local launchctl_line
  local pid

  if [ ! -f "$plist" ]; then
    echo "  $name: plist not found, skipping"
    return
  fi

  if launchctl list | grep -q "$label"; then
    launchctl kickstart -k "gui/${uid}/${label}" 2>/dev/null || true
    sleep 1
    launchctl_line="$(launchctl list | awk -v target="$label" '$3 == target { print; exit }')"
    pid="$(printf '%s\n' "$launchctl_line" | awk 'NF { print $1 }')"
    if [ -n "$pid" ]; then
      echo "  $name: restarted (pid=$pid)"
    else
      echo "  $name: restarted"
    fi
  else
    launchctl load "$plist" 2>/dev/null
    echo "  $name: loaded"
  fi
}

restart_all_chat_launchd() {
  local launch_agents_dir="$HOME/Library/LaunchAgents"
  local labels=()
  local plist

  if [ -f "$launch_agents_dir/com.chatserver.claude.plist" ]; then
    labels+=("com.chatserver.claude")
  fi

  for plist in "$launch_agents_dir"/com.chatserver.*.plist; do
    [ -e "$plist" ] || continue
    if [ "$plist" = "$launch_agents_dir/com.chatserver.claude.plist" ]; then
      continue
    fi
    labels+=("$(basename "$plist" .plist)")
  done

  if [ "${#labels[@]}" -eq 0 ]; then
    echo "  chat surfaces: no launch agents found, skipping"
    return
  fi

  echo "  chat surfaces: restarting ${#labels[@]} services"
  for label in "${labels[@]}"; do
    restart_launchd "$label" "$label"
  done
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
    echo "Restarting all chat surfaces..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_all_chat_launchd
    else
      restart_service "chat-server" "com.chatserver.claude" "remotelab-chat"
    fi
    ;;
  tunnel)
    echo "Restarting cloudflared..."
    restart_service "cloudflared" "com.cloudflared.tunnel" "remotelab-tunnel"
    ;;
  mainland)
    echo "Restarting natapp mainland proxy..."
    restart_service "natapp mainland proxy" "com.remotelab.natapp.dual-proxy" "remotelab-natapp-dual-proxy"
    ;;
  all)
    echo "Restarting all services..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_all_chat_launchd
    else
      restart_service "chat-server" "com.chatserver.claude"  "remotelab-chat"
    fi
    restart_service "cloudflared" "com.cloudflared.tunnel" "remotelab-tunnel"
    restart_service "natapp mainland proxy" "com.remotelab.natapp.dual-proxy" "remotelab-natapp-dual-proxy"
    ;;
  *)
    echo "Unknown service: $SERVICE"
    echo "Usage: restart.sh [chat|tunnel|mainland|all]"
    exit 1
    ;;
esac

echo "Done!"

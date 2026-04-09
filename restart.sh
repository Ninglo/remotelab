#!/bin/bash
# Restart RemoteLab services.
# Usage:
#   restart.sh          — restart all services
#   restart.sh chat     — restart owner + all guest chat surfaces
#   restart.sh tunnel   — restart only cloudflared
#   restart.sh bridge   — restart only the natapp prefix bridge

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

# ── Linux: systemd ────────────────────────────────────────────────────────────
linux_system_unit_exists() {
  local unit="$1"
  systemctl list-unit-files "${unit}.service" &>/dev/null || systemctl status "${unit}.service" &>/dev/null
}

linux_user_unit_exists() {
  local unit="$1"
  systemctl --user list-unit-files "${unit}.service" &>/dev/null || systemctl --user status "${unit}.service" &>/dev/null
}

linux_resolve_owner_chat_unit() {
  if linux_system_unit_exists "remotelab"; then
    echo "system:remotelab"
    return 0
  fi
  if linux_user_unit_exists "remotelab-chat"; then
    echo "user:remotelab-chat"
    return 0
  fi
  return 1
}

restart_linux_unit() {
  local scope="$1"
  local unit="$2"
  local name="$3"
  local journal_hint

  if [[ "$scope" == "user" ]]; then
    systemctl --user restart "${unit}.service" 2>/dev/null && \
      echo "  $name: restarted" || \
      echo "  $name: failed to restart (check: journalctl --user -u ${unit})"
    return
  fi

  journal_hint="journalctl -u ${unit} -n 50"
  systemctl restart "${unit}.service" 2>/dev/null && \
    echo "  $name: restarted" || \
    echo "  $name: failed to restart (check: ${journal_hint})"
}

restart_linux_chat_surfaces() {
  local owner
  owner="$(linux_resolve_owner_chat_unit || true)"
  if [[ -z "$owner" ]]; then
    echo "  chat-server: service unit not found, skipping"
    return
  fi

  local owner_scope="${owner%%:*}"
  local owner_unit="${owner#*:}"
  restart_linux_unit "$owner_scope" "$owner_unit" "chat-server"

  if [[ "$owner_scope" == "system" ]]; then
    local guest_units=()
    while IFS= read -r unit; do
      [[ -n "$unit" ]] && guest_units+=("$unit")
    done < <(systemctl list-unit-files 'remotelab-guest@*.service' --no-legend --plain 2>/dev/null | awk '{print $1}' | sed 's/\.service$//')

    if [[ "${#guest_units[@]}" -gt 0 ]]; then
      echo "  guest chat surfaces: restarting ${#guest_units[@]} services"
      local guest_unit
      for guest_unit in "${guest_units[@]}"; do
        restart_linux_unit "system" "$guest_unit" "$guest_unit"
      done
    fi
  fi
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
restart_service() {
  local name="$1"
  local launchd_label="$2"
  local systemd_unit="$3"

  if [[ "$OS_TYPE" == "macos" ]]; then
    restart_launchd "$launchd_label" "$name"
  else
    restart_linux_unit "user" "$systemd_unit" "$name"
  fi
}

case "$SERVICE" in
  chat)
    echo "Restarting all chat surfaces..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_all_chat_launchd
    else
      restart_linux_chat_surfaces
    fi
    ;;
  tunnel)
    echo "Restarting cloudflared..."
    restart_service "cloudflared" "com.cloudflared.tunnel" "remotelab-tunnel"
    ;;
  bridge)
    echo "Restarting prefix bridge..."
    restart_service "prefix bridge" "com.remotelab.natapp.dual-proxy" "remotelab-prefix-bridge"
    ;;
  all)
    echo "Restarting all services..."
    if [[ "$OS_TYPE" == "macos" ]]; then
      restart_all_chat_launchd
    else
      restart_linux_chat_surfaces
    fi
    restart_service "cloudflared" "com.cloudflared.tunnel" "remotelab-tunnel"
    ;;
  *)
    echo "Unknown service: $SERVICE"
    echo "Usage: restart.sh [chat|tunnel|bridge|all]"
    exit 1
    ;;
esac

echo "Done!"

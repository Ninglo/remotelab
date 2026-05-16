#!/bin/bash
set -e
echo "Starting RemoteLab services..."

if [[ "$(uname)" == "Darwin" ]]; then
  if [ -f ~/Library/LaunchAgents/com.chatserver.claude.plist ]; then
    launchctl load ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server already loaded"
  fi
  if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
    launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
  fi
if [ -f ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist 2>/dev/null || echo "natapp prefix bridge already loaded"
fi
  echo "Services started!"
  echo ""
  echo "Check status with:"
  echo "  launchctl list | grep -E 'chatserver|cloudflared|natapp'"
else
  sudo systemctl start remotelab.service
  if systemctl list-unit-files remotelab-quick-tunnel.service &>/dev/null 2>&1; then
    sudo systemctl start remotelab-quick-tunnel.service
    sleep 5
  fi
  if systemctl --user list-unit-files remotelab-tunnel.service &>/dev/null 2>&1; then
    systemctl --user start remotelab-tunnel.service
  fi
  echo "Services started!"
  echo ""
  echo "Check status with:"
  echo "  systemctl status remotelab.service"
  if systemctl list-unit-files remotelab-quick-tunnel.service &>/dev/null 2>&1; then
    echo "  systemctl status remotelab-quick-tunnel.service"
    TUNNEL_URL=$(grep -E '^REMOTELAB_PUBLIC_BASE_URL=' /etc/remotelab/remotelab.env 2>/dev/null | tail -1 | cut -d= -f2-)
    if [ -z "$TUNNEL_URL" ]; then
      TUNNEL_URL=$(grep -Eho 'https://[^[:space:]]+trycloudflare\.com' /var/log/remotelab/cloudflared.log /var/log/remotelab/cloudflared.error.log 2>/dev/null | tail -1 || true)
    fi
    ACCESS_TOKEN=$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.config/remotelab/auth.json", "utf8")).token || "") } catch {}' 2>/dev/null)
    if [ -n "$TUNNEL_URL" ] && [ -n "$ACCESS_TOKEN" ]; then
      echo ""
      echo "Current access URL:"
      echo "  ${TUNNEL_URL}/?token=${ACCESS_TOKEN}"
    fi
  fi
fi

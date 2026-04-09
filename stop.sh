#!/bin/bash
set -e
echo "Stopping RemoteLab services..."

if [[ "$(uname)" == "Darwin" ]]; then
  launchctl unload ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server not loaded"
  if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
    launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
  fi
if [ -f ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.remotelab.natapp.dual-proxy.plist 2>/dev/null || echo "natapp prefix bridge not loaded"
fi
else
  sudo systemctl stop remotelab.service 2>/dev/null || echo "chat-server not running"
  systemctl --user stop remotelab-tunnel.service 2>/dev/null || true
fi

echo "Services stopped!"

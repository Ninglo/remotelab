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
  if systemctl --user list-unit-files remotelab-tunnel.service &>/dev/null 2>&1; then
    systemctl --user start remotelab-tunnel.service
  fi
  echo "Services started!"
  echo ""
  echo "Check status with:"
  echo "  systemctl status remotelab.service"
fi

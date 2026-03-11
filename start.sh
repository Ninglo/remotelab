#!/bin/bash
echo "Starting RemoteLab services..."
if [ -f ~/Library/LaunchAgents/com.chatserver.claude.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server already loaded"
fi
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
fi
echo "Services started!"
echo ""
echo "Check status with:"
echo "  launchctl list | grep -E 'chatserver|cloudflared'"

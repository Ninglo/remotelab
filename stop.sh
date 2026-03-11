#!/bin/bash
echo "Stopping RemoteLab services..."
launchctl unload ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server not loaded"
if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
fi
echo "Services stopped!"

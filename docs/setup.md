# RemoteLab Setup Guide (AI-Executable)

This document is written to be executed by an AI agent (CodeX, Claude Code, etc.).

Steps marked **[HUMAN]** cannot be automated — they require the user to interact with a browser or confirm something. At each `[HUMAN]` step, stop, explain what the user needs to do, and wait for confirmation before continuing.

---

## What you're setting up

The boot-managed owner stack:

| Service | Port | Role |
|---------|------|------|
| `remotelab-chat` / `com.chatserver.claude` | 7690 | **Primary.** Chat UI — this is what the user accesses |
| `remotelab-tunnel` / `com.cloudflared.tunnel` | — | Cloudflare tunnel — routes a public HTTPS domain to port 7690 |

RemoteLab now ships with a single boot-managed chat plane on `7690`. Clean restart recovery removes the need for a separate permanent validation chat service.

**Goal:** User opens `https://[subdomain].[domain]/?token=TOKEN` on their phone and gets a working chat UI.

---

## Platform support

| Platform | Service Manager | Tested |
|----------|----------------|--------|
| macOS    | launchd (LaunchAgent plists) | ✓ |
| Linux (Ubuntu/Debian/RHEL) | systemd user services | ✓ |

---

## Pre-flight checklist

Before starting, verify the following. If anything is missing, install it or inform the user.

## Configuration principle

RemoteLab should treat **setup as the primary configuration UX**, not the chat page.

- The AI running setup should explicitly ask the user which installed tool(s) they actually have access to and want to use.
- The AI should also ask for the user's preferred default model / reasoning mode for each enabled tool if multiple choices exist.
- These answers should seed RemoteLab's defaults for new sessions.
- The chat UI should stay lightweight: show the current selection, allow changing it, but avoid heavy onboarding or wizard-like guidance.
- **Runtime source of truth:** the model/tool selected on the current chat turn wins. Background one-shot calls (for example auto-naming or sidebar summarization) should inherit that exact per-turn selection rather than falling back to a hardcoded provider or only using setup defaults.

At minimum, the AI doing setup should confirm these items with the user:

1. Which provider/tool should be enabled by default for new sessions
2. Which model should be the default for each enabled provider
3. Which reasoning default should be used (`thinking` / effort level) where supported
4. Whether progress sidebar summarization should be enabled by default

If multiple tools are installed and the user has no strong preference, prefer `CodeX` (`codex`) as the default built-in tool.

### macOS

```bash
uname -s   # must be Darwin

# Homebrew
which brew || echo "MISSING: install Homebrew first"

# Node.js 18+
node --version

# At least one AI CLI tool
which codex || which claude || which cline || echo "MISSING: install at least one AI CLI tool"

# Check if remotelab is already installed via npm link
which remotelab 2>/dev/null && echo "already linked" || echo "need to npm link"
```

### Linux

```bash
uname -s   # must be Linux

# Node.js 18+
node --version || echo "MISSING: install Node.js"
# Install: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs

# At least one AI CLI tool
which codex || which claude || which cline || echo "MISSING: install at least one AI CLI tool"
```

---

## Phase 1: Clone & install

> **AI can execute this automatically.**

```bash
# If not already cloned:
git clone https://github.com/Ninglo/remotelab.git ~/code/remotelab
cd ~/code/remotelab
npm install
npm link   # makes `remotelab` available globally
```

### macOS only

```bash
brew install cloudflared
```

### Linux only

```bash
# cloudflared (only needed for Cloudflare mode)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

Verify:
```bash
which remotelab
which cloudflared   # only if using Cloudflare mode
```

---

## Phase 2: Generate access token

> **AI can execute this automatically.**

```bash
remotelab generate-token
```

This writes to `~/.config/remotelab/auth.json` and prints the token. **Capture this token** — it's required for the first login.

Optionally, set a username/password alternative:
```bash
remotelab set-password
```

---

## Phase 3: [HUMAN] Cloudflare authentication (Cloudflare mode only)

> **Stop here. The user must do this manually.**

Tell the user:

> "I need you to authenticate with Cloudflare. A browser will open — log in to your Cloudflare account and select the domain `[DOMAIN]` when prompted. Come back and tell me when it's done."

```bash
cloudflared tunnel login
```

Wait for the browser flow. Confirm success:
```bash
ls ~/.cloudflared/cert.pem && echo "authenticated" || echo "FAILED — cert.pem not found"
```

---

## Phase 4: Create tunnel & route DNS (Cloudflare mode only)

> **AI can execute this automatically** (after Phase 3 is confirmed done).

```bash
cloudflared tunnel create remotelab
```

The output includes a Tunnel ID (UUID format). Capture it.

```bash
cloudflared tunnel route dns remotelab SUBDOMAIN.DOMAIN
```

Create the cloudflared config:

```bash
mkdir -p ~/.cloudflared

cat > ~/.cloudflared/config.yml << EOF
tunnel: remotelab
credentials-file: $HOME/.cloudflared/TUNNEL_ID.json
protocol: http2

ingress:
  - hostname: SUBDOMAIN.DOMAIN
    service: http://127.0.0.1:7690
  - service: http_status:404
EOF
```

Verify config is valid:
```bash
cloudflared tunnel validate
```

---

## Phase 5: Create service definitions

> **AI can execute this automatically.** All paths must be absolute.

Get the actual paths first:
```bash
which node         # e.g. /usr/bin/node or /usr/local/bin/node
echo $HOME
REMOTELAB_DIR=$(cd ~/code/remotelab && pwd)
```

### macOS — LaunchAgent plists

```bash
# chat server (primary)
cat > ~/Library/LaunchAgents/com.chatserver.claude.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.chatserver.claude</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>NODE_PATH_HERE</string>
        <string>REMOTELAB_DIR_HERE/chat-server.mjs</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>WorkingDirectory</key>
    <string>HOME_DIR_HERE</string>
    <key>StandardOutPath</key>
    <string>HOME_DIR_HERE/Library/Logs/chat-server.log</string>
    <key>StandardErrorPath</key>
    <string>HOME_DIR_HERE/Library/Logs/chat-server.error.log</string>
</dict>
</plist>
EOF
```

### Linux — systemd user services

```bash
mkdir -p ~/.config/systemd/user
mkdir -p ~/.local/share/remotelab/logs

# chat server (primary)
cat > ~/.config/systemd/user/remotelab-chat.service << EOF
[Unit]
Description=RemoteLab Chat Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$HOME
ExecStart=NODE_PATH_HERE REMOTELAB_DIR_HERE/chat-server.mjs
Restart=always
RestartSec=5
StandardOutput=append:$HOME/.local/share/remotelab/logs/chat-server.log
StandardError=append:$HOME/.local/share/remotelab/logs/chat-server.error.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

# cloudflared tunnel (only if using Cloudflare mode)
cat > ~/.config/systemd/user/remotelab-tunnel.service << EOF
[Unit]
Description=RemoteLab Cloudflare Tunnel
After=network.target

[Service]
Type=simple
WorkingDirectory=$HOME
ExecStart=CLOUDFLARED_PATH_HERE tunnel run
Restart=always
RestartSec=5
StandardOutput=append:$HOME/.local/share/remotelab/logs/cloudflared.log
StandardError=append:$HOME/.local/share/remotelab/logs/cloudflared.error.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
```

Replace `NODE_PATH_HERE`, `REMOTELAB_DIR_HERE`, `CLOUDFLARED_PATH_HERE` with actual absolute paths.

Enable lingering so services survive logout:
```bash
loginctl enable-linger $USER
```

---

## Phase 6: Start & verify

> **AI can execute this automatically.**

### macOS

```bash
mkdir -p ~/Library/Logs
launchctl load ~/Library/LaunchAgents/com.chatserver.claude.plist
launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist  # if Cloudflare mode
sleep 3
launchctl list | grep -E 'chatserver|cloudflared'
# Column 1 should be a number (PID), not a dash.
```

### Linux

```bash
systemctl --user enable remotelab-chat
systemctl --user start remotelab-chat
systemctl --user enable remotelab-tunnel  # if Cloudflare mode
systemctl --user start remotelab-tunnel   # if Cloudflare mode
sleep 3
systemctl --user status remotelab-chat
```

Verify chat server is listening:
```bash
# macOS
tail -5 ~/Library/Logs/chat-server.log
# Linux
tail -5 ~/.local/share/remotelab/logs/chat-server.log
# Both should contain: "Chat server listening on http://127.0.0.1:7690"
```

---

## Phase 7: [HUMAN] First login

> **Stop here. Tell the user their access URL.**

```
https://SUBDOMAIN.DOMAIN/?token=TOKEN_FROM_PHASE_2
```

---

## Alternative: Interactive setup wizard

Instead of the manual phases above, you can run:

```bash
remotelab setup
```

This interactive script handles phases 1–6 automatically, prompting for domain info and pausing for the Cloudflare browser login. It works on both **macOS** and **Linux**.

---

## Troubleshooting

### Storage keeps growing

This is expected. RemoteLab keeps durable session history, run output, artifacts, and logs on disk so work survives disconnects and restarts.

- Archiving a session does **not** delete its stored data.
- RemoteLab does **not** auto-delete old sessions and does **not** provide a built-in one-click cleanup flow.
- If disk usage starts to matter, periodically review old archived sessions and prune them manually from the terminal, or ask an AI operator to help you clean them up carefully.
- The main storage directories are `~/.config/remotelab/chat-history/` and `~/.config/remotelab/chat-runs/`.

### macOS: Service shows dash (no PID) in launchctl list

```bash
tail -50 ~/Library/Logs/chat-server.error.log
```

### Linux: Service failed to start

```bash
systemctl --user status remotelab-chat
journalctl --user -u remotelab-chat -n 50
# or check log files:
tail -50 ~/.local/share/remotelab/logs/chat-server.error.log
```

### Port already in use

```bash
lsof -i :7690   # chat server
```

### Restart a single service

```bash
remotelab restart chat
remotelab restart tunnel
remotelab restart all
```

### Token lost

```bash
remotelab generate-token
```

### Linux: Services stop when I log out

Enable systemd user lingering:
```bash
loginctl enable-linger $USER
```

### DNS not propagating

```bash
dig @1.1.1.1 SUBDOMAIN.DOMAIN +short
```

### Wipe and start over

```bash
remotelab stop
# macOS:
rm ~/Library/LaunchAgents/com.chatserver.claude.plist
rm ~/Library/LaunchAgents/com.cloudflared.tunnel.plist
# Linux:
systemctl --user disable --now remotelab-chat remotelab-tunnel
rm ~/.config/systemd/user/remotelab-*.service
systemctl --user daemon-reload
# Both:
rm ~/.cloudflared/config.yml
# Then re-run: remotelab setup
```

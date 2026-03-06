# RemoteLab

[中文](README.zh.md) | English

Control AI coding tools (Claude Code, Codex, Cline) from your phone mac or any other device! — no SSH, no VPN, just a browser.

![Chat UI](docs/demo.gif)

---

## For Humans

### What it does

RemoteLab runs a lightweight web server on your **Mac or Linux server**. You point a Cloudflare tunnel at it, get an HTTPS URL, and from any browser (phone, tablet, whatever) you can open a chat interface that talks to Claude Code running on your machine.

Your sessions persist across disconnects. History is kept on disk. Multiple folders, multiple sessions, running in parallel.

### Get set up in 5 minutes — hand it to an AI

The fastest way to set this up is to paste the following prompt into Claude Code on your Mac or Linux server. The AI handles everything automatically. The only thing it'll stop and ask you for is a browser login to Cloudflare (unavoidable — they need to confirm you own the domain).

**Prerequisites before you paste the prompt:**
- **macOS**: Homebrew installed + Node.js 18+
- **Linux**: Node.js 18+ + `dtach` + `ttyd` (the setup wizard can install these automatically)
- At least one AI tool installed (`claude`, `codex`, `cline`, …)
- A domain pointed at Cloudflare ([free account](https://cloudflare.com), domain ~$1–12/yr from Namecheap or Porkbun)

---

**Copy this prompt into Claude Code:**

```
I want to set up RemoteLab on this Mac so I can control AI coding tools from my phone.

My domain: [YOUR_DOMAIN]          (e.g. example.com)
Subdomain I want to use: [SUBDOMAIN]  (e.g. chat — will create chat.example.com)

Please follow the full setup guide at docs/setup.md in this repository.
Do every step you can automatically. When you hit a [HUMAN] step, stop and tell me exactly what to do.
After I confirm each manual step, continue to the next phase.
```

Fill in your domain and subdomain, paste it, and follow the AI's instructions. You'll click through one Cloudflare browser login. Everything else is automated.

---

### What you'll have when done

Open `https://[subdomain].[domain]/?token=YOUR_TOKEN` on your phone:

![Dashboard](docs/new-dashboard.png)

- Create a session: pick a folder + AI tool
- Send messages — responses stream back in real time
- Close the browser, come back later — session is still alive
- Paste screenshots directly into the chat

### Daily usage

Once set up, the service auto-starts on boot (macOS LaunchAgent / Linux systemd). Just open the URL on your phone.

```
remotelab start          # start all services
remotelab stop           # stop all services
remotelab restart chat   # restart just the chat server
```

---

## Architecture

Two services run on your Mac behind a Cloudflare tunnel:

| Service | Port | Role |
|---------|------|------|
| `chat-server.mjs` | 7690 | **Primary.** Chat UI, spawns CLI tools, WebSocket streaming |
| `auth-proxy.mjs` | 7681 | **Fallback.** Raw terminal via ttyd — for emergencies only |

The Cloudflare tunnel routes your domain to the chat server (7690). The auth-proxy is localhost-only — if chat breaks badly enough, you SSH in and hit it directly.

```
Phone ──HTTPS──→ Cloudflare Tunnel ──→ chat-server :7690
                                              │
                                        spawns subprocess
                                        (claude / codex / cline)
                                              │
                                        streams events → WebSocket → browser
```

### Session persistence

Each chat session is a subprocess. When you disconnect, the process keeps running. When you reconnect, the server replays history and reattaches to the live stream.

If the `chat-server` itself restarts during an active run, that subprocess is interrupted. RemoteLab now marks the session as `interrupted` and exposes a `Resume` action when Claude/Codex resume metadata was captured, so restart recovery is explicit instead of silently losing the turn.

For self-hosting development, do not drive work from the same instance you keep restarting. Use a stable operator plane (for example `7690`) to edit and restart the target test instance (`7692`). For custom-port dev instances, use `scripts/chat-instance.sh`.

---

## CLI Reference

```
remotelab setup                Run interactive setup wizard
remotelab start                Start all services
remotelab stop                 Stop all services
remotelab restart [service]    Restart: chat | proxy | tunnel | all
remotelab chat                 Run chat server in foreground (debug)
remotelab server               Run auth proxy in foreground (debug)
remotelab generate-token       Generate a new access token
remotelab set-password         Set username & password (alternative to token)
remotelab --help               Show help
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_PORT` | `7690` | Chat server port |
| `LISTEN_PORT` | `7681` | Auth proxy port |
| `SESSION_EXPIRY` | `86400000` | Cookie lifetime in ms (24h) |
| `SECURE_COOKIES` | `1` | Set `0` for localhost without HTTPS |

## File locations

| Path | Contents |
|------|----------|
| `~/.config/remotelab/auth.json` | Access token + password hash |
| `~/.config/remotelab/chat-sessions.json` | Chat session metadata |
| `~/.config/remotelab/chat-history/` | Per-session event logs (JSONL) |
| `~/Library/Logs/chat-server.log` | Chat server stdout **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server stdout **(Linux)** |
| `~/Library/Logs/cloudflared.log` | Tunnel stdout **(macOS)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel stdout **(Linux)** |

## Security

- HTTPS via Cloudflare (TLS at edge, Mac-side is localhost HTTP)
- 256-bit random access token, timing-safe comparison
- Optional scrypt-hashed password login
- HttpOnly + Secure + SameSite=Strict session cookies, 24h expiry
- Per-IP rate limiting with exponential backoff on failed login
- Mac server binds to 127.0.0.1 only — no direct external exposure
- CSP headers with nonce-based script allowlist

## Troubleshooting

**Service won't start (macOS):**
```bash
tail -50 ~/Library/Logs/chat-server.error.log
tail -50 ~/Library/Logs/auth-proxy.error.log
```

**Service won't start (Linux):**
```bash
journalctl --user -u remotelab-chat -n 50
tail -50 ~/.local/share/remotelab/logs/chat-server.error.log
```

**DNS not resolving:** Wait 5–30 minutes after setup. Verify: `dig SUBDOMAIN.DOMAIN +short`

**Port already in use:**
```bash
lsof -i :7690   # chat server
lsof -i :7681   # auth proxy
```

**Restart a single service:**
```bash
remotelab restart chat
remotelab restart proxy
remotelab restart tunnel
```

**Manage a custom dev chat instance:**
```bash
scripts/chat-instance.sh restart --port 7692 --name test
scripts/chat-instance.sh status --port 7692 --name test
scripts/chat-instance.sh logs --port 7692 --name test
```

---

## License

MIT

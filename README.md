# RemoteLab

[中文](README.zh.md) | English

Mobile-first control console for AI workers running on your own Mac or Linux machine.

Control Claude Code, Codex, Cline, and compatible local tools from a phone browser. RemoteLab is not a terminal emulator or mobile IDE; it is a durable chat/control plane that keeps sessions, runs, and history on disk.

![Chat UI](docs/demo.gif)

> Current baseline: `v0.2` — filesystem-backed HTTP control plane, detached runners, thin WebSocket invalidation, and a no-build mobile UI.

---

## For Humans

### What RemoteLab is

RemoteLab is a **mobile-first control console for AI workers running on your own Mac or Linux machine**.

It is not a terminal emulator, not a mobile IDE, and not a generic multi-user chat SaaS. The current product model is:

- `Session` — the durable work thread
- `Run` — one execution attempt under a session
- `App` — a reusable template or policy for starting sessions
- `Share snapshot` — an immutable read-only export of a session

The important architectural assumptions are:

- HTTP is the canonical state path and WebSocket only hints that something changed
- the browser is a control surface, not the system of record
- runtime processes are disposable; durable state lives on disk
- the product is single-owner first, with visitor access scoped through Apps
- the frontend stays framework-light and mobile-friendly

### What you can do

- start a session from your phone while the agent works on your real machine
- keep durable history even if the browser disconnects
- recover long-running work after control-plane restarts
- let the agent auto-title and auto-group sessions in the sidebar
- paste screenshots directly into the chat
- create immutable read-only share snapshots
- create App links for visitor-scoped entry flows

### Get set up in 5 minutes — hand it to an AI

The fastest path is still to paste a setup prompt into Claude Code on the machine that will host RemoteLab. It can handle almost everything automatically and stop only for truly manual steps such as Cloudflare login.

**Prerequisites before you paste the prompt:**
- **macOS**: Homebrew installed + Node.js 18+
- **Linux**: Node.js 18+ + `dtach` + `ttyd` (the setup flow can install these)
- At least one AI tool installed (`claude`, `codex`, `cline`, or a compatible local tool)
- A domain pointed at Cloudflare ([free account](https://cloudflare.com), domain ~$1–12/yr from Namecheap or Porkbun)

**Copy this prompt into Claude Code:**

```text
I want to set up RemoteLab on this machine so I can control AI coding tools from my phone.

My domain: [YOUR_DOMAIN]
Subdomain I want to use: [SUBDOMAIN]

Please follow the full setup guide at docs/setup.md in this repository.
Do every step you can automatically.
When you hit a [HUMAN] step, stop and tell me exactly what to do.
After I confirm each manual step, continue to the next phase.
```

If you prefer a manual walkthrough, use `docs/setup.md`.

### What you'll have when done

Open `https://[subdomain].[domain]/?token=YOUR_TOKEN` on your phone:

![Dashboard](docs/new-dashboard.png)

- create a session with a local AI tool
- start from `~` by default, or point the agent at another repo when needed
- send messages while the UI re-fetches canonical HTTP state in the background
- leave and come back later without losing the conversation thread
- share immutable read-only snapshots of a session
- optionally configure App-based visitor flows and push notifications

### Daily usage

Once set up, the service can auto-start on boot (macOS LaunchAgent / Linux systemd). Open the URL on your phone and work from there.

```bash
remotelab start
remotelab stop
remotelab restart chat
```

## Documentation map

If you are refreshing yourself after several architecture iterations, use this reading order:

1. `README.md` / `README.zh.md` — product overview, setup path, daily operations
2. `docs/project-architecture.md` — current shipped architecture and code map
3. `docs/README.md` — documentation taxonomy and sync rules
4. `notes/current/core-domain-contract.md` — current domain/refactor baseline
5. `notes/README.md` — note buckets and cleanup policy
6. focused guides such as `docs/setup.md`, `docs/external-message-protocol.md`, and `docs/creating-apps.md`

---

## Architecture at a glance

RemoteLab’s shipped architecture is now centered on a stable chat control plane, detached runners, and durable on-disk state.

| Service | Port | Role |
|---------|------|------|
| `chat-server.mjs` | `7690` | Primary chat/control plane for production use |
| `scripts/chat-instance.sh` → `chat-server.mjs` | `7692` | Restartable validation plane for self-hosting RemoteLab development |
| `auth-proxy.mjs` | `7681` | Frozen emergency terminal fallback |

```
Phone Browser
   │
   ▼
Cloudflare Tunnel
   │
   ▼
chat-server.mjs (:7690 / :7692)
   │
   ├── HTTP control plane
   ├── auth + policy
   ├── session/run orchestration
   ├── durable history + run storage
   ├── thin WS invalidation
   └── detached runners
```

Key architectural rules:

- `Session` is the primary durable object; `Run` is the execution object beneath it
- browser state always converges back to HTTP reads
- WebSocket is an invalidation channel, not the canonical transcript
- active work can recover after control-plane restarts because the durable state is on disk
- `7690` is the stable operator plane and `7692` is the restart-heavy validation plane when developing RemoteLab itself

For the full code map and flow breakdown, read `docs/project-architecture.md`.

For the canonical contract that external channels should follow, read `docs/external-message-protocol.md`.

---

## CLI Reference

```text
remotelab setup                Run interactive setup wizard
remotelab start                Start all services
remotelab stop                 Stop all services
remotelab restart [service]    Restart: chat | proxy | tunnel | all
remotelab chat                 Run chat server in foreground (debug)
remotelab server               Run auth proxy in foreground (debug)
remotelab generate-token       Generate a new access token
remotelab set-password         Set username & password login
remotelab --help               Show help
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_PORT` | `7690` | Chat server port |
| `LISTEN_PORT` | `7681` | Auth proxy port |
| `SESSION_EXPIRY` | `86400000` | Cookie lifetime in ms (24h) |
| `SECURE_COOKIES` | `1` | Set `0` only for local HTTP debugging |

## Common file locations

| Path | Contents |
|------|----------|
| `~/.config/remotelab/auth.json` | Access token + password hash |
| `~/.config/remotelab/auth-sessions.json` | Owner/visitor auth sessions |
| `~/.config/remotelab/chat-sessions.json` | Chat session metadata |
| `~/.config/remotelab/chat-history/` | Per-session event store (`meta.json`, `context.json`, `events/*.json`, `bodies/*.txt`) |
| `~/.config/remotelab/chat-runs/` | Durable run manifests, spool output, and final results |
| `~/.config/remotelab/apps.json` | App template definitions |
| `~/.config/remotelab/shared-snapshots/` | Immutable read-only session share snapshots |
| `~/.remotelab/memory/` | Private machine-specific memory used for pointer-first startup |
| `~/Library/Logs/chat-server.log` | Chat server stdout **(macOS)** |
| `~/Library/Logs/auth-proxy.log` | Auth proxy stdout **(macOS)** |
| `~/Library/Logs/cloudflared.log` | Tunnel stdout **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server stdout **(Linux)** |
| `~/.local/share/remotelab/logs/auth-proxy.log` | Auth proxy stdout **(Linux)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel stdout **(Linux)** |

## Security

- HTTPS via Cloudflare (TLS at the edge, localhost HTTP on the machine)
- `256`-bit random access token with timing-safe comparison
- optional scrypt-hashed password login
- `HttpOnly` + `Secure` + `SameSite=Strict` auth cookies
- per-IP rate limiting with exponential backoff on failed login
- services bind to `127.0.0.1` only — no direct external exposure
- share snapshots are read-only and isolated from the owner chat surface
- CSP headers with nonce-based script allowlist

## Troubleshooting

**Service won't start**

```bash
# macOS
tail -50 ~/Library/Logs/chat-server.error.log
tail -50 ~/Library/Logs/auth-proxy.error.log

# Linux
journalctl --user -u remotelab-chat -n 50
tail -50 ~/.local/share/remotelab/logs/chat-server.error.log
```

**DNS not resolving yet**

Wait `5–30` minutes after setup, then verify:

```bash
dig SUBDOMAIN.DOMAIN +short
```

**Port already in use**

```bash
lsof -i :7690
lsof -i :7681
```

**Restart a single service**

```bash
remotelab restart chat
remotelab restart proxy
remotelab restart tunnel
```

**Manage a disposable validation plane**

```bash
scripts/chat-instance.sh restart --port 7692 --name test
scripts/chat-instance.sh status --port 7692 --name test
scripts/chat-instance.sh logs --port 7692 --name test
```

---

## License

MIT

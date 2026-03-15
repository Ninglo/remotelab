# RemoteLab

[中文](README.zh.md) | English

Mobile-first control console for AI workers running on your own Mac or Linux machine.

Control CodeX (`codex`), Claude Code, Cline, and compatible local tools from a phone browser. RemoteLab is not a terminal emulator or mobile IDE; it is a durable chat/control plane that keeps sessions, runs, and history on disk.

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
- let the UI follow your system light/dark appearance automatically
- create immutable read-only share snapshots
- create App links for visitor-scoped entry flows

### Provider note

- RemoteLab now treats `CodeX` (`codex`) as the default built-in tool and shows it first in the picker.
- The main reason is policy clarity: API-key / local-CLI style integrations are usually a cleaner fit for a self-hosted control plane than consumer-login-based remote wrappers.
- `Claude Code` still works in RemoteLab, and Claude-flavored local setups that talk to other backends are a separate decision, but you should review the current provider terms yourself before routing any proprietary CLI through a third-party UI like RemoteLab.
- In practice, the risk is usually about the underlying provider auth / terms, not the binary name by itself. Make your own call based on the provider and account type behind that tool.

### Get set up in 5 minutes — hand it to an AI

The fastest path is still to paste a setup prompt into CodeX, Claude Code, or another capable coding agent on the machine that will host RemoteLab. It can handle almost everything automatically and stop only for truly manual steps such as Cloudflare login.

Configuration and feature-rollout docs in this repo are model-first and prompt-first: the human copies a prompt into their own AI coding agent, the agent gathers the needed context up front in as few rounds as possible, and the rest of the work stays inside that conversation except for explicit `[HUMAN]` steps.

The best pattern is one early handoff: the agent asks for everything it needs in one message, the human replies once, and then the agent keeps going autonomously until a true manual checkpoint or final completion.

**Prerequisites before you paste the prompt:**
- **macOS**: Homebrew installed + Node.js 18+
- **Linux**: Node.js 18+
- At least one AI tool installed (`codex`, `claude`, `cline`, or a compatible local tool)
- **Network** (pick one):
  - **Cloudflare Tunnel**: a domain pointed at Cloudflare ([free account](https://cloudflare.com), domain ~$1–12/yr from Namecheap or Porkbun)
  - **Tailscale**: [free for personal use](https://tailscale.com) — install on both phone and dev machine, join the same tailnet, no domain needed

**Copy this prompt into CodeX or another coding agent:**

```text
I want to set up RemoteLab on this machine so I can control AI coding tools from my phone.

Network mode: [cloudflare | tailscale]

# For Cloudflare mode:
My domain: [YOUR_DOMAIN]
Subdomain I want to use: [SUBDOMAIN]

# For Tailscale mode:
(No extra config needed — both phone and dev machine are on the same tailnet.)

Please follow the full setup guide at docs/setup.md in this repository.
Keep the workflow inside this chat.
Before you start work, collect every missing piece of context in one message so I can answer once.
Do every step you can automatically.
After my reply, continue autonomously and only stop for real [HUMAN] steps, approvals, or final completion.
When you stop, tell me exactly what I need to do and how you'll verify it after I reply.
```

If you want the full setup contract and the human-only checkpoints, use `docs/setup.md`.

### What you'll have when done

Open your RemoteLab URL on your phone:
- **Cloudflare**: `https://[subdomain].[domain]/?token=YOUR_TOKEN`
- **Tailscale**: `http://[hostname].[tailnet].ts.net:7690/?token=YOUR_TOKEN`

![Dashboard](docs/new-dashboard.png)

- create a session with a local AI tool, with CodeX first by default
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
6. focused guides such as `docs/setup.md`, `docs/external-message-protocol.md`, `docs/creating-apps.md`, and `docs/feishu-bot-setup.md`

---

## Architecture at a glance

RemoteLab’s shipped architecture is now centered on a stable chat control plane, detached runners, and durable on-disk state.

| Service | Port | Role |
|---------|------|------|
| `chat-server.mjs` | `7690` | Primary chat/control plane for production use |

```
Phone Browser                          Phone Browser
   │                                      │
   ▼                                      ▼
Cloudflare Tunnel                    Tailscale (VPN)
   │                                      │
   ▼                                      ▼
chat-server.mjs (:7690)             chat-server.mjs (:7690)
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
- `7690` is the shipped chat/control plane; restart recovery now removes the need for a permanent second validation service

For the full code map and flow breakdown, read `docs/project-architecture.md`.

For the canonical contract that external channels should follow, read `docs/external-message-protocol.md`.

---

## CLI Reference

```text
remotelab setup                Run interactive setup wizard
remotelab start                Start all services
remotelab stop                 Stop all services
remotelab restart [service]    Restart: chat | tunnel | all
remotelab chat                 Run chat server in foreground (debug)
remotelab generate-token       Generate a new access token
remotelab set-password         Set username & password login
remotelab --help               Show help
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_HOST` | `127.0.0.1` | Listen address; set `0.0.0.0` for Tailscale / LAN access |
| `CHAT_PORT` | `7690` | Chat server port |
| `SESSION_EXPIRY` | `86400000` | Cookie lifetime in ms (24h) |
| `SECURE_COOKIES` | `1` | Set `0` for Tailscale or local HTTP access (no HTTPS) |
| `REMOTELAB_LIVE_CONTEXT_COMPACT_TOKENS` | `window overflow` | Optional auto-compact override in live-context tokens; unset = compact only after live context exceeds 100% of a known context window, `Inf` = disable |

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
| `~/Library/Logs/cloudflared.log` | Tunnel stdout **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server stdout **(Linux)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel stdout **(Linux)** |

## Storage growth and manual cleanup

- RemoteLab is durability-first: session history, run output, artifacts, and logs accumulate on disk over time.
- Archiving a session is organizational only. It hides the session from the active list, but it does **not** delete the stored history or run data behind it.
- On long-lived installs, storage can grow materially, especially if you keep long conversations, large tool outputs, heavy reasoning traces, or generated artifacts.
- RemoteLab does **not** automatically delete old data and does **not** currently ship a one-click cleanup feature. This is intentional: keeping user data is safer than guessing what is safe to remove.
- If you want to reclaim disk space, periodically review old archived sessions and prune them manually from the terminal, or ask an AI operator to help you clean them up carefully.
- In practice, most storage growth lives under `~/.config/remotelab/chat-history/` and `~/.config/remotelab/chat-runs/`.

## Security

- **Cloudflare mode**: HTTPS via Cloudflare (TLS at the edge, localhost HTTP on the machine); services bind to `127.0.0.1` only
- **Tailscale mode**: traffic encrypted by Tailscale's WireGuard mesh; services bind to `0.0.0.0` (all interfaces), so the port is also reachable from LAN/WAN — on untrusted networks, configure a firewall to restrict port `7690` to the Tailscale subnet (e.g. `100.64.0.0/10`)
- `256`-bit random access token with timing-safe comparison
- optional scrypt-hashed password login
- `HttpOnly` + `Secure` + `SameSite=Strict` auth cookies (`Secure` disabled in Tailscale mode)
- per-IP rate limiting with exponential backoff on failed login
- share snapshots are read-only and isolated from the owner chat surface
- CSP headers with nonce-based script allowlist

## Troubleshooting

**Service won't start**

```bash
# macOS
tail -50 ~/Library/Logs/chat-server.error.log

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
```

**Restart a single service**

```bash
remotelab restart chat
remotelab restart tunnel
```

---

## License

MIT

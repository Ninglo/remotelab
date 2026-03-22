# RemoteLab

[中文](README.zh.md) | English

**The AI workbench for super-individuals.**

RemoteLab exists to maximize the efficiency of human-AI collaboration for people who already use AI seriously — and for the larger class of AI-native super-individuals that will emerge next.

It does not care much whether the control surface is a phone, tablet, or desktop. The point is to give the human the highest-leverage way to direct AI work while strong executors like `codex`, `claude`, and compatible local tools do the heavy lifting on a real machine.

![RemoteLab across surfaces](docs/readme-multisurface-demo.png)

> Current baseline: `v0.3` — owner-first session orchestration, durable on-disk history, executor adapters, App-based workflow packaging, and a no-build web UI that works across phone and desktop.

> Reach the same system from desktop, phone, and integration surfaces like Feishu or email-driven flows.

## Quick install

If the demo makes sense, do not keep reading. Open a fresh terminal on the host machine, start Codex, Claude Code, or another coding agent, and paste this:

```text
I want to set up RemoteLab on this machine so I can control AI workers from any device and keep long-running AI work organized.

Network mode: [cloudflare | tailscale]

# For Cloudflare mode:
My domain: [YOUR_DOMAIN]
Subdomain I want to use: [SUBDOMAIN]

# For Tailscale mode:
(No extra config needed — the host machine and the client devices I want to use are on the same tailnet.)

Use the setup contract at `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md` as the source of truth.
Do not assume the repo is already cloned. If `~/code/remotelab` does not exist yet, fetch that contract, clone `https://github.com/Ninglo/remotelab.git` yourself, and continue.
Keep the workflow inside this chat.
Before you start work, collect every missing piece of context in one message so I can answer once.
Do every step you can automatically.
After my reply, continue autonomously and only stop for real [HUMAN] steps, approvals, or final completion.
When you stop, tell me exactly what I need to do and how you'll verify it after I reply.
```

Need the longer version first? Jump to [Setup details](#setup-details) or open `docs/setup.md`.

---

## For Humans

### Vision

If you want the blunt version, RemoteLab is an AI IDE workbench for future super-individuals: people who can use AI so well that their personal leverage compounds far beyond that of a normal individual.

The goal is simple: find the most effective interaction shape between humans and increasingly autonomous agents, then turn that interaction shape into a product that materially increases real-world productivity.

### Core judgments

- Task scope keeps expanding: from minutes, to hours, to days, and eventually even week-scale work.
- Concurrency becomes default: to fully use AI, people will run many agents in parallel.
- Human memory becomes a bottleneck: when a task finishes hours later, the human needs fast context recovery, not raw logs.
- Project orchestration becomes personal infrastructure: people need help managing priority, blockers, and follow-ups across many concurrent threads.
- Super-individuals will want distribution: once a workflow works, they will want to package it and let other people use it too.

### What RemoteLab is

- an AI workbench that sits above strong executors running on a real machine
- a project and orchestration layer for concurrent agent work
- an external memory / context-recovery system for long-running sessions
- a packaging and distribution layer for agentic-native apps
- an endpoint-flexible web product rather than a phone-only or desktop-only experience

### What RemoteLab is not

- a terminal emulator
- a traditional editor-first IDE
- a generic multi-user chat SaaS
- a closed all-in-one executor stack trying to out-execute `codex` or `claude`

### Two core product layers

1. **Orchestration above single-task executors.** RemoteLab helps the user manage the full portfolio of ongoing work above tools like `Codex` or `Claude Code`: more concurrency, clearer progress, faster context recovery, better attention allocation, and better final quality.
2. **Agentic-native app building and distribution.** RemoteLab gives super-individuals a low-friction way to turn their own SOPs into distributable agentic-native workflows — whether the surface is a built-in web UI, an external bot, or another frontend.

### Product grammar

The current product model is intentionally simple:

- `Session` — the durable work thread
- `Run` — one execution attempt inside a session
- `App` — a reusable workflow / policy package for starting sessions
- `Share snapshot` — an immutable read-only export of a session

The architectural assumptions behind that model:

- HTTP is the canonical state path and WebSocket only hints that something changed
- the browser is a control surface, not the system of record
- runtime processes are disposable; durable state lives on disk
- the product is single-owner first, with visitor access scoped through `Apps`
- the frontend stays framework-light and endpoint-flexible

### Why this boundary matters

RemoteLab is opinionated in a few ways:

- **Do not rebuild the executor layer.** RemoteLab should not spend most of its energy optimizing single-task agent internals.
- **Recover context, do not dump logs.** Durable sessions matter more than raw terminal continuity.
- **Package workflows, do not just share prompts.** `Apps` are reusable operating shapes, not just copy-pasted text.
- **Integrate the strongest tools, keep them replaceable.** The point is a stable abstraction layer so better executors can be adopted quickly as the ecosystem evolves.

### What you can do

- start a session from phone or desktop while the agent works on your real machine
- keep durable history even if the browser disconnects
- recover long-running work after control-plane restarts
- let the agent auto-title and auto-group sessions in the sidebar
- paste screenshots directly into the chat
- let the UI follow your system light/dark appearance automatically
- create immutable read-only share snapshots
- create App links for visitor-scoped entry flows

### Provider note

- RemoteLab treats `Codex` (`codex`) as the default built-in tool and shows it first in the picker.
- That is not because executor choice is the product. The opposite is true: RemoteLab should stay adapter-first and integrate the strongest executors available locally.
- API-key / local-CLI style integrations are usually a cleaner fit for a self-hosted control plane than consumer-login-based remote wrappers.
- `Claude Code` still works in RemoteLab, and any other compatible local tool can fit as long as its auth and terms work for your setup.
- Over time, the goal is portability across executors, not loyalty to one closed runtime.
- In practice, the main risk is usually the underlying provider auth / terms, not the binary name by itself. Make your own call based on the provider and account type behind that tool.

### Setup details

The fastest path is still to paste a setup prompt into Codex, Claude Code, or another capable coding agent on the machine that will host RemoteLab. It can handle almost everything automatically and stop only for truly manual steps such as Cloudflare login when that mode is in play.

Configuration and feature-rollout docs in this repo are model-first and prompt-first: the human copies a prompt into their own AI coding agent, the agent gathers the needed context up front in as few rounds as possible, and the rest of the work stays inside that conversation except for explicit `[HUMAN]` steps.

The best pattern is one early handoff: the agent asks for everything it needs in one message, the human replies once, and then the agent keeps going autonomously until a true manual checkpoint or final completion.

**Prerequisites before you paste the prompt:**
- **macOS**: Homebrew installed + Node.js 18+
- **Linux**: Node.js 18+
- At least one AI tool installed (`codex`, `claude`, `cline`, or a compatible local tool)
- **Network** (pick one):
  - **Cloudflare Tunnel**: a domain pointed at Cloudflare ([free account](https://cloudflare.com), domain ~$1–12/yr from Namecheap or Porkbun)
  - **Tailscale**: [free for personal use](https://tailscale.com) — install on the host machine and any client device you want to use, join the same tailnet, no domain needed

**Open a fresh terminal on the host machine, start Codex or another coding agent, and paste this:**

```text
I want to set up RemoteLab on this machine so I can control AI workers from any device and keep long-running AI work organized.

Network mode: [cloudflare | tailscale]

# For Cloudflare mode:
My domain: [YOUR_DOMAIN]
Subdomain I want to use: [SUBDOMAIN]

# For Tailscale mode:
(No extra config needed — the host machine and the client devices I want to use are on the same tailnet.)

Use the setup contract at `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md` as the source of truth.
Do not assume the repo is already cloned. If `~/code/remotelab` does not exist yet, fetch that contract, clone `https://github.com/Ninglo/remotelab.git` yourself, and continue.
Keep the workflow inside this chat.
Before you start work, collect every missing piece of context in one message so I can answer once.
Do every step you can automatically.
After my reply, continue autonomously and only stop for real [HUMAN] steps, approvals, or final completion.
When you stop, tell me exactly what I need to do and how you'll verify it after I reply.
```

If you want the full setup contract and the human-only checkpoints, use `docs/setup.md`.

### What you'll have when done

Open your RemoteLab URL on the device you want to use:
- **Cloudflare**: `https://[subdomain].[domain]/?token=YOUR_TOKEN`
- **Tailscale**: `http://[hostname].[tailnet].ts.net:7690/?token=YOUR_TOKEN`

![Dashboard](docs/new-dashboard.png)

- create a session with a local AI tool, with Codex first by default
- start from `~` by default, or point the agent at another repo when needed
- send messages while the UI re-fetches canonical HTTP state in the background
- leave and come back later without losing the conversation thread
- share immutable read-only snapshots of a session
- optionally configure App-based visitor flows and push notifications

### Daily usage

Once set up, the service can auto-start on boot (macOS LaunchAgent / Linux systemd). Open the URL from phone or desktop and work from there.

```bash
remotelab start
remotelab stop
remotelab release
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
Browser / client surface               Browser / client surface
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
remotelab release              Run tests, snapshot the runtime, restart, and health-check the active release
remotelab chat                 Run chat server in foreground (debug)
remotelab generate-token       Generate a new access token
remotelab set-password         Set username & password login
remotelab --help               Show help
```

Production updates should go through `remotelab release` rather than live-editing the running `7690` surface. The release command snapshots the shipped runtime, restarts only after the test gate passes, and automatically restores the previous active release if the health check fails.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_PORT` | `7690` | Chat server port |
| `CHAT_BIND_HOST` | `127.0.0.1` | Host to bind the chat server (`127.0.0.1` for Cloudflare/local only, `0.0.0.0` for Tailscale or LAN access) |
| `SESSION_EXPIRY` | `86400000` | Cookie lifetime in ms (24h) |
| `SECURE_COOKIES` | `1` | Set `0` for Tailscale or local HTTP access (no HTTPS) |
| `REMOTELAB_INSTANCE_ROOT` | unset | Optional isolated data root for an additional instance; defaults to `<root>/config` + `<root>/memory` when set |
| `REMOTELAB_CONFIG_DIR` | `~/.config/remotelab` | Optional runtime data/config override for auth, sessions, runs, apps, push, and provider-managed homes |
| `REMOTELAB_MEMORY_DIR` | `~/.remotelab/memory` | Optional user-memory override for pointer-first startup files |
| `REMOTELAB_LIVE_CONTEXT_COMPACT_TOKENS` | `window overflow` | Optional auto-compact override in live-context tokens; unset = compact only after live context exceeds 100% of a known context window, `Inf` = disable |

## Common file locations

These are the default paths when no instance overrides are set.

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

## Ad-hoc extra instances

- `scripts/chat-instance.sh` now supports `--instance-root`, `--config-dir`, and `--memory-dir` in addition to the older `--home` mode.
- Use `--instance-root` when you want a second instance to keep the same machine `HOME` (so provider auth keeps working) while isolating RemoteLab's own runtime data and memory.
- Example: `scripts/chat-instance.sh start --port 7692 --name companion --instance-root ~/.remotelab/instances/companion --secure-cookies 1`

## Security

- **Cloudflare mode**: HTTPS via Cloudflare (TLS at the edge, localhost HTTP on the machine); services bind to `127.0.0.1` only
- **Tailscale mode**: traffic encrypted by Tailscale's WireGuard mesh; services bind to `0.0.0.0` (all interfaces), so the port is also reachable from LAN/WAN — on untrusted networks, configure a firewall to restrict port `7690` to the Tailscale subnet (e.g. `100.64.0.0/10`)
- `256`-bit random access token with timing-safe comparison
- optional scrypt-hashed password login
- `HttpOnly` + `Secure` + `SameSite=Strict` auth cookies (`Secure` disabled in Tailscale mode)
- per-IP rate limiting with exponential backoff on failed login
- default: services bind to `127.0.0.1` only — no direct external exposure; set `CHAT_BIND_HOST=0.0.0.0` for LAN access
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

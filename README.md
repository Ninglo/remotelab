# RemoteLab

[中文](README.zh.md) | English

**A cross-surface AI workbench that helps ordinary people hand repetitive digital work to AI.**

RemoteLab is not only for the small group of people who already know how to use AI well. The goal is to bring AI automation to a much wider set of users, especially people with lots of repetitive digital work but no engineering automation background.

It does not care much whether the control surface is a phone, tablet, or desktop. The point is to let a user hand over a messy recurring task, screenshot, or sample file, have the AI clarify the problem first, and then let strong executors like `codex`, `claude`, and compatible local tools do the real work on a real machine.

![RemoteLab across surfaces](docs/readme-multisurface-demo.png)

> Current baseline: `v0.3` — an owner-first session runtime, durable on-disk history, executor adapters, App-based workflow packaging, and a no-build web UI that works across phone and desktop.

> Reach the same system from desktop, phone, and integration surfaces like Feishu or email-driven flows.

## Quick install

If the demo makes sense, do not keep reading. Open a fresh terminal on the host machine, start Codex, Claude Code, or another coding agent, and paste this:

```text
I want to set up RemoteLab on this machine so I can hand repetitive digital work to AI from any device and let it automate the work on a real computer.

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

Bluntly: RemoteLab is an AI automation workbench for ordinary people. It should first serve people who have repetitive digital work but have not yet turned AI into part of their daily operating flow.

The first goal is concrete: in a short conversation, help a user hand off a tedious job that used to cost hours every week — data cleanup, light analysis, report generation, file batch work, exports/imports, triggered notifications, and other scriptable chores.

### Core judgments

- The biggest unmet need is not encouraging people to open endless concurrent sessions; it is finding repetitive work that is actually worth automating.
- Most target users are not AI-native operators and do not arrive with product-manager-grade prompts; the AI needs to help clarify the task, gather examples, and design a workable approach.
- The product should absorb most of the operational complexity: tool choice, model choice, session structure, and machine-side execution are implementation details unless the user explicitly needs to care.
- The first high-fit user slice is not literally everyone with a computer; it looks more like time-pressed middle managers / owner-operators in traditional industries who both coordinate others and still personally carry repetitive digital admin work.
- The first screen cannot be a blank session list. New users need a default `Welcome App` that briefly explains what RemoteLab can do, asks about their role and repetitive-work pain point, and guides them toward one concrete first automation.
- The best wedge is simple, fast-payback digital work: data cleanup, analysis, file processing, reports, notifications, and other repetitive scriptable tasks.
- Phone + desktop + real-machine execution is the product advantage: capture context anywhere, let the machine do the heavy work, and review results or approvals from the most convenient device.
- `Session`, `App`, concurrency, and distribution still matter, but they are enabling layers or later multipliers rather than the first headline.

### What RemoteLab is

- an AI automation workbench that sits above strong executors running on a real machine
- an AI collaboration entry point that helps users turn vague problems into executable plans
- a cross-surface control plane where people can start from phone, continue from desktop, and let the machine do the work
- a durable work-thread system that helps humans recover context instead of repeatedly re-explaining the task
- a packaging layer that can turn proven automations into reusable `Apps`

### What RemoteLab is not

- a terminal emulator
- a traditional editor-first IDE
- a power-user cockpit whose main value is opening as many concurrent sessions as possible
- a prompt playground that assumes the user already knows how to specify the work perfectly
- a generic multi-user chat SaaS
- a product that assumes remote users can browse the host machine or fetch results from local paths
- a closed all-in-one executor stack trying to out-execute `codex` or `claude`

### Two core product layers

1. **First, solve repetitive digital work.** RemoteLab should accept a messy but recurring task, help the user clarify inputs, outputs, and constraints, and turn it into an automation that reliably saves time.
2. **Then package and reuse what works.** Once an automation proves valuable, RemoteLab can turn it into an `App`, template, or other reusable entry point for the same user or nearby user groups.

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

- **Clarify the problem before executing.** RemoteLab should not assume the user already thinks like an AI product manager; the AI needs to carry part of the problem-framing and solution-design work.
- **Deliver through reachable surfaces, not host paths.** The AI may operate the machine, but the user collaborates through RemoteLab and explicitly exposed product surfaces. A result that only exists on the host is not a finished handoff.
- **Do not rebuild the executor layer.** RemoteLab should not spend most of its energy optimizing single-task agent internals.
- **Recover context, do not dump logs.** Durable sessions matter more than raw terminal continuity.
- **Package workflows, do not just share prompts.** `Apps` are reusable operating shapes, not just copy-pasted text.
- **Integrate the strongest tools, keep them replaceable.** The point is a stable abstraction layer so better executors can be adopted quickly as the ecosystem evolves.

### What you can do

- start a session from phone or desktop while the agent works on your real machine
- download returned files directly from chat when a workflow publishes result assets
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
I want to set up RemoteLab on this machine so I can hand repetitive digital work to AI from any device and let it automate the work on a real computer.

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
remotelab guest-instance       Create isolated guest instances with separate config + memory
remotelab chat                 Run chat server in foreground (debug)
remotelab generate-token       Generate a new access token
remotelab set-password         Set username & password login
remotelab --help               Show help
```

For the fixed trial-user flow, prefer `remotelab guest-instance create-trial`. It auto-picks the next standard `trialN` name, allocates the next safe port, wires the Cloudflare hostname/tunnel ingress, and syncs the instance mailbox when the mailbox worker is already configured. Use `remotelab guest-instance create <name>` only when you intentionally want a custom instance name. If the agent mailbox is initialized, `create`, `create-trial`, and `show` also print the default inbound mailbox for that instance, such as `rowan+trial4@example.com` or `trial4@example.com`, depending on the mailbox identity's `instanceAddressMode`. When the Cloudflare mailbox worker is already configured, creation attempts the Email Routing sync automatically so each new instance gets a live inbound address by default; pass `--no-mailbox-sync` only when you explicitly want to skip that step.

For day-to-day operator use, keep the workflow to a few stable commands instead of ad-hoc inspection:

```text
remotelab guest-instance create-trial      # create the next standard trial instance
remotelab guest-instance links             # print tokenized share links for every guest instance
remotelab guest-instance links trial24     # print tokenized share links for one instance
remotelab guest-instance links --check     # same, plus current local/public reachability
remotelab guest-instance converge --all    # repoint all guest instances at the current source tree
```

If you keep a path-prefixed mainland mirror such as `https://jojotry.nat100.top/<instance>/`, store its shared base URL in `~/.config/remotelab/guest-instance-defaults.json`:

```json
{
  "mainlandBaseUrl": "https://jojotry.nat100.top"
}
```

After that, `remotelab guest-instance create`, `create-trial`, `show`, and `links` automatically print both the regular public link and the mainland-prefixed access link. Use `links` when you want the whole current inventory without manually checking one instance at a time. To keep the path router itself versioned instead of living only in a home-directory script, use `scripts/natapp-dual-proxy.mjs` as the launch-agent target for the mainland bridge service.

The mainland bridge should stay prefix-only: every product surface lives under `https://<mainland-base>/<name>/`, including the main owner service (default `https://<mainland-base>/owner/`, local port `7690`). The bare root is now only a neutral route index so the bridge does not silently repoint an established product path. Use `NATAPP_MAINLAND_SERVICE_NAME` / `NATAPP_MAINLAND_SERVICE_PORT` to rename or repoint the main service prefix. Legacy `NATAPP_OWNER_ROUTE_PREFIX` / `NATAPP_OWNER_UPSTREAM_PORT` are still accepted as compatibility aliases. See [docs/mainland-routing.md](docs/mainland-routing.md) for the routing rules and cleanup rationale.

If you still have older instance-specific runtime copies such as `remotelab-trial-runtime`, run `remotelab guest-instance converge <name>` or `remotelab guest-instance converge --all`. It keeps the same port, hostname, auth, config, and memory directories, but repoints the launch agent back to the current `~/code/remotelab` source tree so future code updates land everywhere without changing the user-facing link.

If you want public inbound email per guest instance, prefer Cloudflare Email Routing into the Email Worker rather than creating separate mailbox accounts. `node scripts/agent-mail-cloudflare-routing.mjs status` prints the desired routing shape, `sync` backfills older instances that predate automatic provisioning, and `probe --address <email>` verifies whether SMTP will currently accept a guest mailbox such as `trial6@example.com`.

RemoteLab now boots the current source tree directly after restart. Use `remotelab restart chat` when the owner surface should pick up shared-code changes; guest instances that already point at the shared source tree pick up the same changes on their next restart.

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

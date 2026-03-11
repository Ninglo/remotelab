# AGENTS.md — RemoteLab Project Context

> Canonical repo-local AI context lives here. Keep tool-specific files like `CLAUDE.md` only as thin compatibility shims that point back to this file.

> **Read this file first.** It gives you everything you need to work on this project without exploring blindly.
> For deep-dive topics, reference docs are linked at the bottom.

---

## What Is RemoteLab

A web app that lets users control AI coding tools (Claude Code, Codex) from a phone browser. The user is on mobile, the AI agent runs on their macOS/Linux machine.

**Not** a terminal emulator, IDE, or chatbot. It's a **control console for AI workers** — the user gives intent, the AI executes.

- Single owner, not multi-user
- Node.js, no external frameworks (only `ws` for WebSocket)
- Vanilla JS frontend, no build tools

---

## Architecture

```
Phone Browser ──HTTPS──→ Cloudflare Tunnel ──→ chat-server.mjs (:7690)
                                                    │
                                      HTTP control plane + WS hints
                                                    │
                                      durable history + run state
                                            │
                                 detached runners normalize back to HTTP
```

### Chat Architecture

| Service | Port | Domain | Role |
|---------|------|--------|------|
| `chat-server.mjs` | **7690** | production chat domain | **Primary** — the shipped owner chat/control plane |

**Dev workflow**: use the normal `7690` service as the single chat/control plane. RemoteLab now relies on clean restart recovery rather than a separate permanent validation plane.

**Self-hosting rule**: restarting the active chat server is acceptable when needed because runs reconcile back from durable state. Treat restart as a transport interruption with logical recovery, not as a reason to maintain a second permanent chat plane. Manual extra instances remain optional ad-hoc debugging tools only. See `notes/current/self-hosting-dev-restarts.md`.

---

## File Structure

```
remotelab/
├── chat-server.mjs          # PRIMARY entry point (HTTP server, port 7690)
├── cli.js                   # CLI entry: `remotelab start|stop|restart|setup|...`
├── generate-token.mjs       # Generate 256-bit access tokens
├── set-password.mjs         # Set password-based auth
│
├── chat/                    # ── Chat service modules ──
│   ├── router.mjs           # All HTTP routes & API endpoints (538 lines)
│   ├── session-manager.mjs  # Canonical session/run orchestration + reconciliation
│   ├── process-runner.mjs   # Tool invocation helpers + runtime adapters
│   ├── runs.mjs             # Durable run metadata/result/spool storage
│   ├── runner-supervisor.mjs # Detached runner launcher
│   ├── runner-sidecar.mjs   # Thin detached executor writing raw spool/status/result
│   ├── ws.mjs               # WebSocket invalidation channel only
│   ├── summarizer.mjs       # AI-driven session label suggestions (title/group/description)
│   ├── apps.mjs             # App (template) CRUD & persistence (89 lines)
│   ├── system-prompt.mjs    # Build system context injected into AI sessions (83 lines)
│   ├── normalizer.mjs       # Convert tool output → standard event format (45 lines)
│   ├── middleware.mjs        # Auth checks, rate limiting, IP detection (80 lines)
│   ├── push.mjs             # Web push notifications (83 lines)
│   ├── models.mjs           # Available LLM models per tool (46 lines)
│   ├── history.mjs          # Canonical append-only per-event history + externalized bodies
│   └── adapters/
│       ├── claude.mjs       # Claude Code CLI output parser (201 lines)
│       └── codex.mjs        # Codex CLI output parser (207 lines)
│
├── lib/                     # ── Shared modules (used by both services) ──
│   ├── auth.mjs             # Token/password verification, session cookies
│   ├── config.mjs           # Environment variables, paths, defaults
│   ├── tools.mjs            # CLI tool discovery (which), custom tool registration
│   ├── utils.mjs            # Utilities (read body, path handling)
│   ├── git-diff.mjs         # Git diff retrieval
│   └── cloudflared-config.mjs # Access-domain selection from cloudflared ingress
│
├── static/                  # ── Frontend assets ──
│   ├── chat.js              # Backward-compatible loader for split chat frontend assets
│   ├── chat/                # Chat frontend split by concern (bootstrap / data / realtime / UI)
│   ├── marked.min.js        # Markdown renderer
│   ├── sw.js                # Service Worker (PWA)
│   └── manifest.json        # PWA metadata
│
├── templates/               # ── HTML templates ──
│   ├── chat.html            # Chat UI (primary, 765 lines)
│   ├── login.html           # Login page (194 lines)
│   └── share.html           # Read-only shared snapshot view
│
├── docs/                    # User-facing documentation
├── notes/                   # Internal design & product thinking
├── tests/                   # Scenario-style validation scripts
└── memory/system.md         # System-level memory (shared, in repo)
```

### Data Storage

All runtime data lives in `~/.config/remotelab/`:

| File | Content |
|------|---------|
| `auth.json` | Access token + password hash |
| `chat-sessions.json` | All session metadata |
| `chat-history/` | Per-session event store (`meta.json`, `context.json`, `events/*.json`, `bodies/*.txt`) |
| `apps.json` | App definitions (templates) |

---

## API Endpoints (chat-server)

### Auth
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/login` | Login page |
| POST | `/login` | Authenticate (token or password) |
| GET | `/logout` | Clear session |
| GET | `/api/auth/me` | Current user info (role: owner\|visitor) |

### Sessions
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List all sessions (active + archived) |
| POST | `/api/sessions` | Create new session |
| PATCH | `/api/sessions/{id}` | Update session metadata (`name`, `archived`) |

### Apps (Owner only)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/apps` | List all apps |
| POST | `/api/apps` | Create app |
| PATCH | `/api/apps/{id}` | Update app |
| DELETE | `/api/apps/{id}` | Delete app |
| GET | `/app/{shareToken}` | Visitor entry (public, no auth) |

### Tools & Models
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tools` | Available AI tools |
| GET | `/api/models` | Models per tool |

### Other
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/browse?path=` | Browse directories |
| GET | `/api/autocomplete?q=` | Path autocomplete |
| GET | `/api/push/vapid-public-key` | Web push public key |
| POST | `/api/push/subscribe` | Register push subscription |
| WebSocket | `/ws` | Invalidation-only hints |

---

## Key Product Concepts

### Sessions
Unit of work = one chat conversation with one AI tool. Persisted across disconnects. Resume IDs (`claudeSessionId`, `codexThreadId`) stored in metadata so AI context survives server restarts.

### Apps (Templates)
Reusable AI workflows shareable via link. Each App defines: name, systemPrompt, skills, tool. When a Visitor clicks the share link → auto-creates a scoped Session with the App's system prompt injected.

### Owner / Visitor Model
- **Owner**: Full access. Logs in with token or password.
- **Visitor**: Accesses only a specific App via share link. Sees chat-only UI (no sidebar). Each Visitor gets an independent Session. This is NOT multi-user — Visitors are scoped guests.

### Session Labeling
`summarizer.mjs` now exists to suggest canonical session presentation metadata — `title`, `group`, and hidden `description` — without owning any separate Progress state. The `Progress` tab remains only as an empty UI shell reserved for future surfaces.

### Memory System (Pointer-First)
- **Storage tiers** still matter:
  - System-level (`memory/system.md` in repo): universal learnings shared across deployments
  - User-level (`~/.remotelab/memory/`): machine-specific knowledge, private
- **Activation layers** matter just as much:
  - `bootstrap.md`: tiny startup index
  - `projects.md`: project pointer catalog
  - `tasks/` and deeper docs: load only after task scope is clear
- Goal: large total memory on disk, small relevant context in-session

---

## Security

- **Token**: 256-bit random hex, timing-safe comparison
- **Password**: scrypt-hashed alternative
- **Cookies**: HttpOnly + Secure + SameSite=Strict, 24h expiry
- **Rate limiting**: Exponential backoff on login failures (max 15min)
- **Network**: Services listen on 127.0.0.1 only; external access via Cloudflare Tunnel
- **CSP**: Nonce-based script allowlist
- **Input validation**: Tool commands reject shell metacharacters

---

## Hard Constraints (Non-Negotiable)

1. **Single shipped chat plane** — keep the shipped architecture centered on the primary `7690` chat-server unless a new operator surface is explicitly reintroduced
2. **No external frameworks** — Node.js built-ins + `ws` only
3. **Restart-safe recovery** — prefer durable restart/reload recovery over maintaining a permanent second chat plane
4. **Vanilla JS frontend** — no build tools, no framework
5. **Every change = new commit** — never use `--amend`, only new commits
6. **Single Owner** — no multi-user auth infrastructure
7. **Agent-driven first** — new features prefer conversation/Skill over dedicated UI
8. **ES Modules** — `"type": "module"`, all `.mjs` files
9. **Template style** — `{{PLACEHOLDER}}` substitution, nonce-injected scripts

---

## Current Priorities

### Done (recent)
- [x] Owner/Visitor dual-role identity
- [x] App system (CRUD API, share tokens, visitor flow)
- [x] Resume ID persistence (survives server restarts)
- [x] Web push notifications

### P1 — Next Up
- [ ] Expose AI-controlled session presentation (`title`, `group`, `description`) via session APIs, then validate the AI-owned session UX and consolidate current project-session TODOs into one dedicated prioritization session
- [ ] Universal control inbox / dispatcher session — a default high-trust chat surface that captures requests, routes substantial work into linked child sessions, and returns session/status links instead of bloating one long thread
- [ ] Reintroduce task-progress management through session-list grouping rather than reviving a separate Progress summary board; the empty tab shell can host a future Settings or related surface later
- [ ] Skills framework (file storage + loading mechanism)
- [ ] Provider registry abstraction — open model selection, local JS/JSON provider config, no more Claude/Codex-only model wiring
- [ ] Provider management UX — setup/settings should support preset enablement, simple GUI JSON providers, and advanced code mode
- [ ] Session metadata enrichment beyond presentation (`project`, `status`, `priority`, `tags`)
- [ ] Produce a precise file-level concept→implementation guide so future sessions can route directly to the right files with less repo spelunking

### P2 — Future
- [ ] Deferred triggers (AI-initiated actions, scheduled follow-ups)
- [ ] Queued follow-up composer buffer — while a session is still streaming a reply, let the user stage another message in a buffer and auto-submit it as a fresh turn immediately after the active response finishes; external connectors like Feishu should share the same staged-turn contract and later define an interrupt/replace policy
- [ ] Session fork follow-ups — extend the shipped hard-clone head-fork with optional `Fork from here`, lightweight lineage navigation, and exact historical fork support when compaction-safe snapshots exist
- [ ] Post-LLM output processing (layered output: decision / summary / details)
- [ ] Revisit product naming/brand and possible repo rename after the product philosophy is more mature; treat this as intentionally deferred while the product itself is still taking shape

---

## Reference Docs (for deep dives)

| Doc | Path | When to read |
|-----|------|-------------|
| Documentation Map | `docs/README.md` | Repo doc taxonomy: what lives in `docs/` vs `notes/` |
| Notes Map | `notes/README.md` | Note taxonomy: `current` vs `directional` vs `archive` vs `local` |
| Project Architecture | `docs/project-architecture.md` | Top-down map of the shipped system, code locations, runtime flows, and current-vs-direction split |
| Core Domain Contract | `notes/current/core-domain-contract.md` | Current domain/refactor baseline when deciding which product objects are canonical |
| External Message Protocol | `docs/external-message-protocol.md` | Canonical connector contract for email/GitHub/bot integrations using sessions, messages, runs, and events |
| Core Philosophy | `notes/directional/core-philosophy.md` | Historical philosophy note; use it for framing, not as the current implementation checklist |
| App-Centric Architecture | `notes/directional/app-centric-architecture.md` | Historical/consolidated direction note for treating default chat and shared Apps as one policy model |
| Provider Architecture | `notes/directional/provider-architecture.md` | Open provider/model abstraction, local JS/JSON extension path, migration plan |
| Product Vision | `notes/directional/product-vision.md` | Product rationale and open questions; not the canonical shipped-status tracker |
| AI-Driven Interaction | `notes/directional/ai-driven-interaction.md` | Deferred triggers design, session metadata schema, future phases |
| Autonomous Execution | `notes/directional/autonomous-execution.md` | P2 background execution vision |
| Message Transport Architecture | `notes/message-transport-architecture.md` | Historical transport/runtime rationale after the HTTP-first architecture landed |
| HTTP Runtime Phase 1 | `notes/archive/http-runtime-phase1.md` | Concrete implementation spec for the coordinated HTTP/control-plane + runner refactor |
| Memory Activation Architecture | `notes/current/memory-activation-architecture.md` | Pointer-first memory loading, routing layers, pruning rules |
| Creating Apps | `docs/creating-apps.md` | User-facing guide for App creation |
| Setup Guide | `docs/setup.md` | Installation, service setup (LaunchAgent/systemd) |
| System Memory | `memory/system.md` | Cross-deployment learnings (context continuity, testing strategy) |

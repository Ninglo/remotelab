# CLAUDE.md — RemoteLab Project Context

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
                                               WebSocket + HTTP API
                                                    │
                                            ┌───────┼───────┐
                                            ↓       ↓       ↓
                                     spawn claude  codex   (future tools)
                                            │
                                    parse output → stream events → frontend
```

### Three-Service Architecture (permanent)

| Service | Port | Domain | Role |
|---------|------|--------|------|
| `chat-server.mjs` | **7690** | `claude-v2.jiujianian-dev-world.win` | **Production** — stable, released |
| `chat-server.mjs` | **7692** | `ttest.jiujianian-dev-world.win` | **Test** — current development |
| `auth-proxy.mjs` | **7681** | `claude.jiujianian-dev-world.win` | **Emergency terminal** — FROZEN, never modify |

**Dev workflow**: keep two chat-server planes active. Do all coding/conversation work on `7690`, do restart-heavy validation on `7692`, and only restart/reload `7690` after `7692` is verified.

**Self-hosting rule**: maintain two distinct chat-server roles. `7690` is the coding/operator plane where the live development conversation happens; `7692` is the validation plane for restart/test checks and should avoid active coding work. Prefer restarting the other plane, not the one carrying the current conversation. After `7692` looks good, finish the current thought on `7690`, then restart/reload `7690` if needed. Fall back to `7681` only for emergencies. Manual dev instances should use `scripts/chat-instance.sh`. Restarted in-flight turns are recoverable via the UI `Resume` flow when resume metadata was captured. See `notes/self-hosting-dev-restarts.md`.

---

## File Structure

```
remotelab/
├── chat-server.mjs          # PRIMARY entry point (HTTP server, port 7690/7692)
├── auth-proxy.mjs           # Emergency terminal fallback (FROZEN — do not touch)
├── cli.js                   # CLI entry: `remotelab start|stop|restart|setup|...`
├── generate-token.mjs       # Generate 256-bit access tokens
├── set-password.mjs         # Set password-based auth
│
├── chat/                    # ── Chat service modules ──
│   ├── router.mjs           # All HTTP routes & API endpoints (538 lines)
│   ├── session-manager.mjs  # Session CRUD, lifecycle, message handling (511 lines)
│   ├── process-runner.mjs   # Spawn CLI tools, env setup, event streaming (277 lines)
│   ├── ws.mjs               # WebSocket connection management (243 lines)
│   ├── summarizer.mjs       # AI-driven session progress summaries for sidebar (248 lines)
│   ├── apps.mjs             # App (template) CRUD & persistence (89 lines)
│   ├── system-prompt.mjs    # Build system context injected into AI sessions (83 lines)
│   ├── normalizer.mjs       # Convert tool output → standard event format (45 lines)
│   ├── middleware.mjs        # Auth checks, rate limiting, IP detection (80 lines)
│   ├── push.mjs             # Web push notifications (83 lines)
│   ├── models.mjs           # Available LLM models per tool (46 lines)
│   ├── settings.mjs         # User preferences persistence (35 lines)
│   ├── history.mjs          # Chat history load/save (JSONL format) (40 lines)
│   └── adapters/
│       ├── claude.mjs       # Claude Code CLI output parser (201 lines)
│       └── codex.mjs        # Codex CLI output parser (207 lines)
│
├── lib/                     # ── Shared modules (used by both services) ──
│   ├── auth.mjs             # Token/password verification, session cookies
│   ├── config.mjs           # Environment variables, paths, defaults
│   ├── tools.mjs            # CLI tool discovery (which), custom tool registration
│   ├── utils.mjs            # Utilities (read body, path handling)
│   ├── templates.mjs        # HTML template loading
│   ├── git-diff.mjs         # Git diff retrieval
│   ├── router.mjs           # Terminal service routes (FROZEN)
│   ├── sessions.mjs         # Terminal service sessions (FROZEN)
│   └── proxy.mjs            # Terminal service proxy (FROZEN)
│
├── static/                  # ── Frontend assets ──
│   ├── chat.js              # Main frontend logic (1624 lines, vanilla JS)
│   ├── marked.min.js        # Markdown renderer
│   ├── sw.js                # Service Worker (PWA)
│   └── manifest.json        # PWA metadata
│
├── templates/               # ── HTML templates ──
│   ├── chat.html            # Chat UI (primary, 765 lines)
│   ├── login.html           # Login page (194 lines)
│   ├── dashboard.html       # Legacy dashboard (1299 lines, terminal era)
│   └── folder-view.html     # Legacy folder view (1986 lines, terminal era)
│
├── docs/                    # User-facing documentation
├── notes/                   # Internal design & product thinking
└── memory/system.md         # System-level memory (shared, in repo)
```

### Data Storage

All runtime data lives in `~/.config/remotelab/`:

| File | Content |
|------|---------|
| `auth.json` | Access token + password hash |
| `chat-sessions.json` | All session metadata |
| `chat-history/` | Per-session event logs (JSONL) |
| `sidebar-state.json` | Progress tracking state |
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
| GET | `/api/sessions` | List active sessions |
| POST | `/api/sessions` | Create new session |
| DELETE | `/api/sessions/{id}` | Archive session |
| GET | `/api/sessions/archived` | List archived sessions |
| POST | `/api/sessions/{id}/unarchive` | Restore archived session |

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
| GET | `/api/sidebar` | Progress tracking state |
| GET | `/api/settings` | Get user settings |
| PATCH | `/api/settings` | Update user settings |
| GET | `/api/browse?path=` | Browse directories |
| GET | `/api/autocomplete?q=` | Path autocomplete |
| GET | `/api/push/vapid-public-key` | Web push public key |
| POST | `/api/push/subscribe` | Register push subscription |
| WebSocket | `/ws` | Real-time messaging & events |

---

## Key Product Concepts

### Sessions
Unit of work = one chat conversation with one AI tool. Persisted across disconnects. Resume IDs (`claudeSessionId`, `codexThreadId`) stored in metadata so AI context survives server restarts.

### Apps (Templates)
Reusable AI workflows shareable via link. Each App defines: name, systemPrompt, skills, tool. When a Visitor clicks the share link → auto-creates a scoped Session with the App's system prompt injected.

### Owner / Visitor Model
- **Owner**: Full access. Logs in with token or password.
- **Visitor**: Accesses only a specific App via share link. Sees chat-only UI (no sidebar). Each Visitor gets an independent Session. This is NOT multi-user — Visitors are scoped guests.

### Sidebar (Progress Tracking)
Shows all active sessions' status at a glance. Powered by `summarizer.mjs` — after each AI turn completes (`onExit`), a separate one-shot LLM call summarizes the session state into `sidebar-state.json`. UI polls every 30s.

### Memory System (Two-Tier)
1. **System-level** (`memory/system.md` in repo): Universal learnings shared across deployments
2. **User-level** (`~/.remotelab/memory/`): Machine-specific knowledge, private

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

1. **Terminal service is FROZEN** — `auth-proxy.mjs`, `lib/router.mjs`, `lib/sessions.mjs`, `lib/proxy.mjs` must never be modified
2. **No external frameworks** — Node.js built-ins + `ws` only
3. **Three-service architecture** — always maintain production (7690) + test (7692) + emergency terminal (7681)
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
- [x] Sidebar progress tracking (summarizer)
- [x] Resume ID persistence (survives server restarts)
- [x] Web push notifications

### P1 — Next Up
- [ ] Visitor "new conversation" button (currently must re-click share link)
- [ ] Remove folder dependency — Agent defaults to home directory
- [ ] Skills framework (file storage + loading mechanism)
- [ ] Provider registry abstraction — open model selection, local JS/JSON provider config, no more Claude/Codex-only model wiring
- [ ] Provider management UX — setup/settings should support preset enablement, simple GUI JSON providers, and advanced code mode
- [ ] Session metadata enrichment (project, status, priority, tags)
- [ ] Session isolation for Apps — different App sessions should NOT see each other's chat history (privacy risk: cross-session history leakage)

### P2 — Future
- [ ] Deferred triggers (AI-initiated actions, scheduled follow-ups)
- [ ] Autonomous execution (background sessions, event-driven resumption)
- [ ] Post-LLM output processing (layered output: decision / summary / details)

---

## Reference Docs (for deep dives)

| Doc | Path | When to read |
|-----|------|-------------|
| Core Philosophy | `notes/core-philosophy.md` | Design principles, App concept details, identity model, branding |
| Provider Architecture | `notes/provider-architecture.md` | Open provider/model abstraction, local JS/JSON extension path, migration plan |
| Product Vision | `notes/product-vision.md` | Sidebar design rationale, cognitive load thesis, App status tracking |
| AI-Driven Interaction | `notes/ai-driven-interaction.md` | Deferred triggers design, session metadata schema, future phases |
| Autonomous Execution | `notes/autonomous-execution.md` | P2 background execution vision |
| UX Issues | `notes/体验问题与需求思考.md` | Known UX problems, mobile pain points |
| Creating Apps | `docs/creating-apps.md` | User-facing guide for App creation |
| Setup Guide | `docs/setup.md` | Installation, service setup (LaunchAgent/systemd) |
| System Memory | `memory/system.md` | Cross-deployment learnings (context continuity, testing strategy) |

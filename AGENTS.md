# AGENTS.md — RemoteLab Project Context

> Canonical repo-local AI context lives here. Keep tool-specific files like `CLAUDE.md` only as thin compatibility shims that point back to this file.

> **Read this file first.** It gives you everything you need to work on this project without exploring blindly.
> For deep-dive topics, reference docs are linked at the bottom.

---

## What Is RemoteLab

A web app that turns a real macOS/Linux machine into an AI automation workbench accessible from phone and desktop. It is designed first for people with repetitive digital work — including users who are not already AI power users — so they can bring a messy task, sample files, or a recurring chore and let the system help clarify the problem, shape an approach, and execute it on the machine.

**Not** a terminal emulator, a traditional editor-first IDE, or a chatbot. It's an **AI workbench / control console for human-AI collaboration** — the user does not need a perfect spec up front; RemoteLab should help discover the right problem, propose a workable workflow, and keep execution plus context coherent.

- Single owner, not multi-user
- First wedge: repetitive digital work that can be automated quickly
- Phone + desktop are both first-class control surfaces
- Node.js, no external frameworks (only `ws` for WebSocket)
- Vanilla JS frontend, no build tools

## Current Product Framing

- Default target user: someone with repeated digital chores, not necessarily an AI-native operator
- Core promise: a short conversation can eliminate hours of recurring manual work each week
- Interaction rule: AI should act like a product manager / solution designer, helping clarify the task instead of waiting for a perfect prompt
- Multi-session orchestration remains useful, but it is an enabling capability rather than the primary headline

## Current Product Development Loop

- Mainline work is continuous user discovery and feedback-driven iteration around mainstream guided automation on real machines.
- Prefer work that helps a normal user reach one trusted automation win over work that mainly showcases orchestration sophistication.
- Treat user feedback as a durable product asset; summarize reusable signals in repo-visible notes instead of leaving them only in private chat or machine-local memory.
- Keep raw identifying details out of shared notes; record sanitized product evidence and promote stable conclusions into canonical docs.
- See `notes/current/product-mainline.md` and `notes/current/user-feedback-log.md`.

## Documentation Rule

For setup, deployment, integration, and feature-activation docs, use a model-first, prompt-first shape:

- assume the operator is a human delegating to their own AI coding agent
- have the AI collect all required context in one early handoff whenever possible, instead of drip-feeding questions across many turns
- prefer one structured input packet from the human, then autonomous execution by the AI until completion or a true `[HUMAN]` checkpoint
- lead with a copyable prompt, one-round input requirements, target state, and explicit `[HUMAN]` checkpoints
- keep automatable command-by-command flow inside the AI conversation or scripts, not as a long manual cookbook
- minimize human interruption so the operator can hand off the task and come back only for approvals, browser-only actions, validation, or final handoff

---

## Architecture

```
Browser / app surface ──HTTPS──→ Cloudflare Tunnel ──→ chat-server.mjs (:7690)
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

**Dev workflow**: use the normal `7690` service as the single chat/control plane. Restarting it should boot the current source tree directly; RemoteLab relies on clean restart recovery rather than a separate release snapshot or permanent validation plane.

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
│   ├── chat.html            # Chat UI shell (primary, also reused for shared snapshots)
│   ├── login.html           # Login page (194 lines)
│
├── docs/                    # User-facing documentation
├── notes/                   # Internal design & product thinking
├── tests/                   # Scenario-style validation scripts
└── memory/system.md         # System-level memory (shared, in repo)
```

### Data Storage

By default, runtime data lives in `~/.config/remotelab/`.
Additional instances can override this with `REMOTELAB_INSTANCE_ROOT`, `REMOTELAB_CONFIG_DIR`, and `REMOTELAB_MEMORY_DIR`.

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

Current operating rule: prefer product slices that help non-expert users — especially time-valuable middle managers / owner-operators who both delegate work and still personally absorb repetitive digital admin chores — hand off repetitive digital work quickly from phone or desktop and see clear value fast. Treat multi-session orchestration, richer project structure, and broader workflow distribution as enabling layers unless they directly improve that mainstream automation path.

### Done (recent)
- [x] Owner/Visitor dual-role identity
- [x] App system (CRUD API, share tokens, visitor flow)
- [x] Resume ID persistence (survives server restarts)
- [x] Web push notifications
- [x] Mobile capture + desktop execution handoff baseline
- [x] Session-first owner flow baseline
- [x] Baseline multi-session fan-out with bounded cross-session context carry
- [x] Remove voice-input UI/backend and the leftover hidden transcript-cleanup send path

### P1 — Next Up
- [ ] Guided intake / problem discovery — help users describe messy repetitive work, attach examples, and converge on a concrete automation brief without assuming expert prompting
- [ ] Fast repetitive-work automation loops — optimize for data cleanup, report generation, export/import, file processing, notifications, and other simple scriptable chores that can save hours per week quickly
- [ ] State-first, decision-first output shaping — default summaries should tell non-expert users what changed, whether input is needed now, and what outcome to expect next
- [ ] `Welcome App` / guided onboarding — on first launch, seed a built-in guide App that explains capabilities in plain language, asks about the owner's background, repetitive-work pain point, current workflow, and sample inputs, then routes them into either a high-fit starter `App` or one concrete first automation `Session` instead of an empty session list
- [ ] Keep runtime/tool wiring pragmatic and local-first — only generalize the current tool abstraction when a concrete local-runtime need appears; do not reintroduce third-party domain-provider or cloud skill distribution paths by default
- [ ] Produce a precise file-level concept→implementation guide so future sessions can route directly to the right files with less repo spelunking
- [ ] Review the removable shared startup-defaults slice after live use; prune, disable, or replace it quickly if it starts overfitting or duplicating personal memory

### P2 — Future
- [ ] Context carry/cache confirmation — validate and tune compaction, prepared fork context, summary/refs reuse, and any cross-session handoff packet so continued or spawned work stays fast and bounded
- [ ] Universal control inbox / dispatcher session — a high-trust intake surface that can later orchestrate several focused sessions when useful, without becoming one giant work thread
- [ ] Deferred triggers (AI-initiated actions, scheduled follow-ups)
- [ ] Evolve the `Welcome App` into the right long-term intake surface — once the first-run flow proves valuable, decide whether it should stay a dismissible starter, become a persistent control inbox, or merge with the universal dispatcher session
- [ ] Queued follow-up composer buffer — while a session is still streaming a reply, let the user stage another message in a buffer and auto-submit it as a fresh turn immediately after the active response finishes; external connectors like Feishu should share the same staged-turn contract and later define an interrupt/replace policy
- [ ] Session fork follow-ups — extend the shipped hard-clone head-fork with optional `Fork from here`, lightweight lineage navigation, and exact historical fork support when compaction-safe snapshots exist
- [ ] Broaden theming beyond system light/dark — keep v1 system-driven, then add optional explicit theme selection and more color palettes, preferably reusing VS Code-style open theme configs/tokens where that fits cleanly
- [ ] Post-LLM output processing (layered output: decision / summary / details)
- [ ] Revisit product naming/brand and possible repo rename after the product philosophy is more mature; treat this as intentionally deferred while the product itself is still taking shape

---

## Reference Docs (for deep dives)

| Doc | Path | When to read |
|-----|------|-------------|
| Documentation Map | `docs/README.md` | Repo doc taxonomy: what lives in `docs/` vs `notes/` |
| Notes Map | `notes/README.md` | Note taxonomy: `current` vs `directional` vs `archive` vs `local` |
| Project Architecture | `docs/project-architecture.md` | Top-down map of the shipped system, code locations, runtime flows, and current-vs-direction split |
| Product Mainline + Feedback Loop | `notes/current/product-mainline.md` | Current operating plan for prioritization, user feedback, and mainstream automation framing |
| Session Main Flow + Context Freshness Next Push | `notes/current/session-main-flow-next-push.md` | Concrete execution pack for the current session-first main flow, context carry, and multi-session fan-out slice |
| Session-First Workflow Surfaces | `notes/current/session-first-workflow-surfaces.md` | Current workflow-organization contract for session list, grouping, and any future derived workflow projections |
| Model Autonomy Control Loop | `notes/current/model-autonomy-control-loop.md` | Unified design for post-turn model autonomy, context operations, self-check, compaction, and manager/worker delegation |
| Core Domain Contract | `notes/current/core-domain-contract.md` | Current domain/refactor baseline when deciding which product objects are canonical |
| Product Surface Lifecycle | `notes/current/product-surface-lifecycle.md` | Current rule for keep/iterate/retire decisions on shipped feature surfaces |
| External Message Protocol | `docs/external-message-protocol.md` | Canonical connector contract for email/GitHub/bot integrations using sessions, messages, runs, and events |
| Core Philosophy | `notes/directional/core-philosophy.md` | Historical philosophy note; use it for framing, not as the current implementation checklist |
| App-Centric Architecture | `notes/directional/app-centric-architecture.md` | Historical/consolidated direction note for treating default chat and shared Apps as one policy model |
| Provider Architecture | `notes/directional/provider-architecture.md` | Open provider/model abstraction, local JS/JSON extension path, migration plan |
| Product Vision | `notes/directional/product-vision.md` | Product rationale and open questions; not the canonical shipped-status tracker |
| Super-Individual Workbench | `notes/directional/super-individual-workbench.md` | Historical memo from the earlier super-individual framing; still useful background on control-plane boundaries, but not the current target-user statement |
| AI-Driven Interaction | `notes/directional/ai-driven-interaction.md` | Deferred triggers design, session metadata schema, future phases |
| Autonomous Execution | `notes/directional/autonomous-execution.md` | P2 background execution vision |
| Message Transport Architecture | `notes/message-transport-architecture.md` | Historical transport/runtime rationale after the HTTP-first architecture landed |
| HTTP Runtime Phase 1 | `notes/archive/http-runtime-phase1.md` | Concrete implementation spec for the coordinated HTTP/control-plane + runner refactor |
| Memory Activation Architecture | `notes/current/memory-activation-architecture.md` | Pointer-first memory loading, routing layers, pruning rules |
| Creating Apps | `docs/creating-apps.md` | User-facing guide for App creation |
| Setup Guide | `docs/setup.md` | Installation, service setup (LaunchAgent/systemd) |
| System Memory | `memory/system.md` | Cross-deployment learnings (context continuity, testing strategy) |

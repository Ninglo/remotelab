# RemoteLab Project Architecture

This document is the top-down map of the **current shipped architecture** of RemoteLab.

Use it when you need to:

- understand the whole system quickly
- find the right code area before changing behavior
- separate **current implementation** from **directional design notes**
- onboard a future model or human collaborator without re-discovering the repo from scratch

It complements, rather than replaces:

- `AGENTS.md` — repo operating rules and high-level constraints
- `docs/README.md` / `notes/README.md` — documentation taxonomy and note buckets
- `notes/` — deeper design discussions, grouped by status (`current`, `directional`, `archive`, `local`)
- `docs/external-message-protocol.md` — canonical integration contract for external connectors
- `README.md` / `README.zh.md` — user-facing overview and setup

---

## 0. Documentation precedence

When docs overlap, use this order:

1. `AGENTS.md` — repo rules, constraints, and active priorities
2. this file — current shipped architecture and code map
3. `notes/current/core-domain-contract.md` — current domain/refactor baseline
4. other `notes/` docs — deeper discussion, interpreted by their bucket (`current`, `directional`, `archive`, `local`)

### 0.1 Surface docs that should move with architecture

When the architecture changes materially, keep these docs aligned as part of the same pass:

- `README.md` / `README.zh.md` — user-facing product shape, setup path, and operator expectations
- `docs/README.md` / `notes/README.md` — doc taxonomy and cleanup rules
- `AGENTS.md` — repo operating rules and self-hosting workflow constraints

---

## 1. What RemoteLab is

RemoteLab is a **mobile-first control console for AI workers running on a real computer**.

The core product shape is:

- the user talks to an agent from a phone browser
- the agent runs on the owner’s macOS/Linux machine
- the agent is treated more like a person operating a full computer than a sandboxed in-browser chatbot
- the browser is mainly a control surface and a status surface, not the system of record

RemoteLab is explicitly **not** trying to be:

- a terminal emulator
- a mobile IDE
- a generic multi-user SaaS chat app

Important product assumptions that shape the code:

- **Single owner** is the base model
- **Visitor access** exists only through App share links
- **HTTP is the canonical state path**
- **WebSocket is only an invalidation hint**
- **filesystem-first persistence** is preferred over a database until proven necessary
- **frontend stays minimal** and agent-driven workflows are preferred over heavy UI orchestration

---

## 2. Fast orientation for future models

If you need to understand the repo fast, read in this order:

1. `AGENTS.md`
2. this file
3. `chat-server.mjs`
4. `chat/router.mjs`
5. `chat/session-manager.mjs`
6. `static/chat/` (or `static/chat.js` as the compatibility loader)

Then branch by the change you need:

- runtime / message execution → `chat/session-manager.mjs`, `chat/runs.mjs`, `chat/runner-sidecar.mjs`, `chat/adapters/*.mjs`
- HTTP / API / role checks → `chat/router.mjs`, `lib/auth.mjs`, `chat/middleware.mjs`
- UI / mobile behavior → `templates/chat.html`, `static/chat/`, `static/sw.js`
- Apps / visitor flow → `chat/apps.mjs`, `chat/router.mjs`, `chat/session-manager.mjs`
- progress sidebar / rename / grouping → `chat/summarizer.mjs`, `chat/session-naming.mjs`
- memory activation / startup prompt → `chat/system-prompt.mjs`, `notes/current/memory-activation-architecture.md`
- provider/tool extensibility → `lib/tools.mjs`, `chat/models.mjs`, `notes/directional/provider-architecture.md`
- external mail / webhook automation → `lib/agent-mailbox.mjs`, `lib/agent-mail-http-bridge.mjs`, `scripts/agent-mail-*.mjs`, `chat/completion-targets.mjs`

---

## 3. Runtime topology

### 3.1 Permanent service topology

RemoteLab currently works as a **three-service architecture** plus optional side subsystems:

| Service | Port | Role | Status |
|---|---:|---|---|
| `chat-server.mjs` | `7690` | main chat/control plane | primary / stable |
| `chat-server.mjs` | `7692` | validation plane for restart-heavy testing | active dev pattern |
| `auth-proxy.mjs` | `7681` | emergency terminal fallback | frozen / do not modify |

Optional side subsystem:

| Service | Default port | Role |
|---|---:|---|
| `scripts/agent-mail-http-bridge.mjs` | `7694` | receives trusted inbound email webhooks for agent-mail flows |

### 3.2 End-to-end shape

```text
Phone Browser
   │
   ▼
Cloudflare Tunnel
   │
   ▼
chat-server.mjs  (:7690 or :7692)
   │
   ├── HTTP control plane
   ├── auth / owner-visitor policy
   ├── session + run orchestration
   ├── durable history + run storage
   ├── thin WebSocket invalidation
   └── detached runner supervision
           │
           ▼
      runner-sidecar.mjs
           │
           ▼
   local CLI tool (`claude`, `codex`, or compatible wrapper)
```

### 3.3 Development operating model

When developing RemoteLab itself, the intended workflow is:

- use `7690` as the **stable coding/operator plane**
- use `7692` as the **restartable validation plane**
- use `7681` only as an emergency fallback when chat planes fail badly

Operationally this matters because RemoteLab optimizes for **logical continuity after restart**, not for pretending transport continuity exists when you restart the active process.

---

## 4. Architecture layers

The chat plane can be understood as five layers.

### 4.1 Entry and transport layer

Responsible for listening, routing, auth gating, caching, and WS upgrades.

- `chat-server.mjs`
- `chat/router.mjs`
- `chat/ws.mjs`
- `chat/ws-clients.mjs`
- `chat/middleware.mjs`
- `lib/auth.mjs`
- `lib/config.mjs`

This layer decides:

- who is authenticated
- whether the caller is owner or visitor
- which HTTP resource is being accessed
- whether the browser should re-fetch because something changed

### 4.2 Control-plane / domain layer

Responsible for product semantics and long-lived business rules.

- `chat/session-manager.mjs`
- `chat/history.mjs`
- `chat/runs.mjs`
- `chat/summarizer.mjs`
- `chat/apps.mjs`
- `chat/shares.mjs`
- `chat/settings.mjs`
- `chat/push.mjs`
- `chat/completion-targets.mjs`
- `chat/session-continuation.mjs`
- `chat/session-naming.mjs`

This is where RemoteLab’s actual product behavior lives.

### 4.3 Runtime layer

Responsible for executing local AI CLIs and producing raw durable output.

- `chat/process-runner.mjs`
- `chat/runner-supervisor.mjs`
- `chat/runner-sidecar.mjs`
- `chat/adapters/claude.mjs`
- `chat/adapters/codex.mjs`
- `chat/models.mjs`
- `lib/tools.mjs`

This layer should stay comparatively thin and avoid absorbing product policy.

### 4.4 Frontend layer

Responsible for rendering HTTP-derived state in a mobile-friendly UI.

- `templates/chat.html`
- `templates/share.html`
- `templates/login.html`
- `static/chat/`
- `static/chat.js` (compatibility loader)
- `static/share.js`
- `static/sw.js`

Important: the frontend is **vanilla JS** with **no build step**.

### 4.5 Legacy / fallback plane

Responsible for the frozen terminal fallback experience, not the primary chat architecture.

- `auth-proxy.mjs`
- `lib/router.mjs`
- `lib/sessions.mjs`
- `lib/proxy.mjs`
- `templates/dashboard.html`
- `templates/folder-view.html`

This plane is intentionally frozen and should be treated as a safety net, not an active architecture surface.

---

## 5. Repo map by concern

```text
remotelab/
├── chat-server.mjs                 # main HTTP + WS server for chat plane
├── auth-proxy.mjs                  # frozen emergency terminal plane
├── cli.js                          # `remotelab ...` entrypoint
├── chat/                           # chat-plane business logic
│   ├── router.mjs                  # all primary HTTP routes
│   ├── session-manager.mjs         # canonical session/run orchestration
│   ├── history.mjs                 # normalized event persistence
│   ├── runs.mjs                    # durable run manifest/status/spool/result storage
│   ├── process-runner.mjs          # tool/runtime invocation abstraction
│   ├── runner-supervisor.mjs       # detached runner launcher
│   ├── runner-sidecar.mjs          # raw execution sidecar
│   ├── summarizer.mjs              # async progress/title/group generation
│   ├── apps.mjs                    # App template CRUD
│   ├── shares.mjs                  # immutable read-only snapshot creation
│   ├── settings.mjs                # user settings persistence
│   ├── push.mjs                    # web push
│   ├── ws.mjs / ws-clients.mjs     # invalidation-only realtime
│   ├── system-prompt.mjs           # pointer-first memory instructions
│   ├── session-continuation.mjs    # cross-turn / cross-tool handoff context
│   ├── session-naming.mjs          # session title/group normalization helpers
│   └── adapters/                   # CLI-output → normalized-events adapters
├── lib/                            # shared helpers + fallback plane modules
│   ├── auth.mjs                    # token/password auth + auth sessions
│   ├── config.mjs                  # ports, config paths, memory paths
│   ├── tools.mjs                   # tool discovery + simple provider configs
│   ├── agent-mailbox.mjs           # mailbox queue + allowlist + message ingest
│   ├── agent-mail-http-bridge.mjs  # source trust checks for inbound email bridge
│   └── agent-mail-outbound.mjs     # outbound email delivery
├── static/                         # browser JS + manifest + service worker
├── templates/                      # no-build HTML templates
├── scripts/                        # operational scripts and side services
├── notes/                          # internal notes bucketed by status
├── docs/                           # user/developer docs
├── memory/                         # shared system memory (repo-level)
└── tests/                          # scenario-style validation scripts
```

---

## 6. Core persisted objects

RemoteLab’s persistent model is built around a few durable objects.

### 6.1 Auth session

Represents a logged-in browser (owner or visitor).

Key fields:

- `expiry`
- `role` = `owner` or `visitor`
- visitor-only fields such as `appId`, `visitorId`, `sessionId`

Stored in:

- `~/.config/remotelab/auth.json`
- `~/.config/remotelab/auth-sessions.json`

### 6.2 Chat session metadata

Represents one work thread / conversation.

Common fields include:

- `id`
- `folder`
- `tool`
- `name`
- `group`
- `description`
- `created`, `updatedAt`
- `activeRunId`
- `claudeSessionId`, `codexThreadId`
- `appId`, `visitorId`
- `systemPrompt`
- `completionTargets`
- `externalTriggerId`
- `archived`

Stored in:

- `~/.config/remotelab/chat-sessions.json`

### 6.3 Normalized event

Represents canonical session history after tool-specific raw output has been normalized.

Current event families:

- `message`
- `tool_use`
- `tool_result`
- `file_change`
- `reasoning`
- `status`
- `usage`

Implementation note:

- older docs may refer to “JSONL history”
- **current code stores session history as append-only per-event JSON files plus externalized body blobs**, not one JSONL file per session
- run spool output is still JSONL

### 6.4 Run

Represents one submitted tool execution attempt.

Key fields include:

- `id`
- `sessionId`
- `requestId`
- `state` = `accepted` / `running` / `completed` / `failed` / `cancelled`
- `tool`, `model`, `effort`, `thinking`
- `providerResumeId`, `claudeSessionId`, `codexThreadId`
- `runnerProcessId`, `toolProcessId`
- `normalizedLineCount`, `normalizedByteOffset`
- `contextInputTokens`

### 6.5 App

Represents a shareable session template, not a live session.

Key fields include:

- `id`
- `name`
- `systemPrompt`
- `welcomeMessage`
- `skills`
- `tool`
- `shareToken`

### 6.6 Share snapshot

Represents an immutable, read-only capture of a session’s sanitized history.

It is intentionally separate from the live session.

### 6.7 Sidebar summary state

Represents lightweight progress cards used by the “progress” tab.

Key fields per session include:

- `background`
- `lastAction`
- `name`
- `group`
- `description`
- `updatedAt`

---

## 7. On-disk storage layout

### 7.1 Main config directory

Most runtime state lives under:

- `~/.config/remotelab/` on macOS/Linux

Important files and directories:

```text
auth.json
auth-sessions.json
tools.json
chat-sessions.json
apps.json
chat-settings.json
sidebar-state.json
vapid-keys.json
push-subscriptions.json
images/
shared-snapshots/
chat-history/
chat-runs/
```

### 7.2 Session history layout

For each session:

```text
chat-history/<sessionId>/
├── meta.json
├── context.json
├── events/
│   ├── 000000001.json
│   ├── 000000002.json
│   └── ...
└── bodies/
    ├── evt_000000001_content.txt
    └── ...
```

Notes:

- `meta.json` tracks counts and latest sequence
- `context.json` stores compaction / summary-head state
- large or always-externalized event bodies are written into `bodies/`

### 7.3 Run layout

For each run:

```text
chat-runs/<runId>/
├── status.json
├── manifest.json
├── spool.jsonl
├── result.json
└── artifacts/
    └── *.txt
```

Notes:

- `manifest.json` is the control-plane → runner contract snapshot
- `spool.jsonl` is raw durable runtime output
- `artifacts/` stores large externalized spool text blocks

### 7.4 Memory layout

RemoteLab has a separate memory system for model activation:

- user-level private memory: `~/.remotelab/memory/`
- repo-level shared system memory: `memory/system.md`

This memory system is conceptually part of architecture because it affects session startup behavior and future-agent ergonomics.

---

## 8. Main request and execution flow

This is the most important flow in the current architecture.

### 8.1 Browser boot

1. Browser loads `templates/chat.html` and `static/chat.js`, which boots the module split under `static/chat/`
2. Frontend calls `/api/auth/me` to detect owner vs visitor
3. Frontend bootstraps via HTTP:
   - list sessions
   - fetch current session detail
   - fetch session events
4. Frontend opens `/ws`
5. WebSocket is used only to learn **something changed**
6. Frontend re-fetches canonical state via HTTP

### 8.2 Send message

1. the chat frontend (`static/chat/` via `static/chat.js`) generates a `requestId`
2. browser `POST`s to `/api/sessions/:id/messages`
3. `chat/router.mjs` validates access and payload
4. router calls `submitHttpMessage()` in `chat/session-manager.mjs`

### 8.3 Session manager creates durable work

`submitHttpMessage()` does the following:

1. dedupe by `(sessionId, requestId)` via `findRunByRequest()`
2. reject archived sessions or concurrent live runs
3. persist uploaded images into `images/`
4. build the effective prompt
5. create a durable run record + manifest
6. mark the session’s `activeRunId`
7. append the normalized user message event
8. optionally trigger draft-title / early rename logic
9. spawn a detached runner

### 8.4 Prompt construction

Prompt construction combines multiple layers:

- pointer-first startup context from `chat/system-prompt.mjs`
- app-level `systemPrompt` when the session came from an App
- continuation context when resuming or switching tools
- summary-head context from `context.json` after compaction
- visitor-specific guardrail block for shared App sessions

This is an important architectural decision: **session continuity is reconstructed from durable state, not from one immortal in-memory process**.

### 8.5 Detached runner execution

1. `chat/runner-supervisor.mjs` launches `chat/runner-sidecar.mjs` as a detached child
2. sidecar loads `manifest.json`
3. sidecar resolves the actual CLI command through `lib/tools.mjs`
4. sidecar spawns the tool in the session folder / resolved cwd
5. sidecar writes raw stdout/stderr into `spool.jsonl`
6. sidecar updates `status.json` and `result.json`
7. sidecar captures provider-native resume identifiers when present

### 8.6 Control-plane observation and normalization

1. `chat/session-manager.mjs` watches the run directory
2. on `spool.jsonl`, `status.json`, or `result.json` changes, it re-syncs the run
3. raw spool lines are parsed by the correct adapter:
   - `chat/adapters/claude.mjs`
   - `chat/adapters/codex.mjs`
4. adapter output is converted into normalized events
5. normalized events are appended into the session history store
6. the session status is updated and broadcast as invalidation

### 8.7 Finalization after run completion

When a run becomes terminal:

- active run markers are cleared from the session
- resume IDs are persisted back to session metadata
- completion targets may dispatch side effects such as email replies
- web push may fire
- summarizer may generate:
  - final session title
  - display group
  - hidden description
  - sidebar progress card state
- auto-compaction may run if context grows too large

### 8.8 Browser convergence

After any of the above changes:

- server sends a WS invalidation such as `session_invalidated`, `sessions_invalidated`, or `sidebar_invalidated`
- browser re-fetches the affected HTTP resources
- UI renders canonical state from HTTP data, not from streamed partial mutations

This is the heart of the current architecture.

---

## 9. Other important flows

### 9.1 Restart recovery flow

This is a key design goal of the chat plane.

If `chat-server` restarts while a run is active:

- the detached sidecar may keep running
- raw output keeps landing in `chat-runs/<runId>/`
- on startup, `startDetachedRunObservers()` rehydrates active run observers
- the control plane re-reads durable files, re-normalizes any unconsumed spool lines, and converges back to correct state

The promise is **restart-safe logical recovery**, not zero-disruption socket continuity.

### 9.2 App / visitor flow

Visitor entry goes through `/app/:shareToken`.

The current flow is:

1. find the App by share token
2. create a visitor auth session
3. create a fresh chat session seeded from the App template
4. inject the App welcome message as the first assistant event if present
5. set a scoped visitor cookie
6. redirect to the main chat UI in visitor mode

Visitor limits are enforced by role-aware routing and session scoping.

### 9.3 Share snapshot flow

Owner can `POST /api/sessions/:id/share`.

The flow is:

1. load the live session + normalized history
2. sanitize events and inline image data where needed
3. write an immutable snapshot file
4. render it via `templates/share.html` + `static/share.js`

The shared page is intentionally read-only and more tightly sandboxed than the main app.

### 9.4 Progress sidebar flow

After a turn completes, `chat/summarizer.mjs` makes a **separate one-shot tool call** using the same tool family/config when possible.

That call generates JSON describing:

- `background`
- `lastAction`
- maybe `title`
- maybe `group`
- maybe `description`

The result is written into `sidebar-state.json` and surfaced in the UI’s progress tab.

### 9.5 Context compaction and “drop tools”

RemoteLab already contains two explicit context-management mechanisms:

- **Compact**: ask the model to summarize the session into a continuation summary and store it in `context.json`
- **Drop tools**: keep message transcript but strip past tool-result context from future continuation state

These are part of the current practical architecture for long-lived sessions.

### 9.6 Web push flow

The browser registers a service worker and a push subscription.

When a run completes:

- `chat/push.mjs` sends a push payload
- `static/sw.js` suppresses notifications if the app is already visible
- clicking the notification re-opens the relevant session URL

### 9.7 Agent-mail / external automation flow

This is an adjacent subsystem rather than the central chat path, but it matters architecturally.

Pieces:

- `lib/agent-mailbox.mjs` — mailbox queues, message ingest, allowlists, identity
- `lib/agent-mail-http-bridge.mjs` — trust evaluation for inbound webhook sources
- `scripts/agent-mail-http-bridge.mjs` — small HTTP ingress service for Cloudflare Email Worker webhooks
- `chat/completion-targets.mjs` — attach outbound reply delivery to finished runs
- `lib/agent-mail-outbound.mjs` — outbound email delivery

This subsystem shows the direction that **external channels should behave as clients of the same durable session protocol**, not as a separate architecture universe.

---

## 10. Frontend architecture

The frontend is intentionally simple but still architecturally important.

### 10.1 Main characteristics

- no framework
- no bundler
- no compile step
- modular browser controller files under `static/chat/`, booted by `static/chat.js`

### 10.2 Core frontend rules

- HTTP reads are canonical
- WS only hints a refresh
- optimistic UI is allowed, but canonical state still comes from HTTP
- ETag-based revalidation is used for many GET reads
- per-session event fetching is incremental via `afterSeq`

### 10.3 Main frontend responsibilities

The main chat frontend (`static/chat/`, loaded by `static/chat.js`) is responsible for:

- bootstrapping owner vs visitor mode
- listing sessions and rendering the sidebar
- attaching to one active session
- fetching incremental session events
- rendering normalized event types
- managing pending-message recovery on refresh
- managing inline tool/model/reasoning selectors
- handling session archive/rename actions
- managing progress-tab reads
- registering push notifications

### 10.4 Share page frontend

`static/share.js` is a separate read-only renderer.

It additionally:

- sanitizes rendered markdown aggressively
- strips `<private>` / `<hide>` content from shared output
- adds code-copy affordances

---

## 11. HTTP and WS surface

The main chat plane is almost entirely driven through `chat/router.mjs`.

### 11.1 Core HTTP resources

Sessions:

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id`
- `GET /api/sessions/:id/events?afterSeq=...`
- `GET /api/sessions/:id/events/:seq/body`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/cancel`
- `POST /api/sessions/:id/resume`
- `POST /api/sessions/:id/compact`
- `POST /api/sessions/:id/drop-tools`
- `POST /api/sessions/:id/share`

The session event route is completeness-first: it returns the full event index after the given cursor. Heavy thinking and tool bodies stay deferred behind the per-event body route so session switches do not depend on a paged history fetch.

Runs:

- `GET /api/runs/:id`
- `POST /api/runs/:id/cancel`

Tooling and settings:

- `GET /api/tools`
- `POST /api/tools`
- `GET /api/models?tool=...`
- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/sidebar`
- `GET /api/autocomplete`
- `GET /api/browse`
- `GET /api/images/:filename`

Apps and shares:

- `GET /api/apps`
- `POST /api/apps`
- `PATCH /api/apps/:id`
- `DELETE /api/apps/:id`
- `GET /app/:shareToken`
- `GET /share/:snapshotId`

Auth and push:

- `POST /login`
- `GET /login`
- `GET /logout`
- `GET /api/auth/me`
- `GET /api/push/vapid-public-key`
- `POST /api/push/subscribe`

### 11.2 WebSocket semantics

`/ws` is intentionally push-only from server to browser.

Current message families are small invalidations such as:

- session invalidated
- session list invalidated
- sidebar invalidated

The browser does not rely on WS to carry canonical message content.

---

## 12. Tool and provider model

The currently shipped implementation uses a pragmatic tool abstraction.

### 12.1 Current state

- built-in tools are declared in `lib/tools.mjs`
- current first-class runtime families are:
  - `claude-stream-json`
  - `codex-json`
- simple custom tool configs can be saved via `/api/tools`
- models/reasoning metadata are returned by `/api/models`

### 12.2 Current abstraction split

- `lib/tools.mjs` decides what tools exist and whether commands resolve locally
- `chat/process-runner.mjs` turns a tool selection into command + args + adapter
- `chat/adapters/*.mjs` parse raw CLI JSONL output into normalized events
- `chat/models.mjs` provides frontend-facing model/reasoning options

### 12.3 Directional note

This is explicitly evolving toward the broader provider registry described in `notes/directional/provider-architecture.md`.

The current abstraction is functional, but still transitional.

---

## 13. Memory activation architecture

RemoteLab’s model behavior is shaped not only by chat history but also by the **pointer-first memory system**.

Current implementation pieces:

- `chat/system-prompt.mjs` prepends startup instructions for memory activation
- user-level memory lives under `~/.remotelab/memory/`
- shared system memory lives in `memory/system.md`

The key architectural rule is:

- memory should be **large on disk, small in active context**

This matters because future model-driven development sessions depend on loading only the right memory slices for the current scope.

---

## 14. Architectural constraints and invariants

These constraints are part of the architecture, not incidental implementation details.

- `auth-proxy.mjs` and its supporting terminal-plane files are frozen
- RemoteLab stays framework-light: Node built-ins + `ws`
- frontend remains vanilla JS without build tooling
- single-owner model remains the default product assumption
- owner/visitor is a scoped access model, not full multi-user infrastructure
- chat plane should remain HTTP-canonical and restart-cheap
- runtime layer should stay thinner than the control plane
- new durable product semantics should prefer filesystem-first persistence

---

## 15. Where to change what

Use this as the practical code-finding guide.

| If you need to change... | Open these files first |
|---|---|
| login, cookies, owner/visitor roles | `lib/auth.mjs`, `chat/router.mjs`, `chat/middleware.mjs` |
| session creation / rename / archive | `chat/router.mjs`, `chat/session-manager.mjs`, `chat/session-naming.mjs`, `static/chat/` |
| message submission or run lifecycle | `static/chat/`, `chat/router.mjs`, `chat/session-manager.mjs`, `chat/runs.mjs`, `chat/runner-sidecar.mjs` |
| tool execution details | `chat/process-runner.mjs`, `chat/adapters/*.mjs`, `lib/tools.mjs` |
| restart recovery behavior | `chat/session-manager.mjs`, `chat/runs.mjs`, `chat/runner-sidecar.mjs`, `notes/archive/http-runtime-phase1.md` |
| event persistence / long-output handling | `chat/history.mjs`, `chat/runs.mjs`, `chat/fs-utils.mjs` |
| sidebar summaries / auto-rename / grouping | `chat/summarizer.mjs`, `chat/session-manager.mjs`, `chat/session-naming.mjs`, `static/chat/` |
| App templates or visitor flow | `chat/apps.mjs`, `chat/router.mjs`, `chat/session-manager.mjs`, `static/chat/`, `docs/creating-apps.md` |
| share snapshots | `chat/shares.mjs`, `templates/share.html`, `static/share.js` |
| push notifications | `chat/push.mjs`, `static/sw.js`, `static/chat/` |
| model/tool picker behavior | `lib/tools.mjs`, `chat/models.mjs`, `static/chat/` |
| pointer-first memory startup | `chat/system-prompt.mjs`, `notes/current/memory-activation-architecture.md` |
| inbound/outbound mail automation | `lib/agent-mailbox.mjs`, `lib/agent-mail-http-bridge.mjs`, `lib/agent-mail-outbound.mjs`, `chat/completion-targets.mjs`, `scripts/agent-mail-*.mjs` |
| frozen fallback terminal plane | `auth-proxy.mjs`, `lib/router.mjs`, `lib/sessions.mjs`, `lib/proxy.mjs` — only if you truly mean to touch the emergency plane |

---

## 16. Tests and validation surfaces

There is no single monolithic test harness. Validation is currently scenario-based and file-oriented.

High-value clusters:

- HTTP/runtime and restart work:
  - `tests/test-http-runtime-phase1.mjs`
  - `tests/test-run-spool-delta.mjs`
  - `tests/test-session-status-broadcast.mjs`
- session behavior:
  - `tests/test-session-grouping.mjs`
  - `tests/test-session-early-rename.mjs`
  - `tests/test-session-route-utils.mjs`
  - `tests/test-session-tool-reuse.mjs`
- Codex integration and resume behavior:
  - `tests/test-codex-singleshot.mjs`
  - `tests/test-codex-resume.mjs`
  - `tests/test-codex-resume-bug.mjs`
  - `tests/test-codex-multistep.mjs`
  - `tests/test-codex-realworld.mjs`
  - `tests/test-codex-issues.mjs`
- sharing and push-adjacent surfaces:
  - `tests/test-share-snapshot.mjs`
- agent-mail subsystem:
  - `tests/test-agent-mailbox.mjs`
  - `tests/test-agent-mail-http-bridge.mjs`
  - `tests/test-agent-mail-worker.mjs`
  - `tests/test-agent-mail-reply.mjs`

Operational validation also matters:

- `scripts/chat-instance.sh` is the intended helper for disposable validation planes such as `7692`

---

## 17. Current architecture vs direction notes

This repo already contains several design notes that point beyond the current code.

### 17.1 Already largely shipped

- HTTP-first control plane with detached runners
- thin WS invalidation model
- restart-safe recovery from durable run + history files
- owner / visitor identity split
- App templates + share links
- sidebar progress summaries
- pointer-first memory activation

### 17.2 Directional but not fully realized yet

- provider registry with builtin / local JS / local JSON providers
- app-centric architecture where default chat becomes a built-in App/policy model
- richer autonomy / deferred triggers / background execution
- deeper external channel unification (mail, repo bots, other message sources)
- potentially broader runtime/provider cleanup after the current HTTP-first boundaries settle

Use these notes when needed:

- `notes/message-transport-architecture.md`
- `notes/archive/http-runtime-phase1.md`
- `notes/directional/provider-architecture.md`
- `notes/directional/app-centric-architecture.md`
- `notes/directional/ai-driven-interaction.md`
- `notes/directional/autonomous-execution.md`
- `notes/current/self-hosting-dev-restarts.md`

---

## 18. Short version

If you only remember one mental model, remember this:

> RemoteLab is a **filesystem-backed HTTP control plane for long-lived AI work sessions**, with **detached CLI runners**, **normalized append-only session history**, **thin WebSocket invalidation**, and a **minimal mobile UI** that always converges back to durable state.

Everything else in the repo is either:

- product semantics layered on top of that core
- a legacy fallback plane
- or a future-direction note about making that core more general

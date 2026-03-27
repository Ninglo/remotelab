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

RemoteLab is an **endpoint-flexible AI automation workbench that helps people hand repetitive digital work to AI on a real computer**.

The core product shape is:

- the user steers work from phone or desktop, whichever is most convenient
- strong executors run on the owner’s macOS/Linux machine
- RemoteLab sits above them as a guided-intake, execution, context-recovery, and workflow-packaging layer
- the agent is treated more like a person operating a full computer than a sandboxed in-browser chatbot
- the browser is mainly a control surface and a status surface, not the system of record

RemoteLab is explicitly **not** trying to be:

- a terminal emulator
- a traditional editor-first IDE
- a generic multi-user SaaS chat app
- a closed all-in-one executor stack

Important product assumptions that shape the code:

- **Single owner** is the base model
- **Visitor access** exists only through App share links
- **HTTP is the canonical state path**
- **WebSocket is only an invalidation hint**
- **filesystem-first persistence** is preferred over a database until proven necessary
- **frontend stays minimal and endpoint-flexible** and agent-driven workflows are preferred over heavy UI orchestration

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
- UI / cross-endpoint behavior → `templates/chat.html`, `static/chat/`, `static/sw.js`
- Apps / visitor flow → `chat/apps.mjs`, `chat/router.mjs`, `chat/session-manager.mjs`
- session labeling / rename / grouping → `chat/summarizer.mjs`, `chat/session-naming.mjs`
- memory activation / startup prompt → `chat/system-prompt.mjs`, `chat/shared-startup-defaults.mjs`, `notes/current/memory-activation-architecture.md`
- provider/tool extensibility → `lib/tools.mjs`, `chat/models.mjs`, `notes/directional/provider-architecture.md`
- external mail / webhook automation → `lib/agent-mailbox.mjs`, `lib/agent-mail-http-bridge.mjs`, `lib/agent-mail-completion-targets.mjs`, `scripts/agent-mail-*.mjs`

---

## 3. Runtime topology

### 3.1 Permanent service topology

RemoteLab currently works as a **single chat/control plane** plus optional side subsystems:

| Service | Port | Role | Status |
|---|---:|---|---|
| `chat-server.mjs` | `7690` | main chat/control plane | primary / stable |

Optional side subsystem:

| Service | Default port | Role |
|---|---:|---|
| `scripts/agent-mail-http-bridge.mjs` | `7694` | receives trusted inbound email webhooks for agent-mail flows |

### 3.2 End-to-end shape

```text
Browser / client surface
   │
   ▼
Cloudflare Tunnel
   │
   ▼
chat-server.mjs  (:7690)
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

- use `7690` as the default coding/operator plane
- restart the running service to pick up backend changes from the current source tree
- rely on clean restart recovery instead of a permanent second validation plane

Operationally this matters because RemoteLab now boots directly from the current source tree after restart and optimizes for **logical continuity after restart**, not for pretending transport continuity exists while the active process restarts.

---

## 4. Architecture layers

The chat plane can be understood as four layers.

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
- `chat/push.mjs`
- `lib/agent-mail-completion-targets.mjs`
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

Responsible for rendering HTTP-derived state in an endpoint-flexible UI that works well on phone and desktop.

- `templates/chat.html`
- `templates/login.html`
- `static/chat/`
- `static/chat.js` (compatibility loader)
- `static/sw.js`

Important: the frontend is **vanilla JS** with **no build step**.

## 5. Repo map by concern

```text
remotelab/
├── chat-server.mjs                 # main HTTP + WS server for chat plane
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
│   ├── shared-startup-defaults.mjs # removable shared startup defaults slice
│   ├── session-continuation.mjs    # cross-turn / cross-tool handoff context
│   ├── session-naming.mjs          # session title/group normalization helpers
│   └── adapters/                   # CLI-output → normalized-events adapters
├── lib/                            # shared helpers
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
- `appId`, `appName`, `visitorId`
- `systemPrompt`
- `completionTargets`
- `externalTriggerId`
- `forkedFromSessionId`, `forkedFromSeq`, `rootSessionId`, `forkedAt`
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
- optional `templateContext` snapshot metadata, including source-session freshness timestamps when the App was saved from a prior session

### 6.6 Share snapshot

Represents an immutable, read-only capture of a session’s sanitized history.

It is intentionally separate from the live session.

### 6.7 Session workflow projection

Represents owner-facing session organization views such as the sidebar and session list ordering.

It is not a separate durable object. It is derived from canonical session metadata plus live activity.

Key fields per session include:

- `name`
- `group`
- `description`
- `workflowState`
- `workflowPriority`
- `pinned`
- `updatedAt`
- live `activity`

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

- pointer-first startup context from `chat/system-prompt.mjs` and `chat/shared-startup-defaults.mjs`
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
- auto-compaction may run as a conservative fallback if live context exceeds the known model window (or an explicit token override)

### 8.8 Browser convergence

After any of the above changes:

- server sends a WS invalidation such as `session_invalidated` or `sessions_invalidated`
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
4. render it via `templates/chat.html` in `shareSnapshotMode`, hydrated by `/share-payload/:id.js`

The shared page is intentionally read-only and more tightly sandboxed than the main app.

### 9.4 Session label suggestion flow

After a turn completes, `chat/summarizer.mjs` makes a **separate one-shot tool call** using the same tool family/config when possible.

That call generates JSON describing canonical presentation metadata:

- maybe `title`
- maybe `group`
- maybe `description`

The result is written back into canonical session metadata.
The current workflow projection is intentionally session-first: session organization piggybacks on canonical metadata plus live activity instead of a separate task-style object.

### 9.5 Context compaction and “drop tools”

RemoteLab already contains two explicit context-management mechanisms:

- **Compact**: ask the model to summarize the session into a continuation summary and store it in `context.json`
- **Drop tools**: keep message transcript but strip past tool-result context from future continuation state

Current auto-compaction now runs through a hidden companion session per parent session:

- the visible session keeps its full history for the user
- a hidden compactor session generates the fresh continuation package
- the visible session inserts a context barrier marker plus a user-visible handoff message
- `context.json` becomes the authoritative live continuation head for future turns

This keeps continuity visible to the user while making it explicit that older messages above the barrier are no longer in live context.

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
- `lib/agent-mail-completion-targets.mjs` — attach outbound email reply delivery to finished runs
- `lib/agent-mail-outbound.mjs` — outbound email delivery

This subsystem shows the direction that **external channels should behave as clients of the same durable session protocol**, not as a separate architecture universe.

### 9.8 Session fork flow

The shipped fork model is intentionally narrow and exact.

Current flow:

1. owner triggers `POST /api/sessions/:id/fork`
2. server validates access and rejects sessions that still have unstable active execution state
3. child session metadata is created by copying parent base fields into a fresh session record
4. full normalized history is materialized into the child history store
5. copied events drop parent execution identity such as `runId` and `requestId`
6. child session clears live execution linkage such as `activeRunId`, `activeRun`, provider resume ids, `externalTriggerId`, and `completionTargets`
7. current context head is copied so the child starts from the same durable RemoteLab-side continuation state
8. parent remains open; fork is a preparation action, not an implicit context switch

Current product contract:

- v1 is **head fork** only: clone the session as it exists now
- fork is **hard clone + hard isolation**, not a shared-thread branch
- historical `Fork from here` is deferred until RemoteLab can preserve exact pre-compaction fork state without approximation
- the sidebar remains flat; lineage metadata exists, but there is no full tree UI subsystem yet

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
- per-session event fetching is snapshot-style for visible timeline content, with hidden blocks loaded lazily as separate immutable resources

### 10.3 Main frontend responsibilities

The main chat frontend (`static/chat/`, loaded by `static/chat.js`) is responsible for:

- bootstrapping owner vs visitor mode
- listing sessions and rendering the sidebar
- attaching to one active session
- fetching a visible event timeline plus lazy hidden-event blocks
- rendering normalized event types
- managing pending-message recovery on refresh
- managing inline tool/model/reasoning selectors
- handling session archive/rename actions
- rendering the session-first sidebar / workflow projection
- registering push notifications

### 10.4 Share snapshot frontend

Share snapshots reuse the main chat shell (`templates/chat.html` + `static/chat/`) with `shareSnapshotMode` bootstrapped from `/share-payload/:id.js`.

That mode additionally:

- hides sidebar/session-management UI via visitor-mode layout rules
- disables live auth/bootstrap and websocket attachment
- renders frozen snapshot events through the same chat timeline components
- keeps `<private>` / `<hide>` content filtered out before publication

---

## 11. HTTP and WS surface

The main chat plane is almost entirely driven through `chat/router.mjs`.

### 11.1 Core HTTP resources

Sessions:

- `GET /api/sessions`
- `GET /api/sessions/archived`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id`
- `GET /api/sessions/:id/events?filter=visible|all`
- `GET /api/sessions/:id/events/blocks/:startSeq-:endSeq`
- `GET /api/sessions/:id/events/:seq/body`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/cancel`
- `POST /api/sessions/:id/compact`
- `POST /api/sessions/:id/drop-tools`
- `POST /api/sessions/:id/share`

`GET /api/sessions` is the owner sidebar collection and returns active-session metadata only. Archived sessions are fetched separately through `GET /api/sessions/archived` so the default bootstrap path stays small without introducing pagination.

The session event route is display-first by default: `GET /api/sessions/:id/events?filter=visible` returns the visible timeline needed for the current UI, including inline user/assistant messages and synthetic collapsed blocks for hidden reasoning/tool steps. Expanding a collapsed block triggers `GET /api/sessions/:id/events/blocks/:startSeq-:endSeq`, which returns the hidden events with inline bodies and can be cached immutably. `filter=all` still exposes the raw deferred-body event index for debugging or compatibility, but the common-path transport now avoids shipping hidden tool/reasoning payloads up front.

Runs:

- `GET /api/runs/:id`
- `POST /api/runs/:id/cancel`

Tooling and settings:

- `GET /api/tools`
- `POST /api/tools`
- `GET /api/models?tool=...`
- `GET /api/autocomplete`
- `GET /api/browse`
- `GET /api/media/:filename` (with legacy `/api/images/:filename` alias)

Apps and shares:

- `GET /api/apps`
- `POST /api/apps`
- `PATCH /api/apps/:id`
- `DELETE /api/apps/:id`
- `GET /app/:shareToken`
- `GET /share/:snapshotId`

Implementation note:

- `GET /api/apps` is the shareable App template CRUD surface
- the owner sidebar app filter is derived from session metadata (`appId` / `appName`) instead of a hardcoded frontend catalog, so installations with only the default `chat` app do not surface that filter

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
- `chat/shared-startup-defaults.mjs` carries a small removable cross-user startup slice that can be toggled without changing personal memory layout
- user-level memory lives under `~/.remotelab/memory/`
- shared system memory lives in `memory/system.md`

The key architectural rule is:

- memory should be **large on disk, small in active context**

This matters because future model-driven development sessions depend on loading only the right memory slices for the current scope.

---

## 14. Architectural constraints and invariants

These constraints are part of the architecture, not incidental implementation details.

- the shipped architecture no longer includes a built-in terminal fallback plane
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
| session labeling / auto-rename / grouping | `chat/summarizer.mjs`, `chat/session-manager.mjs`, `chat/session-naming.mjs`, `static/chat/` |
| App templates or visitor flow | `chat/apps.mjs`, `chat/router.mjs`, `chat/session-manager.mjs`, `static/chat/`, `docs/creating-apps.md` |
| share snapshots | `chat/shares.mjs`, `chat/router.mjs`, `templates/chat.html`, `static/chat/` |
| push notifications | `chat/push.mjs`, `static/sw.js`, `static/chat/` |
| model/tool picker behavior | `lib/tools.mjs`, `chat/models.mjs`, `static/chat/` |
| pointer-first memory startup | `chat/system-prompt.mjs`, `chat/shared-startup-defaults.mjs`, `notes/current/memory-activation-architecture.md` |
| inbound/outbound mail automation | `lib/agent-mailbox.mjs`, `lib/agent-mail-http-bridge.mjs`, `lib/agent-mail-outbound.mjs`, `lib/agent-mail-completion-targets.mjs`, `scripts/agent-mail-*.mjs` |

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

- `scripts/chat-instance.sh` is only an ad-hoc helper for optional manual instances on explicitly chosen ports; it is not part of the shipped service topology

---

## 17. Current architecture vs direction notes

This repo already contains several design notes that point beyond the current code.

### 17.1 Already largely shipped

- HTTP-first control plane with detached runners
- thin WS invalidation model
- restart-safe recovery from durable run + history files
- owner / visitor identity split
- App templates + share links
- session label suggestions
- pointer-first memory activation

### 17.2 Directional but not fully realized yet

- provider registry with builtin / local JS / local JSON providers
- app-centric architecture where default chat becomes a built-in App/policy model
- richer autonomy / deferred triggers / background execution
- deeper external channel unification (mail, repo bots, other message sources)
- single-source active-run transcript projection with side-effect-free read paths
- potentially broader runtime/provider cleanup after the current HTTP-first boundaries settle
- broader theming beyond the current automatic system light/dark baseline
- further icon-system cleanup beyond the current shipped Codicons subset

Use these notes when needed:

- `notes/message-transport-architecture.md`
- `notes/archive/http-runtime-phase1.md`
- `notes/directional/provider-architecture.md`
- `notes/directional/app-centric-architecture.md`
- `notes/directional/ai-driven-interaction.md`
- `notes/directional/autonomous-execution.md`
- `notes/directional/single-source-transcript-architecture.md`
- `notes/directional/ui-theming.md`
- `notes/directional/ui-icons.md`
- `notes/current/self-hosting-dev-restarts.md`

---

## 18. Short version

If you only remember one mental model, remember this:

> RemoteLab is a **filesystem-backed HTTP control plane for long-lived AI work sessions**, with **detached CLI runners**, **normalized append-only session history**, **thin WebSocket invalidation**, and a **minimal endpoint-flexible web UI** that always converges back to durable state.

Everything else in the repo is either:

- product semantics layered on top of that core
- or a future-direction note about making that core more general

# Core Domain → Current Implementation Mapping

> Status: current crosswalk between the domain contract and the shipped code.
> Read this after `notes/current/core-domain-contract.md` when you need to map the agreed product model onto current files, routes, and storage.
>
> This note is intentionally descriptive, not normative.
> For the action-oriented refactor checklist, use `notes/current/core-domain-refactor-todo.md`.
> The contract lives in `notes/current/core-domain-contract.md`.
> This file explains how the current codebase does or does not line up with that contract.

---

## How To Use This Note

Use the notes in this order:

1. `docs/project-architecture.md` — top-down shipped system map
2. `notes/current/core-domain-contract.md` — current domain baseline
3. this file — current code/storage/route mapping and known mismatches

Short version:

- if you need the intended model, read the contract
- if you need to change code safely, read this mapping
- if they conflict, the contract wins for future refactor direction

---

## Mapping Legend

- **Aligned** — current implementation already matches the contract closely
- **Partial** — current implementation has the right shape but still carries legacy shortcuts
- **Mismatch** — current implementation still uses an older model and should eventually be refactored

---

## One-Screen Crosswalk

| Domain object | Current main code owners | Current storage | Main current routes/surfaces | Status |
|---|---|---|---|---|
| `Session` | `chat/session-manager.mjs`, `chat/history.mjs` | `chat-sessions.json`, `chat-history/<sessionId>/` | `/api/sessions*`, main chat UI | Partial |
| `Run` | `chat/runs.mjs`, `chat/session-manager.mjs`, runner modules | `chat-runs/<runId>/` | `/api/runs/:runId`, message/cancel/resume flows | Partial |
| `App` | `chat/apps.mjs`, `chat/router.mjs` | `apps.json` | `/api/apps*`, `/app/:shareToken` | Partial |
| `Principal` | `lib/auth.mjs`, `chat/router.mjs` | `auth-sessions.json` cookie sessions | `/login`, `/logout`, `/api/auth/me` | Mismatch |
| `ShareSnapshot` | `chat/shares.mjs`, `chat/router.mjs` | `shared-snapshots/<snapId>.json` | `POST /api/sessions/:id/share`, `GET /share/:id` | Partial |
| derived UI state | `chat/summarizer.mjs`, `static/chat.js` | `sidebar-state.json` | `/api/sidebar`, Progress tab | Partial |

---

## Terminology Crosswalk

The current code still uses some older names. Use the following translation when reading it.

| Contract term | Current code term | Notes |
|---|---|---|
| `Principal` | auth session `role`, plus optional `visitorId`, `appId`, `sessionId` | current code does not yet model principal explicitly |
| owner principal | auth session with `role: 'owner'` | globally privileged |
| app-scoped non-owner principal | auth session with `role: 'visitor'` | currently narrower than the contract; effectively pinned to one session |
| app entry surface | `/app/:shareToken` flow | currently creates a new visitor session and logs into that session |
| `ShareSnapshot` | snapshot JSON under `shared-snapshots/` | currently materialized, not range-based |
| derived UI state | sidebar/progress state | stored separately and partly fed by summarizer |

---

## 1. Session

**Contract role:** primary durable product object and main user-facing truth.

### Current code owners

- `chat/session-manager.mjs`
- `chat/history.mjs`
- `chat/router.mjs`
- frontend reads in `static/chat.js`

### Current storage

Session truth is currently split across two persistence layers.

#### A. Session index

Stored in `~/.config/remotelab/chat-sessions.json` via `CHAT_SESSIONS_FILE`.

Current session metadata is created and mutated primarily in `chat/session-manager.mjs`.

Observed current session fields include:

- `id`
- `folder`
- `tool`
- `name`
- `autoRenamePending`
- `created`
- `updatedAt`
- `group`
- `description`
- `appId`
- `visitorId`
- `systemPrompt`
- `completionTargets`
- `externalTriggerId`
- `archived` / `archivedAt`
- `activeRunId`
- provider resume ids in some flows

#### B. Session history

Stored under `~/.config/remotelab/chat-history/<sessionId>/` via `CHAT_HISTORY_DIR`.

Current history layout is filesystem-first and per-session:

- `meta.json`
- `context.json`
- `events/<seq>.json`
- `bodies/<ref>.txt`

Current implementation stores canonical conversation/event truth here.

### Current routes/surfaces

- `GET /api/sessions`
- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/events`
- `GET /api/sessions/:sessionId/events/:seq/body`
- `POST /api/sessions`
- `PATCH /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/messages`
- `POST /api/sessions/:sessionId/cancel`
- `POST /api/sessions/:sessionId/resume`
- `POST /api/sessions/:sessionId/compact`
- `POST /api/sessions/:sessionId/drop-tools`
- `POST /api/sessions/:sessionId/share`

Frontend surface:

- the session list/sidebar in `static/chat.js`
- the main chat panel
- group/title/description display logic

### Current alignment with the contract

**Partial**.

The good news:

- session is already the primary user-facing object
- session history is already the canonical conversation surface
- the UI already orients around sessions first
- run outputs are already normalized back into session history in important cases

The remaining gaps:

- there is no explicit `createdByPrincipalId`; the closest current stand-in is `visitorId`, and only for non-owner app sessions
- owner sessions may still have no `appId`, so the built-in default app is not yet consistently materialized in data
- some provider/runtime resume details still leak into session metadata because the model is mid-transition
- some read paths still reconcile or mutate runtime state before returning session data

### Current working interpretation

When mapping current code to the contract, treat:

- a session with no `appId` as belonging to the implicit built-in default app
- a session with `visitorId` as belonging to an app-scoped non-owner principal flow
- history in `chat-history/<sessionId>/` as the primary durable narrative of the session

### Field crosswalk

| Contract field/concept | Current representation | Notes |
|---|---|---|
| `Session.id` | `session.id` | already aligned |
| `Session.appId` | optional `session.appId` | missing for default-owner sessions |
| `Session.createdByPrincipalId` | no exact field; nearest is `visitorId` for non-owner flows | key current gap |
| `Session.name` | `session.name` | aligned |
| `Session.group` | `session.group` | aligned as canonical metadata |
| `Session.description` | `session.description` | aligned as canonical metadata |
| `Session.archived` | `session.archived` / `archivedAt` | aligned |
| `Session.activeRunId` | `session.activeRunId` | aligned |
| canonical history | `chat-history/<sessionId>/...` | aligned |

---

## 2. Run

**Contract role:** operational execution object under a session.

### Current code owners

- `chat/runs.mjs`
- `chat/session-manager.mjs`
- `chat/process-runner.mjs`
- `chat/runner-supervisor.mjs`
- `chat/runner-sidecar.mjs`
- `chat/adapters/*.mjs`

### Current storage

Run state is stored under `~/.config/remotelab/chat-runs/<runId>/` via `CHAT_RUNS_DIR`.

Current run directory layout:

- `status.json`
- `manifest.json`
- `spool.jsonl`
- `result.json`
- `artifacts/`

Current `status.json` shape includes fields such as:

- `id`
- `sessionId`
- `requestId`
- `state`
- `tool`
- `model`
- `effort`
- `thinking`
- `createdAt`
- `startedAt`
- `updatedAt`
- `completedAt`
- `providerResumeId`
- `claudeSessionId`
- `codexThreadId`
- `cancelRequested`
- `result`
- `runnerProcessId`
- `toolProcessId`
- `normalizedLineCount`
- `normalizedByteOffset`
- `finalizedAt`
- `lastNormalizedAt`
- `failureReason`
- context token counters

### Current routes/surfaces

- `GET /api/runs/:runId`
- `POST /api/runs/:runId/cancel`
- session write flows create/update runs indirectly through message submission and resume/cancel actions

### Current alignment with the contract

**Partial, but structurally close**.

The good news:

- run already exists as a distinct backend object
- run already owns request identity, in-flight state, spool, finalization, and usage-ish execution details
- run already points back to `sessionId`
- run access is already checked through the parent session

The remaining gaps:

- parts of run reconciliation still happen on read paths such as `getRunState()` and session reconciliation
- some provider resume ids still live in both run and session-related flows
- the product/UI still only partially exposes run as an operational child, so the mental model in code and UI is not always equally clear

### Current working interpretation

When reading current code, treat run as:

- the execution record the backend needs
- subordinate to session for user-facing narrative truth
- the current home of sidecar/raw runtime mechanics

### Field crosswalk

| Contract field/concept | Current representation | Notes |
|---|---|---|
| `Run.id` | `run.id` | aligned |
| `Run.sessionId` | `run.sessionId` | aligned |
| `Run.requestId` | `run.requestId` | aligned |
| `Run.state` | `run.state` | aligned |
| per-run tool/model config | `tool`, `model`, `effort`, `thinking` | aligned |
| execution spool | `spool.jsonl` | aligned |
| final outcome | `result.json`, `run.result`, terminal state | aligned |
| provider resume/execution ids | `providerResumeId`, `claudeSessionId`, `codexThreadId` | aligned operationally, but still somewhat duplicated in surrounding session flows |

---

## 3. App

**Contract role:** reusable scope/policy/presentation object referenced by session.

### Current code owners

- `chat/apps.mjs`
- app entry handling in `chat/router.mjs`
- app-linked session creation in `chat/session-manager.mjs`

### Current storage

Apps are stored in `~/.config/remotelab/apps.json` via `APPS_FILE`.

Current app shape is lightweight and template-like:

- `id`
- `name`
- `systemPrompt`
- `welcomeMessage`
- `skills`
- `tool`
- `shareToken`
- `createdAt`
- `updatedAt`
- soft-delete fields

### Current routes/surfaces

- `GET /api/apps`
- `POST /api/apps`
- `PATCH /api/apps/:appId`
- `DELETE /api/apps/:appId`
- `GET /app/:shareToken`

### Current alignment with the contract

**Partial**.

The good news:

- app is already a real persisted object
- sessions can already carry `appId`
- app already owns bootstrap-like fields such as `systemPrompt` and `welcomeMessage`
- app already has its own CRUD surface

The remaining gaps:

- there is no built-in default app record for the owner console yet
- app currently behaves more like a shareable template than a full reusable scope/policy object
- `shareToken` currently doubles as the app entry mechanism, which conflates app access with app publication/discovery
- app-level visibility/access policy is still implicit and route-specific rather than modeled explicitly

### Current working interpretation

When mapping current code to the contract, treat:

- app records in `apps.json` as the current reusable app layer
- sessions without `appId` as belonging to the implicit default app
- `/app/:shareToken` as the current app entry surface, not the final access model

### Field crosswalk

| Contract field/concept | Current representation | Notes |
|---|---|---|
| `App.id` | `app.id` | aligned |
| title/name | `app.name` | aligned in spirit |
| bootstrap instructions | `app.systemPrompt` | aligned |
| welcome framing | `app.welcomeMessage` | aligned |
| default tool policy | `app.tool` | partial; current field is a single default tool |
| visibility/access policy | implicit in `shareToken` route + owner checks | missing as explicit model |
| built-in default app | not explicitly stored | key current gap |

---

## 4. Principal

**Contract role:** access subject.

### Current code owners

- `lib/auth.mjs`
- `chat/router.mjs`
- `chat/session-manager.mjs`
- `chat/middleware.mjs`
- frontend bootstrap path through `GET /api/auth/me`

### Current storage

There is **no explicit principal record** yet.

The closest current structure is the auth session persisted in `~/.config/remotelab/auth-sessions.json` via `AUTH_SESSIONS_FILE`.

Current auth session shape includes:

- `expiry`
- `role` — currently `owner` or `visitor`
- optional `appId`
- optional `sessionId`
- optional `visitorId`

### Current routes/surfaces

- `POST /login`
- `GET /login`
- `GET /logout`
- `GET /api/auth/me`

Current `GET /api/auth/me` behavior:

- owner session returns `{ role: 'owner' }`
- visitor session returns `{ role: 'visitor', appId, sessionId, visitorId }`

### Current alignment with the contract

**Mismatch**.

The current implementation still leaks the older visitor model into multiple layers.

The good news:

- there is already a real access/session object in auth state
- the server already owns access checks
- the UI already asks the server who the current actor is

The main mismatches:

- there is no explicit `Principal` object or `principalId`
- current non-owner access is modeled as `role: 'visitor'`
- current visitor access is pinned to exactly one session in many places, not modeled as a broader app-scoped principal
- session ownership currently records `visitorId`, not a general initiating principal id

### Current working interpretation

Until the auth/domain refactor happens, read the current model as:

- `role: 'owner'` = owner principal
- `role: 'visitor'` + `appId/sessionId/visitorId` = temporary stand-in for an app-scoped non-owner principal flow
- `visitorId` on sessions = temporary nearest analogue to a non-owner principal identifier

### Access enforcement today

Current access checks are server-side and mainly live in:

- `canAccessSession()` and `requireSessionAccess()` in `chat/router.mjs`
- owner-only route gating in `chat/router.mjs`
- visitor guardrails in prompt-building in `chat/session-manager.mjs`

This is good in one important sense:

- authorization is already server-enforced, not model-enforced

That part of the contract is already directionally correct.

---

## 5. ShareSnapshot

**Contract role:** standalone read-only publication object over a frozen session range.

### Current code owners

- `chat/shares.mjs`
- share creation route in `chat/router.mjs`
- share page template and frontend in `templates/share.html` and `static/share.js`

### Current storage

Share snapshots are stored in `~/.config/remotelab/shared-snapshots/<snapId>.json` via `CHAT_SHARE_SNAPSHOTS_DIR`.

Current snapshot shape is **materialized**, not reference-based.

Observed current fields:

- `version`
- `id`
- `createdAt`
- `session` — sanitized session info with `name`, `tool`, `created`
- `events` — sanitized materialized event list

Images are currently embedded into the share payload when needed by sanitizing them into base64 data.

### Current routes/surfaces

- `POST /api/sessions/:sessionId/share`
- `GET /share/:shareId`

### Current alignment with the contract

**Partial, with one important mismatch**.

The good news:

- share is already a separate object with its own persistence and route surface
- share is already read-only and public
- share is already clearly separated from normal authenticated chat access

The important mismatch:

- current snapshots do **not** preserve the contract’s preferred provenance shape of `sessionId + event boundary`
- instead, they materialize a copied sanitized event payload
- current snapshots do not have explicit revocation or expiry fields

So the current system already has the right product surface, but not yet the preferred long-term storage contract.

### Current working interpretation

Treat the current share implementation as:

- a v0/v1 materialized share snapshot
- good enough for current product behavior
- not yet the final range-based `ShareSnapshot` contract

### Field crosswalk

| Contract field/concept | Current representation | Notes |
|---|---|---|
| `ShareSnapshot.id` | `snapshot.id` | aligned |
| `ShareSnapshot.sessionId` | not stored explicitly in current snapshot file | important gap |
| frozen event boundary | implicit in copied `events` array | not explicit as `maxSeq` / `minSeq` |
| `createdByPrincipalId` | not stored | gap |
| `createdAt` | `snapshot.createdAt` | aligned |
| `revokedAt` | absent | gap |

---

## 6. Derived UI State

**Contract role:** derived, replaceable product surfaces rather than domain truth.

### Current code owners

- `chat/summarizer.mjs`
- `static/chat.js`
- `templates/chat.html`

### Current storage

Derived sidebar/progress state lives in `~/.config/remotelab/sidebar-state.json` via `SIDEBAR_STATE_FILE`.

### Current routes/surfaces

- `GET /api/sidebar`
- Progress tab in the main chat UI

### Current alignment with the contract

**Partial**.

The good news:

- sidebar/progress data is already stored separately from session history
- it is already fetchable as a derived surface

The important nuance:

- the sidebar state file itself is derived
- but the current summarizer pipeline also writes back canonical session metadata such as title/group/description via rename/grouping logic

So the system currently mixes two behaviors:

- derived sidebar rollup state
- model-assisted updates to canonical session presentation metadata

Those should not be confused.

### Current working interpretation

Use the following distinction when reading the code:

- `sidebar-state.json` = derived UI state
- `session.name`, `session.group`, `session.description` = canonical session metadata, even if a summarizer currently helps generate them

---

## Route-Level Crosswalk

This section groups the current routes by the contract object they primarily serve.

### Session-oriented routes

- `GET /api/sessions`
- `GET /api/sessions/:sessionId`
- `GET /api/sessions/:sessionId/events`
- `GET /api/sessions/:sessionId/events/:seq/body`
- `POST /api/sessions`
- `PATCH /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/messages`
- `POST /api/sessions/:sessionId/cancel`
- `POST /api/sessions/:sessionId/resume`
- `POST /api/sessions/:sessionId/compact`
- `POST /api/sessions/:sessionId/drop-tools`
- `POST /api/sessions/:sessionId/share`

### Run-oriented routes

- `GET /api/runs/:runId`
- `POST /api/runs/:runId/cancel`

### App-oriented routes

- `GET /api/apps`
- `POST /api/apps`
- `PATCH /api/apps/:appId`
- `DELETE /api/apps/:appId`
- `GET /app/:shareToken`

### Principal/auth routes

- `POST /login`
- `GET /login`
- `GET /logout`
- `GET /api/auth/me`

### Derived/share surfaces

- `GET /share/:shareId`
- `GET /api/sidebar`

---

## Main Current Mismatches To Keep In Mind

These are the most important gaps between contract and code right now.

### 1. Principal is still implicit

There is no explicit principal object yet.
Current non-owner flows are still named and shaped around `visitor`.

### 2. Default app is still implicit

The contract says every session belongs to an app.
Current code still allows owner sessions with no `appId`.

### 3. Session ownership is only partially represented

The contract wants `createdByPrincipalId`.
Current code only has a narrower `visitorId` for some non-owner flows.

### 4. App access is narrower than the future app-scoped principal model

Current visitor flows often pin access to exactly one session.
The contract wants to think in terms of app-scoped principal access, even if the UI remains narrow.

### 5. Share snapshots are materialized copies, not boundary records

Current shares work product-wise, but they do not yet match the target `ShareSnapshot` data model.

### 6. Some reads still reconcile/mutate

The contract wants a cleaner separation between read models and operational reconciliation.
Current session/run reads still sometimes trigger reconciliation work.

### 7. Sidebar logic still touches canonical presentation metadata

The contract demotes sidebar/progress to derived UI.
Current summarizer logic still participates in canonical rename/group/description updates.

---

## Migration-Safe Reading Rules

Until the codebase is refactored to match the contract more closely, use these rules when reasoning about the system.

1. Treat session as the primary durable truth humans care about.
2. Treat run as the execution record needed to safely operate the system.
3. Treat session history as more canonical than ad hoc run spool for product semantics.
4. Treat sessions without `appId` as belonging to the implicit built-in default app.
5. Treat `visitor` auth flows as the current implementation stand-in for app-scoped non-owner principals.
6. Treat current share JSON files as temporary materialized snapshots, not the final share contract.
7. Treat sidebar state as derived, but do not confuse that with session title/group/description, which are canonical session metadata.

---

## Recommended Next Mapping Step

This note deliberately stops one step short of a field-by-field migration plan.

The next useful companion note would be:

- a contract-to-code migration matrix listing the exact field renames, route behavior changes, and storage transitions needed to move from the current implementation to the contract

That future note should be written only when implementation work starts.

For now, this mapping note is enough to let separate sessions reason about the current codebase without re-deriving the same mental crosswalk each time.

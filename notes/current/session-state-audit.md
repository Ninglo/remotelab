# Session State Audit

## Update — Simplified contract landed

This audit has now been partially implemented in the shipped code.

What changed:

- the backend now exposes a first-class `session.activity` object for orthogonal server activity
- the frontend sidebar/header status rendering now reads backend `activity` instead of inventing `done`, `unread`, or local pending-delivery states
- local pending-send recovery is now in-memory only for the active compose flow instead of being persisted as durable UI state

Current backend activity contract:

- `activity.run.state` — `running | idle`
- `activity.run.phase` — underlying durable run phase when available
- `activity.queue.state` + `activity.queue.count`
- `activity.rename.state` + `activity.rename.error`
- `activity.compact.state`

What still remains as cleanup surface:

- the top-level session state mirrors have been removed from the client payload
- the legacy `activeRun` / `resume_interrupted` compatibility path has been removed

Goal: separate durable server truth from frontend-only display state before another round of UI fixes.

## 1. Current server-side truth

### Durable session metadata

RemoteLab stores session metadata in `chat-sessions.json`.

The fields that currently matter for state are:

- `activeRunId` — pointer to the current detached run
- `followUpQueue` — durable queued follow-up messages
- `autoRenamePending` — whether the session title is still allowed to auto-settle
- `name`, `group`, `description` — durable presentation metadata
- `claudeSessionId`, `codexThreadId` — provider resume ids
- `archived`, `pinned` — session management flags

`status` itself is not stored in session metadata. It is derived on read.

### Durable run state machine

Per-run truth lives under `chat-runs/<runId>/status.json`, `manifest.json`, `spool.jsonl`, and `result.json`.

The actual durable `run.state` values in code today are:

- `accepted`
- `running`
- `completed`
- `failed`
- `cancelled`

There are also important side fields:

- `cancelRequested` / `cancelRequestedAt`
- `completedAt`
- `finalizedAt` — detached output has been reconciled back into history/session metadata
- `claudeSessionId`, `codexThreadId`, `providerResumeId`

### Derived session API state

`getPersistedStatus()` currently returns:

- `running` — when `activeRunId` exists and the pointed run is non-terminal
- `interrupted` — when `activeRun` exists
- `idle` — otherwise

This means the server-side session status API is currently much narrower than the frontend display model.

### Important non-state signals that look like state

Some API fields are useful, but are not part of the durable session status axis:

- `queuedMessageCount` — derived from durable `followUpQueue`
- `recoverable` — derived from `activeRun` plus resume ids
- `pendingCompact` — derived from in-memory `sessionRuntimeStateById`
- `renameState` / `renameError` — derived from in-memory `sessionRuntimeStateById`

Also, normalized history `status` events such as `thinking`, `completed`, `error: ...`, and `cancelled` are transcript events. They are not the canonical session state machine.

## 2. Current frontend-derived display state

The browser adds several state layers on top of the server payload.

### Frontend rewrites `idle` into local `done`

`normalizeSessionStatus()` converts incoming server `idle` into client-local `done` when the previous client snapshot was `running` or `done`.

That means:

- `done` is not a server state
- `done` is not durable across reload
- completion semantics depend on each browser tab's prior memory

### Frontend-only attention / delivery state

The frontend also derives state from local storage and current-page memory:

- pending send delivery: `sending`, `accepted`, `failed`
- unread/read hints based on local “seen version” memory
- optimistic “running” while the message is locally pending delivery

### Frontend visual running state is broader than server `status`

The current visual model treats a session as effectively `running` when any of these are true:

- server `session.status === running`
- `pendingCompact === true`
- `queuedMessageCount > 0`
- local pending delivery exists

This is why “running” in the UI already means more than “there is an active run”.

### Renaming is rendered as a separate visual state

The UI shows `renaming` when `renameState === pending`.

But `renameState` is only held in `sessionRuntimeStateById` on the server, so it disappears on restart and is not a durable backend status.

## 3. Gaps and mismatches

### A. `interrupted` / `activeRun` is effectively legacy-only

`activeRun` is read and cleared, but the current live execution path does not write it anywhere.

Practical consequence:

- `session.status === interrupted` is not part of the normal detached-run recovery path
- `Resume` is now mostly a compatibility path for legacy/manual interrupted snapshots
- restart-safe recovery is primarily handled by detached runs + HTTP reconciliation, not `interrupted`

### B. `renameState` and `pendingCompact` are not durable

Both are exposed through the session API, but both come from server memory only.

Practical consequence:

- restart can drop those activity hints even when the user still conceptually thinks “the system is renaming/compacting something”

### C. `done` / `unread` is a client illusion, not shared truth

The server finishes a run by returning the session to `idle`.

The browser then sometimes rewrites that to `done`, and from there to `unread`.

Practical consequence:

- the same finished session can appear as `done`, `unread`, or plain `idle` depending on reload timing and local seen-state history

### D. Queue semantics are split across layers

The backend has a durable queue (`followUpQueue`), but does not promote queue presence into the server `status` field.

The frontend does promote queue presence into visual `running`.

That split is defensible, but it needs to be explicit.

### E. The HTTP route had a real contract bug

`submitHttpMessage()` already returns `queued`, but `POST /api/sessions/:sessionId/messages` did not include that field in its JSON response.

Practical consequence:

- frontend send flow could not reliably distinguish “accepted as a queued follow-up” from “accepted as a live run”

This round fixes that route bug.

### F. There is visible redundancy / dead layering

Examples found during this audit:

- `session-state-model.js` defines the current visual status model
- `bootstrap.js` still wraps and partially duplicates some of the same concepts
- `session-http.js` still contains a `maybeUpdateSessionUnreadState` hook, but there is no shipped implementation
- non-smoke tests still describe older `send-failed` / unread behaviors that do not match the current shipped state model
- `notes/current/core-domain-contract.md` still uses a broader run-lifecycle vocabulary (`queued`, `done`, `interrupted`, ...) than the actual `run.state` persistence layer

## 4. Answers to the current product framing

The user framing is directionally right, but the codebase currently mixes three different layers:

### Backend session truth today

- active run exists or not
- queued follow-ups exist or not
- title/group/description are settled or not
- resume metadata exists or not

### Backend volatile activity today

- rename suggestion currently running or failed
- compaction currently running

### Frontend attention / delivery state today

- message is being sent / accepted / failed locally
- finished session was seen or unseen on this device

The confusion comes from treating all three as one flat `status` field.

## 5. Questions to settle before redesign

1. Should the backend expose one explicit `activity` object instead of overloading `session.status`?
2. Is rename/grouping a first-class durable background task, or only best-effort polish?
3. Should “completed / unread” be server-authored, or remain per-device frontend attention state?
4. Should queued follow-ups be their own visible state instead of being collapsed into `running`?
5. Do we want to keep `resume_interrupted`, or remove it until we reintroduce a real interrupted snapshot writer?
6. Do we want one linear session status, or a small set of orthogonal axes such as:
   - run activity
   - queue backlog
   - naming activity
   - compaction activity

## 6. Recommended aggressive simplification

If elegance matters more than compatibility, the cleanest direction is:

1. Keep the durable backend truth minimal and explicit
   - `runState`
   - `queueCount`
   - `autoRenamePending`
   - optional durable `resumeSnapshot`
2. Stop rewriting server `idle` into client `done`
3. Move display-only hints into clearly client-local state
4. Expose backend activity through one explicit server envelope instead of scattered booleans
5. Delete legacy hooks/tests/docs after the migration lands

## 7. Suggested rewrite plan

### Phase A — immediate hygiene

- fix API/body mismatches such as missing `queued`
- document the current state split explicitly
- add regression tests around the HTTP contract

### Phase B — backend contract cleanup

- add a single `session.activity` payload for orthogonal backend activity
- keep `session.status` limited to true session/run lifecycle semantics or retire it entirely

### Phase C — frontend cleanup

- make sidebar/header rendering consume the explicit backend activity model
- keep unread/read as client attention only
- stop inventing backend-like states on the client

### Phase D — deletion pass

- remove dead interrupted compatibility paths unless they are rebuilt intentionally
- remove stale tests and stale hooks
- reconcile internal docs with the real contract

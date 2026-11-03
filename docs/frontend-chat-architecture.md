# Frontend Chat Architecture

This document is the current architecture contract for the chat frontend under `static/chat/`.

Use it when you need to:

- change the chat UI without re-discovering where state lives
- decide whether logic belongs in the backend, the frontend model, or the render layer
- add a new frontend feature without mixing transport, orchestration, and DOM work again
- review whether a refactor keeps the frontend aligned with the product direction

It complements:

- `docs/project-architecture.md` — top-down project map
- `notes/current/frontend-state-store-refactor.md` — why the store seam was introduced
- `static/chat/session-store.js` — the actual reducer/store contract

---

## 1. Frontend thesis

RemoteLab should not be a “thin frontend” in the simplistic sense.

The better target is:

- a protocol-light frontend
- with explicit client state
- that projects backend authority clearly
- without hiding orchestration in scattered globals and cross-file side effects

That means the frontend can stay fairly capable, but its capability must live in explicit boundaries.

---

## 2. State ownership

### 2.1 Server-authority projection

These facts are owned by the backend and projected into the browser:

- session records and ordering inputs
- session activity / queue / run state
- archived / pinned outcomes
- message and display-event timelines
- attachment metadata after upload / canonicalization
- share snapshot session payloads

Frontend code may cache or render these, but should converge back to backend HTTP state.

### 2.2 Client-owned coordination state

These are frontend-owned and may be reconstructed locally:

- current attached session id
- whether the current surface is attached yet
- sidebar tab selection
- source filter selection
- archived list loading / loaded flags
- shell-level derived status used by UI controls

This state belongs in the frontend store rather than scattered globals.

Session links (`?session=…`) select the conversation unless an explicit `tab`
parameter requests another view. Settings is temporary browser UI state: its
button toggles it, its close control returns to the workspace that opened it,
and opening it does not persist Settings as the next workspace. Explicit
`tab=settings` URLs still support direct entry and reload; older persisted
Settings values are ignored. Deferred Session loading preserves a newer user
choice, including closing Settings before that load finishes. The navigation
regressions live in `tests/test-monitor-navigation-race.mjs`.

New Sessions start in Auto. Switching to Custom without an existing concrete
selection uses `gpt-6-astra` with `low` effort. Keep the fallback values in
`bootstrap.js`, `sidebar-ui.js`, and `tooling.js` aligned with
`lib/legacy-micro-agent.mjs`; preserve saved concrete selections. Auto tier
models and efforts come from the server settings described in
[setup](setup.md#jev-auto-model-routing).

### 2.3 View-only ephemeral state

These should stay in render/UI code and should not leak into the shared shell state model:

- collapsed folder UI
- code-copy button state
- lazy body hydration flags
- local textarea sizing
- attachment preview object URLs
- one-frame layout / scroll / expansion details

---

## 3. Layer contract

### 3.1 Model / state boundary

Files:

- `static/chat/session-store.js`
- `static/chat/composer-store.js`
- `static/chat/session-state-model.js`
- `static/chat/bootstrap.js`

Responsibilities:

- define canonical frontend shell state
- define canonical composer workflow state shared across render files
- perform pure state transitions
- expose one explicit write boundary for store-owned shell state
- keep fallback state synchronization in one place when tests run files without full bootstrap

`bootstrap.js` is the only file that should own the shell-state helper boundary:

- `replaceChatState(...)`
- `replaceActiveChatSessionsState(...)`
- `replaceArchivedChatSessionsState(...)`
- `upsertChatSessionState(...)`
- `removeChatSessionState(...)`
- `setChatCurrentSession(...)`
- `setChatArchivedSessionsLoading(...)`
- `setChatActiveSourceFilter(...)`
- `setChatActiveTab(...)`
- `setChatSessionStatus(...)`

`composer-store.js` owns the dedicated composer-state boundary:

- `setComposerActiveSession(...)`
- `setComposerDraftTextState(...)`
- `replaceComposerAttachmentsState(...)`
- `addComposerAttachmentsState(...)`
- `removeComposerAttachmentState(...)`
- `clearComposerSessionState(...)`
- `setComposerPendingSendState(...)`
- `patchComposerPendingSendState(...)`
- `clearComposerPendingSendState(...)`

### 3.2 Adapter layer

Files:

- `static/chat/session-http.js`
- `static/chat/session-http-list-state.js`
- `static/chat/realtime.js`

Responsibilities:

- fetch backend resources
- decode transport responses / invalidation signals
- normalize payloads into frontend state transitions
- call the shell-state helper boundary instead of mutating shell globals directly

Rules:

- adapter files do not own shell state
- adapter files do not dispatch shell action types directly
- adapter files do not decide long-lived DOM state outside explicit render hooks

Session event snapshots are a bounded browser-only display cache in `session-http.js`.
Reattaching one of the last eight viewed Sessions renders its cached timeline
immediately, then fetches the authoritative visible events and reconciles the
display. Share snapshots do not enter this cache. The cache does not replace
server history or the session store.

### 3.3 Catalog / selector layer

Files:

- `static/chat/bootstrap-session-catalog.js`

Responsibilities:

- derive filtered / grouped / sorted session views
- persist navigation/filter preferences
- bridge between shell state and UI-specific list decisions

This layer may keep small local mirrors for UI convenience, but shared shell state still flows through the store boundary.

### 3.4 Render layer

Files:

- `static/chat/session-list-ui.js`
- `static/chat/session-surface-ui.js`
- `static/chat/realtime-render.js`
- `static/chat/ui.js`
- `static/chat/sidebar-ui.js`
- `static/chat/compose.js`
- `static/chat/settings-ui.js`

Responsibilities:

- render current state
- capture user intent
- call adapter actions / shell helpers / composer helpers
- keep DOM-only behavior local

Render files should not become the hidden owner of cross-file shell state or composer workflow state.

---

## 4. Current file map

### 4.1 Good current anchors

- `static/chat/session-store.js` — explicit shell reducer/store
- `static/chat/composer-store.js` — explicit composer draft / attachment / pending-send reducer/store
- `static/chat/session-state-model.js` — reusable session activity/status semantics
- `static/chat/realtime-render.js` — mostly render-oriented timeline work
- `static/chat/session-surface-ui.js` — attached-session presentation helpers

### 4.2 Files that still mix concerns, but are now bounded better

- `static/chat/session-http.js` — still large, but shell-state writes now go through shared helpers
- `static/chat/realtime.js` — still mixes transport and command flow, but shell-state writes are narrowed
- `static/chat/bootstrap-session-catalog.js` — still bridges selectors and persistence, but now points at explicit shell state
- `static/chat/compose.js` — still combines send workflow and UI, but shared draft / attachment / pending-send state now routes through `static/chat/composer-store.js`
- `static/chat/sidebar-ui.js` — still owns attachment-picker DOM behavior, but no longer owns the attachment state container directly

---

## 5. Non-drift rules

When adding or refactoring frontend behavior:

1. If the state is shared across files, define its owner first.
2. If adapter code needs to change shell state, route it through the `bootstrap.js` helper boundary.
3. If a new feature adds durable or shared client state, extend the store/model before adding more globals.
4. If the state is purely presentational, keep it in render/UI code and do not promote it into shell state casually.
5. If a file starts doing transport + state mutation + DOM work together, split the responsibility before adding more logic.

---

## 6. What this round completes

This refactor round completes the shell-state boundary for the existing session/navigation surface:

- session list replacement
- archived list replacement
- session upsert / removal
- current-session attachment state
- sidebar tab and source filter state
- archived loading flags
- shell session status

It also completes a dedicated composer workflow slice for frontend-only shared state:

- per-session draft text mirror
- per-session queued attachment state
- pending send lifecycle state
- attachment add / remove / send / clear transitions

The composer send file still owns upload orchestration and DOM timing, but it no longer owns the shared composer state container itself.

---

## 7. Enforcement

The repo now carries a focused frontend boundary test:

- `tests/test-chat-frontend-state-boundary.mjs`
- `tests/test-chat-composer-store.mjs`
- `tests/test-chat-compose-draft.mjs`
- `tests/test-chat-sidebar-attachments.mjs`

These tests do not try to prove every UI detail. Their job is to make architectural drift visible when adapter files bypass the shared shell-state boundary again or when composer workflow state starts leaking back into ad hoc globals.

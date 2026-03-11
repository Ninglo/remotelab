# Core Domain Refactor TODO

> Status: execution checklist derived from the current domain contract and current implementation mapping.
> Use this note when you want to turn the architecture discussion into concrete implementation sessions.
>
> Inputs:
>
> - `notes/current/core-domain-contract.md`
> - `notes/current/core-domain-implementation-mapping.md`
> - `notes/current/core-domain-session-prompts.md`
>
> This note is intentionally action-oriented.
> It does not redefine the product model; it decomposes the work needed to move the codebase toward that model.

---

## How To Use This Note

This note is designed for multi-session execution.

Each future session should ideally pick **one slice** and keep the change surface narrow.

The purpose is:

- reduce context loss between sessions
- avoid mixing unrelated refactors in one conversation
- keep code review and validation more predictable
- make it obvious what “done” means for each step

If two slices overlap heavily, finish the upstream one first instead of merging them ad hoc.

---

## Execution Principles

### 1. Contract first, code second

If current code conflicts with `notes/current/core-domain-contract.md`, treat the contract as the target shape unless we explicitly reopen the decision.

### 2. Prefer one dominant surface per session

A good session usually has one dominant touch surface:

- auth/access
- session metadata/history
- run lifecycle
- app entry model
- share model
- frontend filtering/surfaces
- docs/tests

### 3. Avoid mixing naming cleanup with semantic changes

Do not combine:

- large renames
- route behavior changes
- storage migration
- UI rewrites

in the same session unless the change is tiny.

### 4. Preserve backward readability while migrating

When changing persisted shapes, prefer:

- additive fields first
- fallback readers
- compatibility shims
- delayed cleanup after the new path is stable

### 5. Tests should follow contract boundaries

When a slice changes behavior, validation should match the object boundary being changed:

- session tests for session semantics
- run tests for execution semantics
- auth tests for principal/access behavior
- share tests for snapshot/public access behavior

---

## Status Snapshot

### Already completed

- `[x]` Domain contract frozen in `notes/current/core-domain-contract.md`
- `[x]` Current implementation crosswalk written in `notes/current/core-domain-implementation-mapping.md`
- `[x]` Notes tree reorganized into `current/`, `directional/`, `archive/`, `local/`

### Next implementation focus

The highest-leverage sequence is:

1. default app + principal groundwork
2. session ownership and access-scoping helpers
3. app entry flow cleanup
4. share snapshot contract cleanup
5. run/session boundary cleanup
6. derived UI + frontend surface cleanup
7. docs terminology sweep + regression harness tightening

---

## Ready-Now Menu

This section answers a practical question:

- what can we start **right now** with little or no extra product re-discussion?

The categories below are deliberately strict.

- **Ready now** = we can start from the existing contract and mapping docs with no meaningful extra product decisions.
- **One-line clarification** = one short instruction from the user is enough to start.
- **Not ideal yet** = better to wait until upstream slices land.

### Ready now

These are the best low-friction execution slices right now.

#### `R2` — Principal/Auth-Session Normalization

Why it is ready:

- the contract is already clear enough
- current code already has server-enforced auth
- the main work is internal normalization, not product redesign

What you would need to say:

- “Do `R2`, keep external behavior backward compatible.”

Good session guardrail:

- do not touch frontend beyond compatibility if avoidable

#### `R3` — Session Ownership Field

Why it is ready:

- the contract already says sessions need a general initiating-principal field
- this can be added additively without changing the whole UI

What you would need to say:

- “Do `R3`, additive migration only, don’t break old sessions.”

Good session guardrail:

- no frontend work unless a tiny compatibility patch is required

#### `R4` — Session Access Helper Refactor

Why it is ready:

- once auth/session ownership helpers are in place, this is a backend-only tightening pass
- it improves safety and clarity without needing new product decisions

What you would need to say:

- “Do `R4`, keep current visible behavior but move checks to principal/app terms.”

Good session guardrail:

- avoid changing app entry UX in the same session

#### `R8` — Run/Session Truth Boundary Cleanup

Why it is ready:

- the conceptual rule is already agreed
- this mostly needs disciplined backend cleanup and helper boundaries

What you would need to say:

- “Do `R8`, no API redesign, just tighten boundaries.”

Good session guardrail:

- avoid read-path cleanup in the same session unless it is a tiny follow-on fix

#### `R9` — Read-Path Reconciliation Cleanup

Why it is ready:

- the architectural smell is already documented
- this is mainly control-plane behavior cleanup

What you would need to say:

- “Do `R9`, prioritize making reads more side-effect free.”

Good session guardrail:

- do not mix with frontend changes

#### `R12` — Docs And Terminology Sweep

Why it is ready:

- the contract, mapping, and note taxonomy are already settled enough
- this can be done incrementally without product risk

What you would need to say:

- “Do `R12`, align docs to the new contract.”

Good session guardrail:

- don’t sneak in behavior changes unless required for accuracy

#### `R13` — Regression Harness And Validation Pack

Why it is ready:

- testing can start in parallel with most slices
- it reduces fear for all later work

What you would need to say:

- “Do `R13`, start with auth/session/share contract coverage.”

Good session guardrail:

- do not try to fix unrelated product bugs just because tests expose them

### One-line clarification needed

These are also very close, but each wants one short decision before implementation.

#### `R1` — Default App Strategy

Needed one-line decision:

- “Use an explicit persisted default app record.”
  or
- “Use a reserved implicit default app id first.”

Why it wants that decision:

- otherwise we risk doing the migration twice

#### `R5` — Session List Filters For Owner/Admin

Needed one-line decision:

- “Owner filters should be `appId` + `principalId` query params.”

Why it wants that decision:

- the backend filter API should not be guessed casually

#### `R6` — App Entry Flow Cleanup

Needed one-line decision:

- “Shared app entry should still land in one scoped session first.”
  or
- “Shared app entry should land in an app-scoped home/list surface.”

Why it wants that decision:

- that choice changes auth/session bootstrap behavior substantially

#### `R7` — ShareSnapshot Contract Upgrade

Needed one-line decision:

- “Do a hybrid upgrade first: add provenance fields, keep current materialized snapshot payload.”
  or
- “Go straight to boundary-based share records.”

Why it wants that decision:

- both are valid, but they imply different migration strategies

#### `R10` — Derived Sidebar/Progress Demotion

Needed one-line decision:

- “Keep Progress UI for now but mark it non-core.”
  or
- “Hide/de-emphasize Progress UI while keeping backend compatibility.”

Why it wants that decision:

- the product surface choice affects how much frontend churn we take on

#### `R11` — Frontend Owner/Non-Owner Surface Alignment

Needed one-line decision:

- “Unauthorized app/session navigation should redirect to login.”
  or
- “Unauthorized app/session navigation should show a scoped unauthorized page.”

Why it wants that decision:

- the UX fallback should be consistent before UI work begins

### Not ideal yet

These are not blocked forever; they are just lower quality starting points right now.

#### Broad combined backend+frontend refactors

Examples:

- `R6` + `R11`
- `R8` + `R11`
- `R9` + broad UI cleanup

Why not ideal:

- they sprawl fast and make validation much harder

#### Large storage redesign beyond the current contract

Examples:

- moving history to a new format everywhere
- redesigning all share persistence before deciding the hybrid path

Why not ideal:

- too much churn before the core app/principal/session model is fully reflected in code

---

## Recommended Order

### Foundation

- `R1` Default app strategy
- `R2` Principal/auth-session normalization
- `R3` Session ownership field

### Access and product-surface alignment

- `R4` Session access helper refactor
- `R5` Session list filters for owner/admin
- `R6` App entry flow cleanup

### Domain storage/contract alignment

- `R7` ShareSnapshot contract upgrade
- `R8` Run/session truth boundary cleanup
- `R9` Read-path reconciliation cleanup

### UX and cleanup

- `R10` Derived sidebar/progress demotion
- `R11` Frontend owner/non-owner surface alignment
- `R12` Docs and terminology sweep
- `R13` Regression harness and validation pack

The only hard prerequisites are the foundation slices.
After that, several tracks can run separately.

---

## Slice Index

- `R1` Default app strategy
- `R2` Principal/auth-session normalization
- `R3` Session ownership field
- `R4` Session access helper refactor
- `R5` Session list filters for owner/admin
- `R6` App entry flow cleanup
- `R7` ShareSnapshot contract upgrade
- `R8` Run/session truth boundary cleanup
- `R9` Read-path reconciliation cleanup
- `R10` Derived sidebar/progress demotion
- `R11` Frontend owner/non-owner surface alignment
- `R12` Docs and terminology sweep
- `R13` Regression harness and validation pack

---

## R1 — Default App Strategy

**Goal**

Make the contract rule “every session belongs to an app” true in data/model terms.

**Why it matters**

Current owner sessions can exist with no `appId`, which keeps “normal chat” as a special case.
That special case will keep leaking into routing and UI unless we resolve it.

**Depends on**

- contract only

**Dominant surface**

- app/session metadata layer

**Primary files**

- `chat/apps.mjs`
- `chat/session-manager.mjs`
- possibly `chat/router.mjs`
- tests touching session creation/listing

**Tasks**

- Choose one strategy for the built-in default app:
  - explicit persisted app record
  - or reserved implicit id with one helper layer
- Add one canonical helper for resolving the effective app of a session.
- Ensure newly created owner sessions always get an effective app identity.
- Backfill or derive app identity for legacy owner sessions on read/write paths.
- Prevent future code from treating owner chat as app-less.

**Keep out of scope**

- principal/access model changes
- frontend app filters
- share changes

**Done means**

- new sessions no longer appear as app-less in canonical session data
- owner chat is no longer a silent exception in new code paths
- tests cover session creation/listing with effective default app behavior

---

## R2 — Principal/Auth-Session Normalization

**Goal**

Replace the current visitor-centric internal auth thinking with a principal/scoped-auth shape, while preserving working login behavior.

**Why it matters**

Today the code already has server-enforced auth, but the data model still leaks `role: 'visitor'` and session-pinned assumptions.
That blocks cleaner access rules.

**Depends on**

- contract only

**Dominant surface**

- auth/session normalization layer

**Primary files**

- `lib/auth.mjs`
- `chat/router.mjs`
- `chat/session-manager.mjs`
- tests around auth and access

**Tasks**

- Define one internal normalized auth shape that represents principal scope cleanly.
- Preserve current cookie/session behavior while enriching the normalized auth object.
- Decide what minimal fields are needed now, for example:
  - effective principal id
  - principal kind
  - app scope
  - optional current session scope
- Stop forcing unrelated code to reason in raw `visitor` terms.
- Keep `/api/auth/me` backward compatible if needed, but allow future richer auth info.

**Keep out of scope**

- session ownership migration
- frontend filters and UI work
- share storage redesign

**Done means**

- route/session code can reason in principal terms internally
- `visitor` is no longer the only non-owner abstraction in auth helpers
- tests cover owner and app-scoped non-owner normalization

---

## R3 — Session Ownership Field

**Goal**

Introduce a contract-aligned session ownership field such as `createdByPrincipalId`.

**Why it matters**

The contract needs a general initiating-principal field.
Current code only has `visitorId` for some non-owner flows, which is too narrow.

**Depends on**

- `R1`
- `R2`

**Dominant surface**

- session metadata layer

**Primary files**

- `chat/session-manager.mjs`
- `chat/router.mjs`
- migration/backfill helpers if introduced
- tests for session creation and list visibility

**Tasks**

- Add one canonical ownership field to session metadata.
- Decide how owner-created sessions are represented.
- Decide how app-scoped non-owner sessions are represented.
- Backfill or infer ownership for legacy sessions.
- Stop relying on `visitorId` as the only ownership clue.

**Keep out of scope**

- owner filter UI
- share contract changes
- read-path reconciliation cleanup

**Done means**

- newly created sessions always record their initiating principal in a general form
- session access logic can use the new field instead of ad hoc visitor-only checks
- tests verify owner and non-owner session creation metadata

---

## R4 — Session Access Helper Refactor

**Goal**

Centralize session visibility rules around principal scope and app scope.

**Why it matters**

Current access logic is still largely “owner sees all, visitor sees one session”.
That is narrower and more ad hoc than the contract.

**Depends on**

- `R2`
- `R3`

**Dominant surface**

- backend access/authorization helpers

**Primary files**

- `chat/router.mjs`
- `chat/session-manager.mjs`
- maybe `chat/middleware.mjs`
- tests for access rules

**Tasks**

- Replace or wrap `canAccessSession()` / `requireSessionAccess()` with principal-aware helpers.
- Define one rule set for:
  - owner access
  - app-scoped non-owner access
  - public share access
- Ensure all session and run routes rely on the same helper path.
- Remove duplicated route-level assumptions where practical.

**Keep out of scope**

- frontend filters
- app entry UX changes
- share storage redesign

**Done means**

- access rules for session and run reads/writes live in one clear helper layer
- non-owner access is described in principal/app terms, not only visitor/session terms
- tests cover forbidden and allowed cases across list/detail/run routes

---

## R5 — Session List Filters For Owner/Admin

**Goal**

Add server-backed app/principal filtering for owner/admin views without changing non-owner scope.

**Why it matters**

This is the backend half of the product expression you described:
owner can inspect by app and by user/principal; non-owner should not get a global browsing surface.

**Depends on**

- `R3`
- `R4`

**Dominant surface**

- session list route and query handling

**Primary files**

- `chat/router.mjs`
- `chat/session-manager.mjs`
- tests for list filtering

**Tasks**

- Define supported owner-only list filters, likely:
  - `appId`
  - `principalId`
  - maybe archive state if useful
- Ensure owner filtering is explicit and server-side.
- Ensure non-owner requests do not gain unauthorized global list access.
- Decide whether ignored filters or `403` are better for non-owner requests.

**Keep out of scope**

- actual frontend controls
- app entry flow changes
- auth session model changes

**Done means**

- owner can retrieve filtered session lists by app/principal
- non-owner list behavior remains safely scoped
- route tests cover both filter behavior and denial behavior

---

## R6 — App Entry Flow Cleanup

**Goal**

Replace the current visitor-session bootstrap path with a cleaner app-scoped principal/session creation model.

**Why it matters**

Current `/app/:shareToken` flow creates a visitor auth session and immediately pins it to one chat session.
That works, but it is narrower than the contract and hard to extend.

**Depends on**

- `R2`
- `R3`
- `R4`

**Dominant surface**

- app entry/auth bootstrap flow

**Primary files**

- `chat/router.mjs`
- `lib/auth.mjs`
- `chat/session-manager.mjs`
- possibly frontend bootstrap logic in `static/chat.js`

**Tasks**

- Decide the intended v1 app entry behavior:
  - enter app then create one scoped session
  - or enter app and land in an app home view that can create/list allowed sessions
- Replace raw visitor semantics with principal/app-scope semantics internally.
- Keep welcome-message and app bootstrap behavior intact.
- Decide whether shared demo apps use a shared principal or per-entry principal.

**Keep out of scope**

- share snapshot redesign
- owner filter UI
- sidebar cleanup

**Done means**

- app entry no longer depends conceptually on a visitor-only model
- auth/session bootstrap code reflects app-scoped principal thinking
- tests cover the chosen app-entry behavior end-to-end

---

## R7 — ShareSnapshot Contract Upgrade

**Goal**

Move the current share implementation closer to the contract.

**Why it matters**

Current shares work product-wise, but they are materialized copies without explicit provenance fields like `sessionId`, `maxSeq`, `createdByPrincipalId`, or `revokedAt`.

**Depends on**

- `R3`
- ideally `R4`

**Dominant surface**

- share storage and public share behavior

**Primary files**

- `chat/shares.mjs`
- `chat/router.mjs`
- share tests
- possibly share page/template if payload shape changes

**Tasks**

- Decide the near-term target:
  - fully boundary-based snapshot record
  - or hybrid record that keeps current materialized payload while adding contract fields
- Add explicit share provenance fields.
- Add explicit revocation representation.
- Decide and encode archive/share interaction.
- Preserve readability for existing share snapshots if any exist.

**Keep out of scope**

- app entry auth changes
- frontend owner filters
- sidebar cleanup

**Done means**

- the stored share object explains what source session/range it came from
- revocation is representable
- tests cover share creation, public reading, and archive/revoke behavior

---

## R8 — Run/Session Truth Boundary Cleanup

**Goal**

Make the contract line “session owns durable product truth, run owns execution truth” explicit in code.

**Why it matters**

Today the structure is close, but some provider/runtime details still leak across boundaries and the boundary is not crisply documented in code behavior.

**Depends on**

- `R3`

**Dominant surface**

- session/run lifecycle and normalization paths

**Primary files**

- `chat/session-manager.mjs`
- `chat/runs.mjs`
- `chat/history.mjs`
- runner/finalization helpers

**Tasks**

- Identify which run fields are purely operational and should stay run-only.
- Identify which facts must always be normalized into session history/metadata.
- Reduce unnecessary duplication of provider resume/execution identifiers across layers.
- Tighten comments and helper boundaries so future code follows the same split.

**Keep out of scope**

- principal auth redesign
- share contract changes
- frontend surface work

**Done means**

- there is a clear code-level answer to “does this fact belong to session or run?”
- finalized user-visible outputs are consistently represented in session truth
- run remains the home of execution-only details

---

## R9 — Read-Path Reconciliation Cleanup

**Goal**

Reduce or isolate side effects during session/run reads.

**Why it matters**

The mapping note already calls out that some GET paths still reconcile or finalize work on the fly.
That makes caching and reasoning harder.

**Depends on**

- `R8`

**Dominant surface**

- control-plane read behavior

**Primary files**

- `chat/session-manager.mjs`
- `chat/runs.mjs`
- `chat/router.mjs`
- tests around read behavior

**Tasks**

- Identify reads that still trigger reconciliation/finalization.
- Move what can be moved into observer/background paths.
- Keep read behavior predictable where possible.
- Add timing/instrumentation if needed to confirm improvement.

**Keep out of scope**

- frontend UI changes
- app entry/auth redesign

**Done means**

- session/run reads are easier to reason about as reads
- reconcile-on-read is reduced, documented, or isolated behind explicit helpers
- tests cover expected read behavior after active or completed runs

---

## R10 — Derived Sidebar/Progress Demotion

**Goal**

Remove Progress-specific derived state and clearly separate canonical session metadata from any future secondary sidebar surface.

**Why it matters**

The product direction has already demoted sidebar summary from core architecture.
The code should reflect that more clearly.

**Depends on**

- none strictly, but easier after `R8`

**Dominant surface**

- summarizer / derived UI state

**Primary files**

- `chat/summarizer.mjs`
- `static/chat.js`
- `templates/chat.html`
- route/docs references that still assume Progress has backend state

**Tasks**

- Remove Progress-specific backend state, routes, and frontend rendering logic.
- Keep only the tab-shell behavior in the UI so the slot can host future non-session surfaces.
- Ensure future task-progress UX is modeled through session-list grouping rather than a separate derived summary board.

**Keep out of scope**

- app/principal auth changes
- share storage redesign

**Done means**

- no separate Progress state exists in the shipped backend
- canonical session title/group/description no longer feel conceptually owned by a Progress system
- the remaining empty tab shell is explicitly future-facing, not a hidden dependency

---

## R11 — Frontend Owner/Non-Owner Surface Alignment

**Goal**

Make the frontend reflect the intended product shape:
owner can filter broadly; non-owner sees only their scoped surface.

**Why it matters**

This is the visible product expression of the contract and access model.

**Depends on**

- `R4`
- `R5`
- ideally `R6`

**Dominant surface**

- frontend session/app browsing behavior

**Primary files**

- `static/chat.js`
- `templates/chat.html`
- maybe `templates/login.html`

**Tasks**

- Add owner-only app filter and principal filter controls if still desired.
- Keep non-owner UI naturally scoped instead of showing global browsing controls.
- Decide the unauthorized behavior for bad app/session navigation:
  - dedicated unauthorized page
  - redirect to login
  - or scoped fallback with explanation
- Keep app selection/query state clearly as navigation, not authority.

**Keep out of scope**

- storage migrations
- share contract changes
- run lifecycle cleanup

**Done means**

- owner sees the richer browsing surface
- non-owner sees a simple scoped surface
- UI matches server access behavior instead of implying broader authority

---

## R12 — Docs And Terminology Sweep

**Goal**

Bring project docs and comments into alignment with the new contract.

**Why it matters**

Even after code changes, stale vocabulary like `visitor` or “app as template only” will keep causing drift.

**Depends on**

- at least `R2`, `R4`, `R6` so we do not document a shape that code does not yet follow

**Dominant surface**

- docs and inline explanatory comments

**Primary files**

- `docs/project-architecture.md`
- `README.md`
- `README.zh.md`
- `AGENTS.md`
- selected code comments/docstrings

**Tasks**

- Replace outdated mental-model explanations.
- Clarify principal vs user vs public-share reader language.
- Clarify default app behavior.
- Clarify share semantics.
- Demote sidebar/progress in docs if still overemphasized.
- Add a precise file-level concept→implementation guide so future sessions can route to the right files without broad repo searches.

**Keep out of scope**

- new product design work
- code behavior changes not needed for doc accuracy

**Done means**

- a new contributor gets one coherent model from docs, not two competing ones

---

## R13 — Regression Harness And Validation Pack

**Goal**

Build enough test coverage around the new contract boundaries that future refactors stop feeling blind.

**Why it matters**

Most of the upcoming work changes boundaries, not just internals.
That is exactly where a small but deliberate regression pack pays off.

**Depends on**

- can begin early, but should expand alongside `R4`, `R6`, `R7`, `R8`, `R9`

**Dominant surface**

- tests and validation docs

**Primary files**

- test files around auth, sessions, runs, shares, and UI-adjacent HTTP behavior
- possibly validation notes under `docs/` or `notes/current/`

**Tasks**

- Add/expand tests for:
  - session ownership and effective app behavior
  - principal-scoped session access
  - owner session filtering by app/principal
  - app entry flow behavior
  - share creation/read/revoke/archive behavior
  - run/session boundary invariants where practical
- Keep tests grouped by contract boundary rather than by incidental file.
- Preserve a lightweight smoke path for self-hosting validation.

**Keep out of scope**

- unrelated feature additions
- large formatting-only churn

**Done means**

- the main domain/access/share changes have regression coverage
- later cleanup sessions can refactor with much higher confidence

---

## Suggested Session Packaging

If future work is split across multiple conversations, these are good combinations:

### Best small single-session slices

- `R1` alone
- `R2` alone
- `R3` alone
- `R5` alone
- `R7` alone
- `R10` alone
- `R12` alone

### Good paired slices when momentum is high

- `R2` + `R3`
- `R4` + `R5`
- `R8` + `R9`
- `R11` + `R12`

### Slices that should usually stay separate

- `R6` and `R7`
- `R6` and `R11`
- `R8` and `R11`
- `R9` and broad frontend work

Those pairs are likely to sprawl if merged casually.

---

## Priority If We Need To Be Ruthless

If time or attention is limited, the most important slices are:

1. `R2` Principal/auth-session normalization
2. `R3` Session ownership field
3. `R4` Session access helper refactor
4. `R6` App entry flow cleanup
5. `R7` ShareSnapshot contract upgrade
6. `R8` Run/session truth boundary cleanup

Those six slices do the most to bring the live code back under one coherent model.

If the goal is specifically “start something immediately with almost no re-briefing”, the best choices are:

1. `R2` Principal/Auth-Session Normalization
2. `R3` Session Ownership Field
3. `R8` Run/Session Truth Boundary Cleanup
4. `R12` Docs And Terminology Sweep
5. `R13` Regression Harness And Validation Pack

---

## Final Operating Rule

When a future session begins, the safest process is:

1. read the contract
2. read the implementation mapping
3. pick exactly one TODO slice from this file
4. stay inside that slice unless a tiny compatibility patch is required
5. update the slice status or memory pointer when finished

That should keep future work focused and prevent the architecture from diffusing again.

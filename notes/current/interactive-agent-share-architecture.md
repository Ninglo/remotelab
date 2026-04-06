# Interactive Agent Share Architecture

> Status: current design decision for reopening interactive non-owner Agent share.
> Purpose: define one clean model for interactive Agent share so implementation does not accrete more `visitor`- and session-pin-specific logic.
> Scope: interactive share of an Agent. Read-only publication remains the separate `ShareSnapshot` domain.
> Precedence: on interactive Agent share behavior, this note takes precedence over `notes/current/session-first-product-contraction.md` until those docs are reconciled.

---

## Problem Definition

RemoteLab currently has two different things called "share":

- read-only publication of a frozen conversation slice
- interactive entry into a reusable Agent

Those are not the same product concept and should not share the same mental model.

The current interactive share path is also too narrow:

- `/agent/:shareToken` mints a non-owner auth session
- immediately creates one pinned session
- redirects into the main chat surface using visitor-specific transport flags
- relies on a `visitor`-centric access model that is effectively "owner sees all, visitor sees one session"

That shape is hard to extend, and it directly caused the current product bug where share login state exists but the UI still boots as the owner shell.

---

## Goals

- Make interactive Agent share a first-class, reusable architecture instead of a compatibility path.
- Make shared-agent interaction use the same chat/session shell as the owner by default.
- Let a non-owner who enters a shared Agent create and manage multiple sessions under that Agent.
- Keep all access control server-enforced and scope-limited to the shared Agent.
- Remove the need for `visitor`-specific frontend shell branching and query-flag transport tricks.
- Keep read-only `ShareSnapshot` separate from interactive Agent access.

## Non-Goals

- Building a general multi-user account system.
- Turning RemoteLab into a global shared workspace by default.
- Giving shared users the owner's unrestricted machine-control surface.
- Redesigning `ShareSnapshot` storage in the same pass.
- Solving collaborative multi-principal shared session pools in v1.

---

## One-Line Product Decision

> Shared Agent entry lands in an agent-scoped home/list surface, not in one pre-pinned session.

That means:

- interactive share shares an `Agent`, not a fixed `Session`
- the entering user gets an Agent-scoped workspace
- they can create multiple sessions under that Agent
- they do not see other Agents or Agent management UI
- they stay inside one capability-limited scope enforced by the server

---

## Core Domain Model

RemoteLab should use these durable objects for interactive Agent share:

### 1. `Agent`

Reusable policy and bootstrap for a family of sessions.

It owns:

- behavior/bootstrap instructions
- welcome/opening behavior
- presentation defaults
- capability policy defaults for non-owner access
- optional runtime override policy

It does not own:

- a live conversation thread
- a read-only publication record
- the identity of the acting principal

### 2. `AgentAccessGrant`

Interactive access/distribution object for a shared Agent.

It owns:

- `agentId`
- public entry token material
- status such as active or revoked
- grant-level policy overrides if needed later
- audit/provenance metadata

It exists so Agent distribution is not coupled to the Agent record itself.

Current `shareToken` fields on Agent records should be treated as compatibility state and migrated toward a distinct access-grant model.

### 3. `Principal`

The authenticated access subject.

Minimal normalized fields:

- `principalId`
- `principalKind`
- `scope.agentId` when the principal is Agent-scoped
- `capabilities`
- `surfaceMode`
- optional current-session hint, but not as the core scope model

Initial principal kinds:

- `owner`
- `agent_guest`

`visitor` should remain only as a compatibility implementation detail during migration, not a canonical domain concept.

### 4. `Session`

One durable work thread under one Agent and one initiating principal.

For interactive Agent share, session metadata should canonically record:

- `agentId`
- `createdByPrincipalId`

Current `templateId` / `templateName` fields can survive as compatibility aliases during migration, but the clean model is that a session belongs to one `Agent`.

### 5. `Run`

One execution attempt under a session.

No share-specific semantics should be pushed down into `Run`.

### 6. `ShareSnapshot`

Read-only publication over frozen session history.

This remains a different domain object from interactive Agent access and should not be conflated with `AgentAccessGrant`.

---

## Shared Workspace Decision

The default interactive share mode is:

> per-principal private workspace under one shared Agent

In practice:

- a shared link grants access to one Agent scope
- a non-owner principal can create many sessions in that scope
- that principal sees only its own sessions in that scope by default
- a different browser/profile/incognito entry may become a different principal

This is intentionally not the same as:

- all people with the link sharing one common session list
- all people with the link sharing one common live thread

If collaborative shared pools are ever needed, they should be modeled later as a separate access mode, not mixed into the default Agent-share path.

---

## Auth, Scope, And Capability Model

The backend should normalize auth into one principal-aware shape instead of scattering `role === 'visitor'` checks.

### Canonical auth/session shape

Example normalized auth payload:

```json
{
  "principalId": "prn_...",
  "principalKind": "agent_guest",
  "scope": {
    "agentId": "agent_..."
  },
  "capabilities": {
    "listSessions": true,
    "createSession": true,
    "renameSession": true,
    "archiveSession": true,
    "forkSession": true,
    "uploadAttachments": true,
    "downloadArtifacts": true,
    "manageAgents": false,
    "switchAgents": false,
    "browseLocalPaths": false,
    "changeRuntime": false,
    "publishShareSnapshot": false
  },
  "surfaceMode": "agent_scoped"
}
```

### Capability rules

The product shell should stay close to the owner experience, but capability parity is not the same thing as unrestricted machine parity.

Default shared-Agent posture:

- same chat/session shell semantics
- same session lifecycle inside the Agent scope
- no Agent catalog access
- no Agent admin UI
- no unrestricted local-machine discovery surface
- no implicit inheritance of owner-only runtime/admin powers

Some capabilities may later be allowed by Agent policy, but the default should be conservative and server-enforced.

### Surface modes

The frontend should project the UI from `surfaceMode`, not from transport hacks such as `?visitor=1`.

Initial surface modes:

- `owner`
- `agent_scoped`
- `share_snapshot`

---

## Backend Access Model

Interactive Agent share should be implemented as principal-aware access to standard session APIs, not as a separate one-session product lane.

### Entry flow

`GET /agent/:token` should:

- resolve an `AgentAccessGrant`
- mint or resume an Agent-scoped principal
- land in the shared Agent workspace surface

It should not conceptually:

- create the only allowed session up front
- encode UI mode through a query parameter
- rely on a special visitor shell

### Session APIs

`GET /api/sessions`

- owner: returns owner-visible sessions
- Agent-scoped principal: returns only sessions visible within that Agent scope, defaulting to sessions created by that principal

`POST /api/sessions`

- owner: creates a session normally
- Agent-scoped principal: creates a session only inside the scoped `agentId`
- server must ignore or reject attempts to override the scoped Agent boundary

`GET/PATCH/POST /api/sessions/:id/*`

- all session and run access should go through principal-aware helpers
- access should be decided from principal scope plus session metadata

### Access helper direction

Current `owner all / visitor one session` checks should be replaced or wrapped by helpers that reason in these terms:

- owner access
- Agent-scoped non-owner access
- read-only public share access

This helper layer is the backend truth. The model prompt does not define permissions.

---

## Frontend Shell Model

There should be one chat shell, not separate owner and visitor products.

### Same shell

The shared-Agent user should use the same core surfaces as the owner:

- session list
- session detail
- composer
- attachments
- result delivery
- new session
- rename/archive/fork when allowed

### Capability-projected UI

The shell should hide or disable controls from `surfaceMode + capabilities`, for example:

- hide Agent panel / Agent switcher for `agent_scoped`
- hide Agent management surfaces when `manageAgents` is false
- hide or disable local-path browsing when `browseLocalPaths` is false
- hide runtime controls when `changeRuntime` is false

The frontend should not need a separate "visitor bootstrap" path beyond reading normalized auth/capability state.

---

## API And Routing Cleanup Direction

To support the architecture above cleanly:

- keep interactive Agent entry at `/agent/:token`
- remove conceptual dependence on `/app/:shareToken`, `/visitor/...`, and `?visitor=1`
- keep `GET /api/auth/me` as the canonical way to expose principal scope and capabilities
- prefer standard session APIs with principal-aware filtering over parallel non-owner-only APIs

One optional helper endpoint may still be useful:

- `GET /api/agents/current`

That endpoint can provide current scoped-Agent presentation metadata without exposing the global Agent catalog.

---

## Conflict And Precedence With Existing Notes

This design intentionally reopens part of the older app/principal direction.

### This note aligns with

- `notes/current/core-domain-contract.md`
- `notes/directional/app-centric-architecture.md`
- the app-scoped home/list option already listed in `notes/current/core-domain-refactor-todo.md`

### This note conflicts with

- `notes/current/session-first-product-contraction.md`

Specifically, the contraction note says interactive non-owner Agent/App share should be removed from the active product surface. This note reverses that for interactive Agent share and should be treated as the governing decision on that topic.

### What still stays true from the contraction note

- `ShareSnapshot` remains the separate public read-only share surface
- Agent share should not silently reintroduce a broad multi-user SaaS model
- implementation should still converge toward fewer special cases, not more

---

## Phased Implementation Plan

The implementation should be staged so the system converges toward the clean model instead of hard-coding more `visitor` branches.

### Phase 0 — Architecture Freeze

- land this design note
- use `Agent`, `AgentAccessGrant`, and `Principal` terminology consistently in new work
- stop designing new behavior around "pinned visitor session" semantics

### Phase 1 — Principal/Auth Normalization

- normalize auth state in `lib/auth.mjs`
- introduce canonical `principalId`, `principalKind`, `scope`, `capabilities`, `surfaceMode`
- keep current cookies/entry behavior backward compatible where needed
- stop forcing unrelated backend code to reason directly in raw `visitor` terms

### Phase 2 — Session Ownership And Access Helpers

- add canonical session ownership fields such as `agentId` and `createdByPrincipalId`
- centralize access checks around principal scope
- move route authorization away from blanket owner-only assumptions where Agent scope should be allowed

### Phase 3 — Agent Entry Flow Cleanup

- change `/agent/:token` from session-pin bootstrap to Agent-scoped principal bootstrap
- stop relying on `?visitor=1`
- support Agent-scoped session list/create behavior through standard session APIs

### Phase 4 — Frontend Shell Convergence

- collapse separate visitor boot logic into principal-aware shell bootstrap
- project UI from `surfaceMode + capabilities`
- remove visitor-specific shell branches that only exist to work around the old pinned-session model

### Phase 5 — Compatibility Cleanup

- migrate or retire `shareToken` directly on Agent records in favor of `AgentAccessGrant`
- retire raw `visitor` naming where it conflicts with the principal model
- remove dead routes and compatibility shims once the new flow is stable

---

## Guardrails Against Another Hard-Coded Share Path

The following should be treated as architectural smells:

- creating a session solely because a share link was opened
- encoding auth scope in a query parameter
- adding more route checks that special-case only `visitor`
- creating a second frontend shell for shared-Agent users
- using prompt text or UI hiding as the real permission system

If an implementation needs any of those, it is likely working around the old model instead of implementing the new one.

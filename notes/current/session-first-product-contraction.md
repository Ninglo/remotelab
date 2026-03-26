# Session-First Product Contraction

> Status: current product simplification decision as of 2026-03-26.
> Purpose: reduce concept count before deeper refactor so backend and frontend cleanup can converge on a smaller product truth.

---

## Core Decision

For the current product phase, RemoteLab should expose only a very small set of first-class product concepts:

- owner `Session`
- `Run`
- `ShareSnapshot`
- session artifacts such as attachments and result files as subordinate outputs, not top-level product objects

The following should **not** remain first-class product concepts during this contraction phase:

- `App`
- `User`
- `Visitor` as an interactive non-owner chat identity
- `Welcome` as a persisted App object

---

## Why This Direction

- The current codebase already treats `Session` as the primary user-visible truth.
- The parallel architecture reviews all converge on the same problem: `App`, `User`, and `Visitor` add routing, filters, CRUD, bootstrap logic, and frontend branches around the real core object instead of clarifying it.
- Current `App` / `Principal` modeling is still partial or implicit in the implementation mapping, which means the product is already paying complexity cost before receiving the clarity benefit.
- The lowest-risk path is subtraction before structural refactor: remove concepts that are not pulling their weight, then refactor the remaining system around the smaller truth.

---

## Product Rule For This Phase

- RemoteLab remains a single-owner product.
- The only normal interactive actor is the owner.
- Public sharing should be a read-only `ShareSnapshot`.
- If a guided starting point is needed, create a normal session or inject a first assistant message; do not model that as an App.
- If reusable special behavior is needed, prefer internal presets, source-specific routing, or skills, not owner-managed App CRUD.

---

## Keep

- owner session list + session detail as the main UI
- session creation, rename, archive, fork, and result delivery
- run lifecycle and durable recovery
- read-only share snapshots
- source/origin metadata for connector-created sessions

---

## Remove Or Defer

- app CRUD UI and APIs
- app filter in the owner sidebar
- user CRUD UI and APIs
- per-user starter-session seeding logic
- interactive visitor entry flows such as `/app/:shareToken` and `/visitor/:shareToken`
- built-in `Welcome`, `Basic Chat`, and `Create App` as product objects
- session fields whose main job is app/user/visitor surface support (`appId`, `appName`, `visitorId`, `defaultAppId`, `appIds`, `shareVisitorId`)

For those fields, the preferred migration order is:

1. stop creating new product flows that depend on them
2. keep fallback readers for old data temporarily
3. remove them once the simplified surface is stable

---

## What Replaces The Deleted Concepts

### Onboarding

- Replace the `Welcome App` with bootstrap logic that creates or opens a normal starter session.
- If needed, inject a first assistant message or seed a few example sessions.

### Reusable behavior

- Replace owner-visible App packaging with internal presets or skill selection.
- Keep those mechanisms operator-facing until repeated product evidence proves they deserve a user-facing object.

### Sharing

- Keep `ShareSnapshot` as the only public share surface.
- If a conversation needs to continue, do it as a normal owner-side new session or fork, not as a visitor identity model.

### Connector identity

- Connectors should identify sessions through source/origin metadata, not by pretending to be Apps.

---

## First Removal Package

1. Remove app/user filters and settings panels from the owner UI.
2. Remove app/user CRUD routes and interactive visitor entry routes.
3. Keep `ShareSnapshot` routes and read-only frontend bootstrap.
4. Replace Welcome bootstrap with normal-session seeding.
5. Keep old data readable while stopping new writes to app/user/visitor-specific fields.
6. After subtraction, refactor router and session-manager boundaries around the smaller product model.

### Current implementation status

- The owner UI no longer exposes app/user sidebar filters or app/user settings panels.
- `/api/apps*`, `/api/users*`, `/app/:shareToken`, and `/visitor/:shareToken` are explicitly retired.
- Share snapshots remain the only public share surface.
- Owner bootstrap Welcome now lands as a normal starter session with a seeded assistant opening message instead of a product-visible Welcome app flow.

---

## What This Means For Refactor Order

The right sequence is:

1. product-surface subtraction
2. access/share simplification
3. session/run boundary cleanup
4. frontend projection cleanup
5. terminology and storage cleanup

Not:

1. deepen `App` / `Principal` modeling
2. add more compatibility around those concepts
3. only later decide whether the product needed them at all

---

## Relationship To Older Notes

- For near-term product work, this note takes precedence over the more app/principal-heavy direction in `notes/current/core-domain-contract.md` and `notes/current/core-domain-refactor-todo.md`.
- Keep older mapping notes as code-finding references until implementation and terminology catch up.
- If future user evidence clearly demands reusable app packaging or interactive non-owner chat access again, reopen the decision explicitly instead of letting those concepts drift back in piecemeal.

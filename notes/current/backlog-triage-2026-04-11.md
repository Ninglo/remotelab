# RemoteLab Backlog Triage — 2026-04-11

Status: active coordination note

Companions:

- `notes/current/product-mainline.md`
- `notes/current/session-dispatch-and-direct-delivery-followups.md`
- `notes/current/connector-v2-todo.md`
- `notes/current/wechat-connector-followups.md`
- `notes/current/core-domain-refactor-todo.md`
- `notes/current/core-domain-session-prompts.md`

## Why this note exists

- The current backlog is spread across connector work, dispatch/routing follow-ups, WeChat runtime issues, and older structural refactor notes.
- Several of those threads were discussed across different sessions, so priorities are easy to lose.
- This note turns the scattered todo set into one execution board with a recommended session split.

## Current judgment

- Product trust beats architectural elegance right now.
- Anything that breaks discussion continuity or makes a reminder appear in RemoteLab but not reach the source channel is a `P0` product issue.
- Dispatch should stay off until continuity-first behavior is trustworthy enough for live use.
- Connector/direct-delivery work is now more urgent than broad structural cleanup because it directly affects user-visible delivery.
- Core-domain cleanup still matters, but it should run as a separate lane unless it is directly blocking the current product path.
- Content backlog, user-tracking ops, and instance-factory work are real but not part of the current mainline engineering unblock sequence.

## Priority stack

### `P0` — restore trust in the live product path

1. Session continuity before dispatch restoration
   - Anchor: `notes/current/session-dispatch-and-direct-delivery-followups.md`
   - Goal: routing must default to `continue current session` on weak evidence and must not disrupt active design/debug discussion.

2. Direct connector delivery as a first-class control-plane action
   - Anchor: `notes/current/connector-v2-todo.md`
   - Goal: deterministic outbound work must be able to invoke a connector action directly instead of waking AI through `session_message`.

3. WeChat reminder delivery and source-channel send path
   - Anchors: `notes/current/connector-v2-todo.md`, `notes/current/wechat-connector-followups.md`
   - Goal: a fixed-text reminder reaches WeChat directly, with no synthetic AI turn.

4. WeChat owner runtime durability
   - Anchor: `notes/current/wechat-connector-followups.md`
   - Goal: owner poller lifecycle, health, and restart behavior become repo-owned enough that the connector does not silently die in normal use.

### `P1` — stabilize the platform after the `P0` path works

5. Activation-derived capability exposure
   - Anchor: `notes/current/connector-v2-todo.md`
   - Goal: connector actions become visible through one derived catalog instead of prompt surgery or one-off runtime glue.

6. Reply/direct-delivery/docs cleanup
   - Anchors: `notes/current/connector-v2-todo.md`, `notes/current/session-dispatch-and-direct-delivery-followups.md`, `notes/current/wechat-connector-followups.md`
   - Goal: keep reply publication, direct delivery, and runtime liveness as clearly separated subsystems in both code and docs.

7. Regression coverage for dispatch and direct delivery
   - Anchors: `notes/current/wechat-connector-followups.md`, `notes/current/session-main-flow-next-push.md`
   - Goal: add canaries for routing continuity, direct source-channel delivery, and connector runtime recovery.

### `P2` — structural cleanup lane, not the current main blocker

8. Core-domain refactor slices
   - Anchors: `notes/current/core-domain-refactor-todo.md`, `notes/current/core-domain-session-prompts.md`
   - Default order: `R2` -> `R3` -> `R8` -> `R13` -> `R12`
   - Rule: keep this lane separate from connector/dispatch work unless a specific boundary is actively blocking current product fixes.

### Parked / separate tracks

- `notes/current/session-main-flow-next-push.md` is mostly a historical/reference pack, not the current main todo board.
- The private content backlog note stays deferred until product maturity is higher.
- Instance-factory and user-tracking notes remain separate operating lanes.

## Recommended session graph

### Start now

#### `S1` — Dispatch continuity hardening

- Scope:
  - keep runtime dispatch off unless the session explicitly reaches the restore gate
  - make routing continuity-first and transcript-aware
  - unify routing/splitting planning direction enough that the next dispatch pass does not reintroduce the old regression
- Read first:
  - `AGENTS.md`
  - `notes/current/product-mainline.md`
  - `notes/current/session-dispatch-and-direct-delivery-followups.md`
  - `notes/current/user-feedback-log.md`
- Avoid mixing:
  - connector transport changes
  - WeChat delivery work
  - broad frontend redesign

#### `S2` — Trigger `connector_action` shape

- Scope:
  - implement `C1` only
  - add the trigger-side object/storage/API shape for deferred connector actions
- Read first:
  - `AGENTS.md`
  - `docs/connector-v2-architecture.md`
  - `docs/trigger-control-plane-v0.md`
  - `notes/current/connector-v2-todo.md`
- Avoid mixing:
  - WeChat-specific behavior
  - capability exposure cleanup
  - reply-publication refactor

### Queue after `S2`

#### `S3` — Shared connector action dispatch helper

- Scope:
  - implement `C2` only
  - land one canonical dispatch path and one normalized action-result shape
- Depends on:
  - `S2` trigger action shape being clear enough

#### `S4` — WeChat direct reminder path

- Scope:
  - implement `C3` only
  - make WeChat `send_text` the first real end-to-end proof of direct connector delivery
- Depends on:
  - `S3` shared dispatch path

### Parallel but narrow lane

#### `S5` — WeChat runtime durability

- Scope:
  - owner poller startup/restart/health path only
  - move machine-local stopgaps toward repo-owned runtime management
- Read first:
  - `AGENTS.md`
  - `notes/current/wechat-connector-followups.md`
  - any currently relevant install/runtime docs
- Avoid mixing:
  - trigger control-plane refactor
  - direct-send semantics redesign

This can run in parallel with `S2` or `S3` if it stays strictly on runtime durability.

### After `S4`

#### `S6` — Capability exposure cleanup

- Scope:
  - implement `C4`
  - make connector actions discoverable through one derived catalog

#### `S7` — Regression and docs consolidation

- Scope:
  - add tests for routing continuity, direct source-channel delivery, and WeChat runtime recovery
  - update stale notes only after the behavior is real

### Separate structural lane

#### `S8+` — Core-domain slices

- Use `notes/current/core-domain-session-prompts.md`
- Default launch order:
  1. `R2`
  2. `R3`
  3. `R8`
  4. `R13`
  5. `R12`

Do not interleave these with `S2`-`S7` unless a current product fix is actually blocked on one of those boundaries.

## Recommended launch order

If we want the smallest number of active sessions while still making progress cleanly:

1. `S1` — Dispatch continuity hardening
2. `S2` — Trigger `connector_action` shape
3. `S3` — Shared connector action dispatch helper
4. `S4` — WeChat direct reminder path
5. `S5` — WeChat runtime durability
6. `S6` — Capability exposure cleanup
7. `S7` — Regression and docs consolidation
8. `S8+` — Core-domain structural lane

If we want true parallelism immediately:

- Parallel now:
  - `S1`
  - `S2`
  - `S5`
- Then:
  - `S3`
  - `S4`
  - `S6`
  - `S7`

## Copy-paste session starters

### `S1`

```text
Work on dispatch continuity hardening. Read `AGENTS.md`, `notes/current/product-mainline.md`, `notes/current/session-dispatch-and-direct-delivery-followups.md`, and the relevant 2026-04-11 entries in `notes/current/user-feedback-log.md` first. Keep runtime dispatch conservative/off unless restore criteria are truly met. Scope this session to transcript-aware continuity-first routing behavior and planner boundaries only; do not mix in connector or WeChat work.
```

### `S2`

```text
Work on `C1` from `notes/current/connector-v2-todo.md`. Read `AGENTS.md`, `docs/connector-v2-architecture.md`, `docs/trigger-control-plane-v0.md`, and `notes/current/connector-v2-todo.md` first. Implement only the trigger-side `connector_action` shape, storage, API, and normalized delivery result recording. Do not mix in WeChat-specific behavior or capability-exposure cleanup.
```

### `S3`

```text
Work on `C2` from `notes/current/connector-v2-todo.md`. Read `AGENTS.md`, `docs/connector-v2-architecture.md`, `notes/current/connector-v2-todo.md`, and the relevant connector runtime files first. Implement only the shared connector action dispatch helper and normalized action-result path so immediate and deferred invocation share one contract. Do not mix in big connector migrations or UI work.
```

### `S4`

```text
Work on `C3` from `notes/current/connector-v2-todo.md`. Read `AGENTS.md`, `notes/current/connector-v2-todo.md`, and `notes/current/wechat-connector-followups.md` first. Implement only the WeChat direct reminder path using the shared connector action dispatch contract. The goal is that a fixed-text reminder reaches WeChat without waking AI. Do not turn this session into a general connector-runtime cleanup pass.
```

### `S5`

```text
Work on WeChat runtime durability from `notes/current/wechat-connector-followups.md`. Read `AGENTS.md` and that note first. Keep the scope to owner poller lifecycle, health checks, restart behavior, and repo-owned runtime/install management. Do not mix in trigger control-plane or direct-delivery contract redesign unless a tiny compatibility patch is required.
```

### `S6`

```text
Work on `C4` from `notes/current/connector-v2-todo.md`. Read `AGENTS.md`, `docs/connector-v2-architecture.md`, and `notes/current/connector-v2-todo.md` first. Make connector actions visible through one activation-derived capability path, and remove one-off exposure glue where practical. Do not combine this with large connector migrations.
```

### `S7`

```text
Work on regression and docs consolidation for the dispatch/direct-delivery path. Read `AGENTS.md`, `notes/current/session-dispatch-and-direct-delivery-followups.md`, `notes/current/wechat-connector-followups.md`, and `notes/current/connector-v2-todo.md` first. Add focused tests for routing continuity, direct source-channel delivery, and connector runtime recovery, then update stale notes to match the real behavior. Do not reopen architecture debates in this session.
```

## One-line summary

Right now the best split is:

- one continuity/routing session
- one trigger-contract session
- one shared connector-dispatch session
- one WeChat direct-delivery session
- one WeChat runtime-durability session
- then capability exposure, regression, and only after that structural refactor cleanup

# Core Domain Contract

> Status: current baseline for the next RemoteLab refactor cycle.
> Purpose: freeze the product/domain model so route, storage, and UI work stop drifting between overlapping abstractions.
>
> For the current shipped architecture and code map, read `docs/project-architecture.md` first.
> This file is the shorter domain contract that current and future refactors should preserve.

---

## One-Screen Model

RemoteLab should be understood through five durable objects:

```text
Principal -> App -> Session -> many Runs
                      \
                       -> many ShareSnapshots
```

And through one strict rule:

> `Session` is the primary product object. `Run` is the execution object beneath it. `App` is reusable policy. `ShareSnapshot` is separate publication. `Principal` is the access subject.

Everything else is downstream UI or compatibility detail.

---

## What RemoteLab Is Optimizing For

RemoteLab is not primarily:

- a terminal emulator
- a mobile IDE
- a generalized multi-user SaaS
- a share-first publishing product

RemoteLab is primarily:

- a control plane for AI workers running on one machine
- centered around durable conversation threads
- with reusable app-shaped entry points
- with optional read-only publication of conversation history

That framing matters because it keeps the system centered on durable work, not transport tricks or account taxonomy.

---

## Canonical Objects

### 1. Session

`Session` is the core product record.

It owns:

- durable conversation identity
- canonical message/event history association
- archive state
- app association
- user-facing presentation fields such as name/title, group, description
- compatibility execution hints that still exist in the current product, such as `folder`

It does **not** own:

- a specific execution attempt
- a public published artifact
- authorization decisions
- sidebar/progress summaries as domain truth

Minimum mental model:

```text
session = one durable thread of work
```

Practical note:

- current code still carries some execution-adjacent fields on the session record for compatibility and UX convenience
- that does not change the product center: the session is the durable thread, not the runtime attempt

### 2. Run

`Run` is one execution attempt under a session.

It owns:

- tool/provider selection for that attempt
- model/reasoning selection for that attempt
- lifecycle state (`accepted`, `running`, `completed`, `failed`, `cancelled`)
- resume metadata when the underlying tool supports it
- execution result / error / timing metadata
- pointers to normalized event output and spool state

It does **not** own:

- the long-lived identity of the conversation
- session naming/grouping/archive semantics
- public sharing semantics

Minimum mental model:

```text
run = one concrete attempt to advance a session
```

`Run` must remain explicit. Treating it as “just cache” will blur retry, resume, interrupt, and status semantics.

### 3. App

`App` is reusable policy and bootstrap, not a live conversation.

It answers questions like:

- what context should this kind of session start with?
- what identity/presentation should it have?
- what defaults or capability boundaries apply?
- how should a non-owner enter this workflow?

It owns:

- reusable bootstrap/configuration
- welcome/presentation defaults
- shareability policy and app-shaped identity
- future capability/policy expansion

It does **not** own:

- the live state of a specific conversation
- the execution history of a run
- read-only share snapshots

Minimum mental model:

```text
app = reusable policy + bootstrap package for sessions
```

Current stance:

- the shipped system still presents App mostly as a shareable template
- the refactor direction is that every session conceptually belongs to one App, including the owner-default experience

### 4. Principal

`Principal` is the access subject.

It answers one question:

> who is acting through this session right now, and with what server-enforced scope?

Current practical shapes inside one single-user instance:

- owner principal
- app-scoped non-owner principal

A human user's durable isolation boundary is a separate RemoteLab instance with its own config, memory, workspace, auth, Connector bindings, and runtime permissions. `Principal` scopes access to a surface inside that instance; it is not a lightweight replacement for instance isolation or a hidden multi-user account model.

Why `Principal` matters:

- it prevents “visitor” from hardening into the final product abstraction
- it avoids prematurely committing to a full user-account system
- it keeps access control in the domain without turning RemoteLab into multi-tenant SaaS

### 5. ShareSnapshot

`ShareSnapshot` is a separate publication object.

It owns:

- a frozen read-only slice of a session
- publication metadata / token / visibility settings
- any materialized shared rendering state

It does **not** own:

- ongoing session execution
- app policy
- future session updates after the snapshot boundary

Minimum mental model:

```text
share snapshot = published artifact over fixed session history
```

This separation matters because “share” is publication, not execution.

---

## Relationship Rules

The following boundaries should hold across refactors:

1. `Session` is the product center.
2. `Run` is subordinate but real.
3. `App` is reusable policy, not a session alias.
4. `Principal` stays as the access subject even if specific role names evolve.
5. `ShareSnapshot` stays separate from both `Session` and `App`.
6. Sidebar/progress/grouping/filtering remain derived product surfaces, not domain truth.

If a change blurs any of those lines, it should be treated as a domain change, not an implementation detail.

---

## Authorization Rules

Authorization is server-enforced.

That means:

- the model may suggest naming, grouping, status, or presentation metadata
- the model may not define who can read, write, or administer a resource
- app policy can inform the server’s access decision surface
- the server remains the final authority for ownership, session scope, app scope, and share scope

RemoteLab should not evolve toward “permissions are mostly prompt-level conventions.”

---

## Lifecycle Rules

The default lifecycle should be read like this:

1. choose a principal and an app context
2. create or open a session
3. append a user message to the session
4. create a run for that execution attempt
5. normalize events/results back into durable session history
6. finalize the run state
7. optionally publish a share snapshot over some frozen range

This preserves a clean answer to three different questions:

- what conversation is this? → `Session`
- what attempt just ran? → `Run`
- what reusable workflow/policy framed it? → `App`

### Session fork rule

`Session fork` is a **new session creation operation**, not a special mode inside one session.

Current shipped contract:

- fork means **hard clone + hard isolation**
- the child session copies the durable parent state that defines the conversation starting point
- the child does **not** inherit live execution linkage such as `activeRunId`, `activeRun`, provider resume/thread ids, `externalTriggerId`, or `completionTargets`
- future parent/child updates do not sync after creation

Practical consequence:

- same-session continuation may reuse provider-native resume state
- true branching may not reuse that state, because sharing a provider-native thread would break branch isolation

Current exactness boundary:

- the shipped v1 cut is **head fork**: clone the current durable session state as it exists now
- historical fork points that would require reconstructing an earlier pre-compaction live prompt state should be rejected rather than silently approximated

So the mental model is:

```text
fork = create a fresh session from copied durable state, then continue independently
```

---

## Derived Surfaces

The following are important product surfaces, but they are not the core domain:

- sidebar grouping
- workflow lanes
- workflow attention priority
- progress summaries
- task-like labels that do not have an independent lifecycle
- “needs your decision” indicators
- list filters
- archive tabs
- folder/cwd display labels

They should be derived from canonical objects, not treated as new objects with independent authority.

For the current workflow-organization baseline, also read `session-first-workflow-surfaces.md`.
The short version is:

- `Session` is the only durable work object today
- `group`, `workflowState`, and `workflowPriority` are session metadata
- list/progress-style organization is a projection over sessions, not a parallel task system

Two practical consequences:

- session presentation metadata can be real and durable without becoming the deepest model
- the current `folder` field can remain as runtime/cwd compatibility without reclaiming the product center

---

## Current Compatibility Notes

These are pragmatic allowances in the shipped system, not long-term centers of gravity:

- `folder` / cwd is still a practical runtime field
- owner vs visitor still exists as a concrete compatibility split in routes/auth/session scope
- app records are still lighter than the eventual policy model
- some run/tool fields may still appear on session records for convenience

Keep them where useful, but do not let them redefine the domain.

---

## Explicit Non-Goals

This contract does **not** attempt to solve:

- full multi-user account infrastructure
- organization/team/workspace SaaS abstractions
- background autonomy as a shipped baseline
- provider registry implementation details
- exact frontend component boundaries
- every migration step from the current code

Those belong to architecture, provider, or directional notes.

---

## Refactor Test

A proposed refactor is likely aligned if it makes the following clearer rather than blurrier:

- session identity vs run identity
- policy/app vs live execution
- publication vs live work
- server authority vs model suggestion
- derived UI vs canonical state

If a change makes those distinctions harder to explain, it is probably moving the repo backward.

---

## Related Docs

- `docs/project-architecture.md` — current shipped implementation map
- `notes/current/memory-activation-architecture.md` — current memory-loading model
- `notes/directional/app-centric-architecture.md` — longer-term App direction
- `notes/directional/provider-architecture.md` — provider/model direction
- `notes/directional/ai-driven-interaction.md` — deferred triggers and AI-initiated work

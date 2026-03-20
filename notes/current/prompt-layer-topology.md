# Prompt Layer Topology

## Why this exists

RemoteLab's prompt stack had started to mix policy, routing, memory activation, continuity, and turn-level execution nudges into one increasingly prescriptive bundle.

That shape is fragile. It makes the system read like a hidden SOP instead of a reusable cognitive scaffold, and it blurs several different questions:

- what principles should always stay true
- what context should load at startup
- what belongs to the current workstream only
- what should stay as a side resource or cold archive

This note records the cleaner principle-first topology.

## Core stance

RemoteLab should behave like an agent-native system.

- Code owns capability primitives, state persistence, permissions, and hard invariants.
- Prompts own principles, assembly rules, and default preferences.
- The user may keep, edit, replace, or delete the initial scaffold as their own workflow matures.

The startup prompt is therefore a seed layer, not a permanent law.

## Recommended topology

### 1. Seed / Constitution

This is the editable startup scaffold.

It carries:

- core collaboration stance
- manager/runtime boundary
- reply-style defaults
- memory activation defaults
- capability hints and tool posture

It should stay small and principle-first.

### 2. Runtime Assembler / Router

This layer decides what to activate for the current turn.

Its job is not to preload everything. Its job is to keep the live context small and correctly assembled.

Typical responsibilities:

- start from pointer-sized startup context
- infer scope when obvious
- ask only when ambiguity is real
- load matching scope/task context on demand
- decide whether template reuse or session fan-out is the better path

### 3. Continuity / Handoff

This is distinct from both scope and task notes.

Continuity records where the current workstream stands right now:

- accepted decisions
- current execution state
- tool / branch / runtime status
- blockers and open loops
- the next good entry point for the next worker turn

Without this layer, task notes tend to become a dumping ground for session residue.

### 4. Scope

Scope is the relatively stable background for a project, repo, or recurring domain.

It should answer questions like:

- what system is this
- what constraints matter here
- what architecture or vocabulary is stable
- what template/base session or deep docs should be checked next

Scope should provide enough background for correct action, not grow into a full wiki by default.

### 5. Task

Task is the current delta inside a scope.

It should capture:

- what this session/branch is trying to do now
- decisions specific to this round of work
- current blockers
- immediate next actions

Task should stay narrower than scope.

### 6. Side Resources

Two important resources are side resources, not default live layers:

- skills
- shared learnings / system memory

They are powerful, but they should load on demand instead of inflating every startup prompt.

### 7. Archive

Archive is cold storage.

It should remain available for recovery, audit, and historical lookup, but it is not the normal source of live working context.

## Routing principle

Bounded work should prefer bounded context.

A session is not only a chat transcript. It is a workstream container. When one user turn contains multiple independently completable goals, the system should seriously consider splitting them into separate sessions or child sessions.

That keeps each context tighter and makes continuity cleaner.

## Prompt-writing rule

Prompt layers should synchronize principles and invariants, not narrate every action as a hidden checklist.

Turn-level reminders still matter, but they should stay light. They should reinforce judgment priorities rather than replace judgment with a script.

## Current implementation implications

- `chat/runtime-policy.mjs` should express boundary, ownership, and principle-first defaults.
- `chat/system-prompt.mjs` should describe the seed layer, context topology, routing posture, and selective memory activation.
- `chat/session-continuation.mjs` should frame handoff as continuity for the active workstream.
- `chat/session-manager.mjs` should keep turn activation compact and principle-first.
- `chat/session-routing.mjs` should reinforce bounded-work / bounded-context routing.

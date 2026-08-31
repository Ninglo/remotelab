# Thin Control Plane Architecture

Status: current baseline after the Harness-boundary contraction

## Core boundary

RemoteLab is not a semantic Harness above Codex, Claude, Pi, or future provider agents.

RemoteLab owns the durable cross-surface substrate:

- identity, authorization, and instance boundaries
- Session / Run lifecycle, idempotency, queueing, cancellation, and restart recovery
- provider/runtime selection and native resume identifiers
- normalized append-only history
- attachments, artifacts, connectors, triggers, and user-visible delivery
- provider-neutral memory activation, current work state, and cross-Harness continuation

The selected Harness owns:

- task interpretation
- planning and decomposition
- tool use
- temporary/native subagents
- execution strategy
- self-review and task-specific validation
- the user-facing answer

RemoteLab must not wrap ordinary turns in a second hidden semantic gate, planner, or reply reviewer.

## Current message path

1. Resolve or create a Session.
2. Accept the message with structural validation and request-id idempotency.
3. Queue it only when the Session is already busy.
4. Project provider-neutral startup, memory, work-summary, source, and delivery context into the selected Harness.
5. Create a durable Run and launch the Harness directly.
6. Normalize output and finalize the Run.
7. Mark reply publication ready from the Harness terminal result.
8. Run one non-blocking post-turn Session-state classifier.
9. Run durable memory writeback independently when the turn contains reusable cross-session knowledge.
10. Deliver the reply and artifacts through the originating surface.

## One retained semantic projection

Sessions can drift as conversation continues, so RemoteLab retains one asynchronous post-turn classifier.

One model call updates together:

- title
- Space
- Project group
- description
- workflow state and priority
- provider-neutral current work summary

This replaces separate title/group, workstream-assessment, workflow-state, task-card, and global Project-organizer calls. It does not critique or continue the answer and does not block reply publication.

The persisted `workSummary` is projected as `workState.summary` and injected on later turns regardless of Harness. Legacy `taskCard` data is migrated into this field on load.

## Shared cross-Harness memory

Provider-native threads remain useful runtime caches, but they are not the source of truth for user memory.

Cross-Harness continuity comes from RemoteLab-owned state:

- normalized Session history
- `context.json` continuation head and compaction summary
- `workState.summary`
- active agreements
- pointer-first user/project/task memory
- selective durable memory writeback

Every Harness receives the same logical memory and work-state layers, rendered through the current prompt projection. Switching Harnesses may lose provider-native hidden context, but it must not lose RemoteLab-owned decisions, materials, blockers, or durable memory.

## Persistent Session spawn boundary

`session-spawn` remains available when a separate persistent RemoteLab Session has concrete value: independent history, long-running work, separate delivery, or user-visible navigation.

Temporary decomposition should normally use the Harness's native control loop or native subagents. RemoteLab no longer performs pre-turn semantic dispatch and no longer guesses that a new delegation should reuse a previous child by text overlap.

## Removed control loops

The active architecture removes:

- pre-turn session dispatch gate/planner
- pending continuation/checking queue
- hidden reply self-check and automatic repair run
- separate per-turn workflow classifier
- separate per-turn task-card generator
- separate workstream assessment before relabeling
- automatic global Project-list organizer
- semantic delegated-child reuse heuristics

Historical usage-ledger operation labels may remain readable for old records, but no active path emits those operations.

## Benchmark gate for future upper-Harness work

Any future attempt to add a semantic layer above provider Harnesses must begin as a benchmark project, not as production-path prompt logic.

It must show a measurable gain over the selected Harness alone on:

- task success and correction rate
- latency
- token/cost overhead
- false routing or unnecessary decomposition
- recovery quality
- user-visible delivery correctness

Without that evidence, the default remains direct Harness execution plus the thin RemoteLab substrate.

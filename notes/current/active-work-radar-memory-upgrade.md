# Active Work Radar / Memory Upgrade

Status: product/architecture proposal
Date: 2026-07-02

## Why This Note Exists

Early proactive-workflow experiments exposed a broader RemoteLab memory problem.

The issue is not just that one project needs a status ledger. A useful AI employee should enter any session with a lightweight sense of what the owner is actively pushing across related workstreams. It does not need every detail from every session, but it should know the current active lanes well enough to notice when a side discussion creates reusable signal for another lane.

This should become an upgrade to RemoteLab's existing memory/control-state model, not a feature tied to one prototype.

## Existing RemoteLab Concepts To Reuse

RemoteLab already has most of the right substrate:

- `prompt-layer-topology.md` defines seed, runtime assembler, continuity, scope, task, side resources, and archive.
- `memory-activation-architecture.md` separates storage from activation through `bootstrap.md`, `projects.md`, task memory, and selective writeback.
- `model-sovereign-control-architecture.md` says prompt should be a projection of state and available context, not the primary place where state lives.
- `session-control-state-phase1.md` introduced `managerState` and `workState` as backend projections over existing carriers.
- `session-work-summary.mjs` already gives each session a compact work-summary carrier.
- `session-memory-writeback.mjs` already performs selective durable learning promotion after a turn.
- `group-goal-summary-surface.md` already explores derived group/work-item projections over existing sessions.

The new concept should fit into this object model.

## Core Concept

Add an **Active Work Radar** layer.

It is not cold memory, and it is not the same as a work summary.

It is a small manager-owned projection of the owner's currently active work lanes:

```text
lane id / title
one-line goal
current hypothesis or latest accepted judgment
trigger terms
what kind of side signal should be captured
source pointers
freshness / confidence
```

The radar gives every session a little "organizational awareness" without loading every project.

## Placement In Existing Architecture

### Not Seed

The radar should not live in the permanent startup projection. It changes too often and is user/project specific.

### Not Cold Memory

The radar should not be buried as ordinary task memory. It must be cheap to activate before the current user message is fully classified.

### Not Session Task Card

A work summary describes this session's current work. The radar describes nearby active work that this session may incidentally touch.

### Best Fit

The best near-term fit is:

```text
managerState.memoryActivation.activeWorkRadar
```

or, if the object model wants a clearer name:

```text
managerState.workAwareness.activeWorkRadar
```

It should be projected into the turn prompt by `turn-context-hook.mjs`, next to active agreements and the carried work summary, with tight length limits.

## Relationship To Existing Layers

| Layer | Current role | Radar relationship |
|---|---|---|
| `bootstrap.md` | tiny startup index | points to the radar capability, does not contain radar content |
| `projects.md` | scope router catalog | supplies possible lanes and trigger terms |
| session `workSummary` | current session state | may feed radar source evidence |
| `activeAgreements` | session-specific persistent agreements | separate; not for cross-work awareness |
| `memoryActivation.scopeRouter` | likely matching scopes for current turn | radar is broader and more ambient |
| `memoryActivation.relatedSessions` | specific related session imports | radar may decide which related sessions are worth importing |
| memory writeback | durable fact promotion | radar/inbox should be reviewed before durable promotion |
| group summary | user-facing projection | can consume radar + work summaries to summarize a project/work item |

## Proposed Data Shape

In a file-backed prototype, the shape can be markdown.

In a backend-native version, use JSON:

```json
{
  "updatedAt": "2026-07-02T00:00:00.000Z",
  "lanes": [
    {
      "id": "support-automation",
      "title": "Support workflow automation",
      "goal": "Turn operator feedback into reusable workflow improvements.",
      "currentHypothesis": "Reviewing real cases is a better first learning loop than abstract scoring.",
      "recentJudgment": "Engineering progress exists, but the real-case feedback loop is still missing.",
      "triggerTerms": ["support", "case review", "operator feedback", "automation", "skill", "rubric"],
      "captureSignals": ["new real cases", "human overrides", "AI-vs-human deltas", "skill update candidates"],
      "sourcePointers": [
        { "type": "projectMemory", "path": "~/.remotelab/memory/tasks/support-automation.md" },
        { "type": "workspace", "path": "~/workspace/support-automation" }
      ],
      "freshness": "active",
      "confidence": "medium"
    }
  ]
}
```

Prompt projection should compress this to 3-7 lanes and roughly 800-1500 characters.

## Context Inbox

The radar needs a companion inbox.

When a session produces side signal for another lane, the system should not immediately write it into durable memory. It should create a lightweight candidate:

```json
{
  "id": "...",
  "createdAt": "...",
  "sourceSessionId": "...",
  "relatedLaneId": "kol-agent",
  "type": "fact|judgment|gap|next_step|evidence",
  "content": "The user again emphasized real operator feedback over abstract rating rules.",
  "evidence": [{ "type": "session", "id": "..." }],
  "confidence": "medium",
  "status": "pending"
}
```

This inbox belongs to work awareness / current project state, not durable memory.

Daily or periodic project maintenance can then decide:

- merge into a lane's radar summary
- update the relevant session work summary or group projection
- promote to project/task memory
- discard as noise

## Turn Lifecycle

### Before Prompt Projection

1. Start with current `managerState` and `workState`.
2. Use current message + session group + work summary + scope router to select the relevant radar lanes.
3. Project only a tiny radar block into the turn context hook.
4. Avoid importing deep related sessions unless the turn actually needs details.

### During The Turn

The model can use radar for three lightweight behaviors:

- recognize that a side topic maps to an active lane
- mention the linkage when useful
- capture a side note for inbox if the turn produces reusable signal

### After Turn Completion

Existing `maybeRunMemoryWriteback` should stay selective and durable.

A separate work-awareness review should run before durable memory promotion:

1. inspect user message + assistant final answer + work summary changes
2. identify cross-lane side signals
3. write pending items to the context inbox
4. only promote durable, stable conclusions through the existing memory writeback path

This keeps transient work awareness from polluting long-lived memory.

## Why This Is Better Than Status Cards Alone

Status cards are useful, but they assume each child workstream explicitly reports back.

The user is asking for something more ambient:

- while discussing one task, the AI should notice implications for another task
- it should not need the other task's full context
- it should have enough prior knowledge to say "this is relevant to operations / support / research"

That is exactly what a radar layer provides.

## Minimal Implementation Plan

### P0 — File-Backed Prototype

No schema changes.

- Store radar at `~/.remotelab/memory/model-context/active-work-radar.md`.
- Store inbox at `~/.remotelab/memory/model-context/context-inbox.md`.
- Add a small renderer in `turn-context-hook.mjs` that includes a clipped radar block.
- Keep project-specific prototype files as content experiments, not platform architecture.

This validates whether the prompt projection improves cross-session awareness.

### P1 — ManagerState Projection

Add a backend projection:

```text
managerState.workAwareness.activeWorkRadar
managerState.workAwareness.contextInboxDigest
```

Source it from file-backed radar, selected session work summaries, projects.md triggers, and group metadata.

Keep persistence separate from prompt text.

### P2 — Post-Turn Side-Signal Extraction

Add a small async turn-completion effect, separate from durable memory writeback:

- candidate side notes go to work-awareness inbox
- durable learnings still route through `session-memory-writeback.mjs`

This can reuse the detached assistant infrastructure but must have a different prompt and target.

### P3 — Group / Project Summary Integration

Use radar + work summaries + inbox status as inputs to the group-goal summary surface.

The group page can show:

- active lanes
- latest accepted judgments
- pending cross-session inbox items
- missing evidence
- best next action

This makes the radar visible when helpful, without forcing it into every chat UI.

## Guardrails

- Radar must stay small. 3-7 active lanes by default.
- Radar stores pointers and compact judgments, not raw secrets, auth data, or long transcripts.
- Radar items need freshness/expiry. Stale lanes should drop out or move back to cold memory.
- Inbox is not durable memory. It must be reviewed, merged, or discarded.
- Prompt projection should be a view over state, not the authoritative storage.
- The user should be able to understand and eventually edit the active lanes.

## Product Framing

This is not a feature for one named prototype.

It is the memory/control substrate for AI employees in RemoteLab:

- work summary = what this session is doing
- active agreement = what this session agreed to keep doing
- active work radar = what the broader owner/team is currently pushing
- context inbox = provisional cross-session signal awaiting periodic automated curation; promotion, merge, or deletion must not depend on an invisible human queue
- project/group summary = user-facing recovery view
- durable memory = stable facts and reusable decisions after promotion

The radar is the missing middle layer between pointer-first memory and full project dashboards.

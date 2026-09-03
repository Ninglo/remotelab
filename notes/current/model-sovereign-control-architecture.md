# Model-Sovereign Control Architecture

## Why this note exists

`docs/project-architecture.md` describes the shipped topology of RemoteLab.

`prompt-layer-topology.md`, `memory-activation-architecture.md`, and `manager-policy-persistence.md` each explain one important slice of the control layer.

This note ties those slices together under one stronger premise:

- RemoteLab should provide a **minimal operating environment for the model**
- the system should not try to over-script the model's reasoning as a hidden workflow engine
- the control layer should become clearer by turning long-lived semantics into explicit state objects instead of letting them drift across prompt text, memory text, and ad hoc continuity fragments

The design goal is not “stronger control over the model.”

The design goal is **better model sovereignty on top of a stable substrate**. The selected Harness owns task interpretation, planning, tool use, decomposition, and self-review; RemoteLab owns durable cross-Harness state, boundaries, recovery, and delivery.

---

## Core thesis

RemoteLab should behave like a model-facing operating layer.

The system provides:

- a stable execution environment
- durable state and recovery
- memory access paths
- capability interfaces
- user-visible delivery boundaries

The model provides:

- task interpretation
- planning and decomposition
- judgment about when to continue, clarify, split, or converge
- selective use of memory and tools
- synthesis and response strategy

The key architectural move is:

- **prompt becomes a projection of state and available context, not the primary place where state lives**

---

## Ownership model

### 1. Hard-held by the system

These must not depend on prompt compliance alone:

- permissions and user-visible access boundaries
- durable session/run truth
- recovery and resume behavior
- tool/capability exposure
- delivery state and artifact reachability
- storage, validation, and lifecycle rules

### 2. Hybrid containers

These are stateful containers owned by the system, but their content should be mostly model-shaped:

- current work state
- active agreements
- activation decisions for memory/context
- compact continuity summaries
- structured writeback candidates

The system owns the schema, limits, persistence, and lifecycle.

The model owns the content quality, updates, and usage inside those containers.

### 3. Model-led space

These should stay flexible and mostly model-directed:

- reasoning strategy
- response structure unless the user asks otherwise
- task decomposition
- tool selection within available capability boundaries
- whether deeper memory retrieval is actually necessary

---

## Canonical objects

| Object | What it is for | Primary owner | Typical lifetime |
|---|---|---|---|
| Seed identity | startup stance, core boundary, basic working posture | hybrid | long-lived |
| Current work state | objective, accepted decisions, completed work, blockers, next step | hybrid | session/workstream |
| Active agreements | short persistent agreements that should survive across turns | hybrid | session until changed |
| Routing index | scope clues and pointers to deeper context | model-led via manager activation | cross-session |
| Cold memory | deeper project/task facts, history, and background | model-led | long-lived |
| Run state | live execution progress, tool status, transient runtime facts | system | per run |
| Delivery state | whether the user can actually access the result | system | until superseded |

Two extra surfaces matter even though they are not purely “state objects”:

- **capability surface** — tools, skills, apps, and integration actions that the model may invoke
- **prompt projection** — the rendered view shown to the model for the current turn

The capability surface should be system-owned and model-invoked.

The prompt projection should be derived from the other objects, not treated as an independent warehouse of truth.

---

## Lifecycle model

### Startup

At startup, the model should receive only enough to become oriented:

- seed identity
- current work state
- relevant capability surface
- minimal routing clues

Startup should be able to point to memory without eagerly loading all of it.

### Active turn

During a turn, the model should:

- start from current work state
- inspect only the relevant routing/memory pointers
- pull deeper context only when it changes the outcome
- update hybrid containers when durable progress or agreements emerge

### Recovery

Recovery should depend primarily on durable state, not on replaying a huge transcript.

The recovery priority is:

1. current work state
2. active agreements
3. delivery state
4. run state when a run is still live or recently interrupted
5. only the necessary continuation context beyond that

### Writeback

Writeback should stay selective.

- durable project/user facts may enter memory
- session-local decisions should remain in work state or agreements
- ephemeral exploration should usually die with the turn

The system should prefer explicit promotion over blind transcript mining.

---

## What belongs where

When a new feature or behavior appears, classify it in this order:

1. If losing it would break recovery, delivery, permission boundaries, or state truth, it belongs in system-held state.
2. If it is stable background fact, history, or preference, it belongs in memory.
3. If it matters across turns for this workstream but should not become long-lived memory, it belongs in current work state or active agreements.
4. If it is a user preference or collaboration agreement, it belongs in user memory, an Agent template, or explicit session agreements rather than an always-on RemoteLab policy.
5. If it is an available action, it belongs in the capability surface.
6. If it is only the rendered presentation of one of the above, it belongs in prompt projection and should not become an extra state source.

This rule is the main defense against “one more prompt block” turning into architecture decay.

---

## Current structural problems

The current direction is broadly correct, but the ownership model is still partially mixed.

### 1. Seed context is conceptually small but operationally heavy

The system already talks about a pointer-sized startup layer, but the startup prompt still carries a large amount of behavior-shaping material.

That makes the seed layer act partly like a constitution and partly like an operating manual.

### 2. Manager state exists, but not yet as one clear object model

RemoteLab already has real manager semantics, including policy, continuity, agreements, routing hints, and activation posture.

But these semantics are still split across several text and metadata carriers.

The result is that “manager” is real in behavior, but not yet fully explicit in structure.

### 3. Current work truth is fragmented

The live state of a workstream is currently represented through several overlapping shapes:

- agreement-like reminders
- task/work-summary structures
- continuation heads and handoff summaries
- routing-related context hints

Each piece is useful, but together they still do not read like one canonical “current work state.”

### 4. Prompt projection is distributed

The final context shown to the model is assembled from multiple layers that are individually reasonable but collectively hard to reason about.

This makes it easy for the same semantic idea to exist both as state and as repeated text.

### 5. Memory activation is clear as a principle, but weak as an explicit activation record

RemoteLab already has the right theory: memory should be large on disk and small in active context.

What is still weak is a first-class description of what was activated for this turn, why it was activated, and whether it changed current work state.

### 6. Feature delivery still tends to land as textual control

When a new capability is needed, the cheapest short-term move is often to add another reminder, prompt block, or memory hint.

That is how practical delivery pressure turns into structural corruption: the local solution works, but object ownership gets blurrier over time.

---

## Refactor strategy

The next refactor should strengthen the control layer without turning RemoteLab into a rigid workflow engine.

### Phase 1 — Freeze vocabulary and ownership

Goal:

- make the canonical objects explicit and stable

Deliverables:

- one shared vocabulary for seed identity, work state, agreements, routing index, cold memory, run state, delivery state, and prompt projection
- one mapping from current carriers to those objects
- one decision rule for future feature placement

Guardrail:

- do not redesign user-facing behavior yet

Current status:

- the first code landing for this phase now exists in `chat/session-control-state.mjs`
- the concrete carrier-to-object mapping is tracked in `notes/current/session-control-state-phase1.md`

### Phase 2 — Centralize prompt projection

Goal:

- make prompt assembly an explicit projection step instead of a distributed pile of text composition

Deliverables:

- one manager-owned projection entrypoint
- named projection inputs instead of implicit string stacking
- a clearer distinction between authoritative state and rendered prompt text

Guardrail:

- keep external behavior backward compatible during the migration

### Phase 3 — Unify current work state

Goal:

- converge the overlapping “what is going on right now” carriers into one clearer work-state contract

Deliverables:

- a canonical session/workstream object for objective, accepted decisions, completed work, blockers, and next step
- active agreements treated as a scoped adjunct to work state rather than a parallel substitute for it
- continuation and compaction outputs that flow back into the same contract

Guardrail:

- avoid heavy auto-promotion from transcript history until the state model is stable

### Phase 4 — Make activation first-class

Goal:

- make context and memory activation a visible manager concern rather than only a prompt principle

Deliverables:

- a clearer activation plan for the current turn
- separation between routing signals, activated memory, and persistent work-state updates
- better reasoning about why certain context was loaded

Guardrail:

- preserve the “load minimally first” posture

### Phase 5 — Add model-led promotion carefully

Goal:

- let the model propose stronger self-management without turning transcript accidents into truth

Deliverables:

- suggestion paths for agreement promotion, work-state refresh, and memory writeback
- system-owned validation, limits, and lifecycle rules around those suggestions

Guardrail:

- prefer strong-signal promotion only; do not blindly summarize everything the model ever said

---

## Recommended immediate cut

The best first implementation slice is **not** smarter retrieval and **not** a larger prompt.

The best first slice is:

1. define the canonical manager/work-state objects
2. audit the current prompt and continuity carriers against those objects
3. introduce one projection chokepoint
4. only then start collapsing redundant carriers

This is the highest-leverage cut because it reduces future corruption pressure instead of only patching one current symptom.

The current codebase has now completed this contraction:

- canonical projection names now exist as `managerState` and `workState`
- prompt assembly has started reading through that projection layer
- startup and per-turn prompts now carry RemoteLab facts, capabilities, pointers, and explicit state instead of a global behavior constitution
- Codex receives no RemoteLab-owned developer instructions by default
- durable storage is still flat and should be collapsed only in later phases once the object contract stays stable

---

## Non-goals

This refactor should not:

- turn RemoteLab into a code-dominant workflow engine
- replace model judgment with rigid hidden SOPs
- treat memory as a bag of covert policy
- auto-promote every repeated idea into persistent state
- optimize retrieval sophistication before the ownership model is clear

---

## Implementation surfaces to keep in mind

The current implementation surface for this control architecture is mainly:

- `chat/runtime-policy.mjs` — provider runtime environment projection only
- `chat/system-prompt.mjs` — startup capability and memory-pointer projection
- `chat/session-manager.mjs` — current prompt assembly chokepoint and session-side prompt injection
- `chat/session-continuation.mjs` — active workstream continuity/handoff context
- `chat/session-work-summary.mjs` and related session metadata helpers — provider-neutral current work-state carrier shared across Harnesses

Companion notes:

- `model-autonomy-control-loop.md`
- `prompt-layer-topology.md`
- `memory-activation-architecture.md`
- `manager-policy-persistence.md`

Read this note when the question is not “how does the current code work,” but “what should own this behavior if RemoteLab is designed for maximum model sovereignty on top of a stable substrate.”

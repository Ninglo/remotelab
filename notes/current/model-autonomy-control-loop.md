# Model Autonomy Control Loop

## Why this note exists

`notes/current/model-sovereign-control-architecture.md` defines the ownership model.

`notes/current/memory-activation-architecture.md`, `notes/current/prompt-layer-topology.md`, and `notes/current/session-main-flow-next-push.md` explain important slices of context activation, continuity, and delegation.

What is still missing is one explicit runtime contract for the thing the user is now asking for:

- keep the main interaction as a normal conversational turn
- give the model more authority over what to do next
- reduce hard-coded workflow rules over time
- keep context-changing behavior inspectable instead of hidden inside prompt accidents

This note defines that contract.

---

## Core thesis

RemoteLab should not hard-code more and more workflow branches every time autonomy grows.

Instead, it should expose a **bounded model autonomy loop**:

- the system owns the substrate, limits, and visibility contract
- the model owns the decision about whether to stop, continue, compact, delegate, or ask for input
- every context-changing action is represented as an explicit operation rather than an invisible prompt side effect

The important shift is:

- **self-check, compaction, delegation, and continuation should be framed as operations inside one post-turn control loop, not as unrelated special cases**

---

## Product posture

The baseline interaction should still feel like one normal chat turn.

The extra autonomy should not force the user to think in terms of hidden control flows.

The operating model is:

1. the user says what they want
2. the model responds normally
3. the model gets one bounded chance to decide whether further internal action is needed
4. any such action is visible as a context operation, not hidden as silent drift

So the abstraction is not “replace conversation with a workflow engine.”

The abstraction is “conversation remains primary, but turn closure becomes model-directed.”

---

## Turn-close autonomy window

After each meaningful turn, the model should get a **turn-close autonomy window**.

This window is where the model performs a lightweight review of the just-finished turn and decides whether to:

- end the turn and wait
- send a short follow-up
- compact current context
- refresh work state
- spawn a worker session
- merge a worker result
- ask the user for blocking input

This review is the right place to unify what are currently treated as separate mechanisms.

### Why this is better than separate features

If compaction, self-check, continuation, and branching each become their own hard-coded subsystem, autonomy grows by accumulating rules.

If they are all outcomes of one turn-close review, the system stays smaller:

- the code exposes operations and budgets
- the model chooses which operation fits the current state
- the user can inspect what happened

That is the desired long-term direction: **less rigid code choreography, more model-directed control on top of explicit state**.

---

## Canonical objects

This loop needs a few first-class objects.

| Object | Purpose | Owner | Persistence |
|---|---|---|---|
| `workState` | objective, accepted decisions, completed work, blockers, next step, continuation head | hybrid | session/workstream |
| `activeAgreements` | short persistent collaboration rules for this session | hybrid | session |
| `activationRecord` | what context was activated for this turn, from where, and why | hybrid | per turn, optionally summarized durably |
| `turnReview` | end-of-turn self-check: solved?, blocked?, context pressure?, better delegated? | model-shaped, system-bounded | per turn |
| `contextOp` | one explicit context-changing operation with reason, inputs, outputs, and effects | hybrid | durable event/log |
| `delegationPacket` | bounded task packet sent from parent session to worker | hybrid | per spawn |
| `resultPacket` | bounded result returned from worker to parent | hybrid | per worker completion |
| `deliveryState` | whether the user can actually access the result now | system | until superseded |

Two rules matter here:

- `workState` is the canonical “what is going on now” object
- `contextOp` is the canonical “what changed in the context model” object

This avoids the current failure mode where important state is partly in prompt text, partly in transcript summaries, and partly in invisible assembly decisions.

---

## The control loop

The control loop should look like this.

### 1. Run the main turn

The session processes the user message normally.

The model may answer directly, use tools, or perform task work exactly as it does now.

### 2. Produce or update durable state

Before the turn fully closes, the model should refresh the durable state it just clarified:

- `workState`
- `activeAgreements` when needed
- `deliveryState` when output reachability changed

This is not a separate “memory writeback” feature. It is part of finishing the turn cleanly.

### 3. Run a turn review

The model then performs a bounded self-check.

The questions are simple:

- Is the user request satisfied for now?
- Is there unresolved risk or ambiguity that matters?
- Is current context becoming unhealthy?
- Is the next step mostly noisy execution rather than core reasoning?
- Is user input actually required, or can the system continue autonomously?

The output is a small `turnReview`, not a free-form transcript dump.

### 4. Choose zero or more bounded operations

Based on that review, the model may choose explicit operations.

Typical operations are:

- `compact_context`
- `refresh_work_state`
- `spawn_worker`
- `merge_worker_result`
- `drop_tool_noise`
- `ask_user`
- `continue_same_session`
- `idle`

Each chosen operation becomes a `contextOp` record.

### 5. Stop at the first real boundary

The loop should stop when one of these is true:

- the user is waiting and no more internal work is needed
- a real blocker requires user input
- the autonomy budget for this turn is exhausted
- further progress would become repetitive or unbounded

The goal is not an infinite agent loop.

The goal is one extra model-controlled closure phase that improves continuity and execution quality.

---

## Self-check and compaction belong together

Self-check should not be a separate product feature hanging next to compaction.

It should be the decision gate that decides whether compaction is needed at all.

That means:

- compaction is one possible outcome of turn review
- compaction should happen because the model judged it useful, not only because a hard threshold fired
- automatic thresholds can still exist as safety rails, but should not be the whole design

This reframes compaction away from “summarize old transcript text” and toward “refresh the session’s active operating state.”

The authoritative compaction output should therefore be:

- an updated `workState.continuation`
- a `contextOp` saying what moved out of current context
- retrieval handles for anything left in history

The user-visible handoff text can still exist, but it should be a projection of those objects, not the primary truth.

---

## Manager / worker split

The main session and worker sessions should have different jobs by default.

### Main session

The main session should stay responsible for:

- understanding the user request
- converging on decisions and answers
- holding the canonical `workState`
- deciding whether delegation is useful
- returning user-facing conclusions

### Worker session

Worker sessions should be preferred for high-entropy execution such as:

- filling web forms
- scraping or navigation-heavy work
- long repo-wide search
- repetitive file operations
- noisy debugging or experimentation
- any task where logs and click-by-click details would pollute the main discussion

This is not meant to become a giant hard-coded router.

It should be a default policy bias expressed in state and prompt posture:

- keep core reasoning and decisions in the main session
- move noisy execution into bounded worker sessions when useful

So delegation remains model-led, while the product strongly supports it.

---

## Packets, not transcript replay

Delegation should move through bounded packets instead of replaying whole transcripts.

### `delegationPacket`

The parent should send a worker:

- the objective
- the exact subtask
- required constraints
- relevant accepted decisions from `workState`
- allowed tools/capabilities
- completion contract
- references back to the parent session when needed

### `resultPacket`

The worker should return:

- what was completed
- what changed
- any unresolved blockers
- structured outputs or field values when relevant
- evidence references or artifact handles
- recommended updates to parent `workState`

The parent then imports that result through an explicit `merge_worker_result` or `import_context` operation.

That keeps the main session concentrated on the answer and the state, not the worker’s raw execution noise.

---

## Visibility contract

The user does not need every hidden prompt block.

But the user should be able to inspect every significant context change.

So the visibility contract should be:

- prompts may remain mostly hidden
- context operations must be inspectable
- current in-flight activity must be surfaced
- what was kept, dropped, imported, or delegated must be understandable after the fact

Each `contextOp` should expose at least:

- operation type
- trigger
- reason
- input sources
- output targets
- effect on current context
- whether the user needs to care now

On the product surface, this likely means:

- `session.activity` for in-flight background actions such as compaction or worker execution
- a durable context-ops timeline in the session history or side panel
- per-turn activation summaries showing what context was loaded and why

The important rule is:

- **all major context changes become visible objects, not invisible prompt magic**

---

## Hard-coded vs model-led

The system should stay strict only where strictness protects correctness.

### System-owned and hard-held

- permissions and access boundaries
- delivery reachability and artifact access
- schema validation and object lifecycles
- maximum post-turn budget
- safety fallbacks for runaway loops
- durable logging of context operations
- capability exposure

### Model-led within those boundaries

- whether to continue or stop
- whether to compact now
- whether to delegate now
- whether a worker is needed
- whether deeper memory retrieval is necessary
- whether `workState` or `activeAgreements` should be refreshed
- what the next best continuation packet should contain

This is the core autonomy bargain:

- **the system owns the rails; the model owns the route**

---

## Relation to current RemoteLab surfaces

This design does not require a brand-new orchestration stack.

It should build on the primitives already present:

- `managerState` / `workState` as the main projection vocabulary
- continuation and compaction workers as existing bounded helpers
- `session-spawn` as the worker-launch primitive
- `session.activity` as the current in-flight activity surface

What changes is the abstraction around them:

- compaction becomes a `contextOp` plus `workState` refresh, not only a summary blob
- worker spawn becomes a first-class routing choice inside turn review, not just an ad hoc power feature
- activation becomes an `activationRecord`, not only a prompt principle
- continuation text becomes a projection of state, not the main source of truth

---

## Recommended rollout slices

### Slice 1 — Make turn review explicit

Add a small `turnReview` object and durable `contextOp` log without changing the main turn behavior yet.

Success condition:

- we can inspect why a turn compacted, delegated, or stopped

### Slice 2 — Reframe compaction as state refresh

Make compaction update `workState.continuation` and append a structured `compact_context` op.

Success condition:

- compacted sessions preserve canonical work truth without depending on one free-form summary blob

### Slice 3 — Add packet-shaped manager/worker flow

Formalize `delegationPacket` and `resultPacket` on top of the existing spawn primitive.

Success condition:

- noisy execution can move to workers without flooding the main session

### Slice 4 — Expose inspectable context ops in the UI

Surface in-flight and historical context operations as first-class product objects.

Success condition:

- users can understand what happened when context shifts or autonomy actions occur

### Slice 5 — Let the model drive turn closure by default

Once the objects and visibility are stable, let the model choose context operations during the turn-close window by default.

Success condition:

- autonomy grows mainly by improving model judgment instead of adding new hard-coded branches

---

## Non-goals

This design should not:

- expose raw chain-of-thought as a product requirement
- create an unbounded background loop that keeps acting forever
- replace all prompt guidance with magic state objects overnight
- replay full transcripts between parent and worker sessions
- force delegation for every task
- hide context changes from the user once they become operationally important

---

## One-sentence summary

RemoteLab should keep a normal chat turn as the primary interaction, then give the model one bounded, inspectable turn-close autonomy window in which self-check, compaction, delegation, and continuation are all expressed as explicit context operations on top of canonical work state.

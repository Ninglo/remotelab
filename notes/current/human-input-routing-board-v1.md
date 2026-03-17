# Human-Input Routing Board V1

> Status: exploratory baseline
> Purpose: define the first honest product shape for the owner-facing board when RemoteLab is treated as `AI work that occasionally blocks on human input`, not `human work occasionally assisted by AI`.

---

## Core stance

The durable unit is still the `Session`.

But the owner-facing board should no longer primarily answer:

> what status are my sessions in?

It should primarily answer:

> which session should I unblock first, and what context do I need in order to give a useful next input?

That means the primary product job is not generic workflow visualization.
It is **human-input routing**.

In this model:

- the session is the long-lived execution thread
- the AI pushes that thread forward as far as possible
- the human is a scarce blocking dependency that gets pulled in only at real checkpoints
- the board is the owner's queue for consuming and unblocking those checkpoints in the right order

---

## Problem with the current board

The current implementation is directionally useful but still organized more like a generic state board:

- `Active / Waiting / Open / Parked / Done`
- unread/new hints
- live activity hints such as running, queued, compacting
- lightweight priority derived from `workflowPriority`

This is fine as a session projection, but it does not yet optimize for the owner's actual question on return:

1. what needs me now?
2. what kind of input is needed?
3. what do I need to read before replying?
4. what reply will unblock the most progress?

So the gap is not mainly missing columns.
The gap is that the surface still describes session state better than it describes **human consumption order**.

---

## Product goal

When the owner opens RemoteLab, they should be able to do four things quickly:

1. see the next best session to consume
2. understand why that session needs human input
3. ingest only the minimum necessary context before replying
4. provide one high-value response that lets the AI continue autonomously

So the board should feel closer to:

```text
human unblock queue
```

than to:

```text
kanban for tracking generalized task status
```

---

## V1 mental model

The cleanest first version is:

```text
Session = durable work thread
Board = prioritized human-unblock view over sessions
```

Not:

```text
Board = separate project/task system
```

This stays aligned with the session-first architecture while changing the board's job.

---

## V1 surface recommendation

The primary surface should be a ranked queue, not a symmetric board.

This likely also means the owner shell should stop being primarily `chat-first with a sidebar`.

For the owner, the more honest default is:

```text
queue-first shell
  -> select a blocked session
    -> consume checkpoint
      -> reply once
        -> return the session to autonomous progress
```

If the current `Board` tab survives in the short term, it should visually bias toward one primary lane:

- `Needs You Now`
- `Running Without You`
- `Review / Done / Later`

But the stronger direction is an explicit queue-first layout:

### 1. Primary column: `Needs You`

This is the default landing surface.

Each row answers:

- what action type is needed
- why the AI is blocked
- what the human needs to read first
- what response shape is expected
- what will happen after the reply

This is the real consumption queue.

### 2. Secondary column: `Running`

Shows sessions currently moving without human help.

This is for monitoring, not for immediate action.

The owner should rarely have to open these unless:

- they are worried a run is stuck
- they want to inspect progress voluntarily
- the system escalates the session into `Needs You`

### 3. Tertiary column: `Done / Parked`

Reference, review, and low-pressure sessions.

These matter, but they should not compete visually with genuine unblock requests.

---

## Recommended shell shape

If we are willing to rethink the current owner layout more aggressively, the strongest V1 is:

### Left rail: navigation

- `Inbox`
- `Needs You`
- `Running`
- `Library`
- lightweight source/app filters

### Center pane: queue/feed

The center pane is the main work surface.

Depending on the selected mode, it shows:

- unresolved human checkpoints
- currently running sessions
- parked/done history

### Right pane: selected checkpoint detail

When a queue item is selected, the right pane shows:

- session name
- checkpoint capsule
- minimal context summary
- suggested reply structure
- quick actions: `Reply here` / `Open full transcript`

This keeps the owner's default experience focused on triage and unblocking rather than on browsing an always-open chat transcript.

---

## End-to-end owner loop

The intended owner loop should be:

1. land on `Needs You`
2. scan the first few queue cards
3. open the top card
4. read the checkpoint capsule, not the whole transcript first
5. pull missing context from your own brain/files/apps
6. send one compact reply packet
7. watch the session move back to `Running`
8. continue to the next blocked session

This is the workflow the board should optimize.

The board is successful if it reduces three costs:

- deciding what to read next
- figuring out what context to reload
- composing an answer that is actually useful to the AI

---

## Session routing state machine

V1 does not need a large task system.
It only needs a clean routing model over sessions.

### Canonical buckets

- `needs_you`
- `running`
- `parked`
- `done`

### Transition rules

#### `running -> needs_you`

Move a session into `needs_you` when the latest assistant turn emits an unresolved human checkpoint.

#### `needs_you -> running`

Move it back into `running` when the owner replies and the checkpoint is considered resolved enough for the model to continue.

#### `running -> done`

Move it into `done` when the current unit of work is complete and no active human checkpoint remains.

#### `running -> parked`

Move it into `parked` only when the session is intentionally deferred, not merely inactive.

#### `needs_you -> parked`

Allow this when the owner explicitly chooses to defer the blocker for later.

### Important design choice

`needs_you` should be driven by the existence of an unresolved checkpoint, not only by a coarse `workflowState` string.

The coarse state can stay for compatibility.
But the real routing quality comes from the checkpoint payload.

---

## Queue card anatomy

To support fast human consumption, a good V1 queue card should have a stable structure:

### Header

- action type badge
- session title
- urgency / priority hint

### One-line block reason

- why work cannot continue yet

### Read-first strip

- 1-3 bullets of mandatory context

### Ask strip

- the exact input requested from the owner

### Outcome strip

- what the AI will do after the reply

### Footer metadata

- source/app/project label when useful
- last checkpoint time
- expected reply shape

The card should aim to be answerable in one quick glance plus one click.

---

## Checkpoint resolution model

V1 should avoid complicated workflow engines.

The simplest useful model is:

- every session may have zero or one latest unresolved checkpoint that matters for routing
- a newer checkpoint supersedes an older unresolved checkpoint unless explicitly marked additive
- owner reply tentatively resolves the current checkpoint
- if the model still lacks what it needs, it emits a fresh checkpoint rather than silently staying blocked

This keeps queue semantics simple:

```text
one session
  -> at most one primary unresolved human checkpoint
```

That is enough for a strong first version.

---

## Relation to the control inbox

The `Control Inbox` and the owner board should not fight each other.

They solve adjacent but different jobs:

- `Control Inbox` = intake and routing of new intent
- `Needs You` board = consumption and unblocking of already-running work

So the best owner flow is likely:

1. new intent enters through `Control Inbox`
2. substantial work gets routed into a session
3. that session runs until a true human dependency appears
4. the blocker surfaces on the `Needs You` board
5. the owner replies there or opens the session from there

This is cleaner than trying to make the inbox itself also be the main blocker-consumption queue.

---

## Child-session visibility

If child/subagent sessions become common, they should not automatically flood the queue.

Default rule:

- hide child sessions from the owner's primary queue unless they escalate into a true owner-facing checkpoint

In other words, the owner should consume:

- top-level work that needs them
- not every internal execution branch the system created

This protects the product from turning into an observability dashboard for internal agent structure.

---

## Fallback behavior when the prompt is imperfect

V1 cannot assume every model turn emits a perfect checkpoint.

So the board should have a fallback derivation rule:

1. prefer explicit structured checkpoint data
2. otherwise infer a weak checkpoint from the last assistant message when it clearly asks for human input
3. otherwise keep the session out of `needs_you`

This matters because the queue should optimize for precision over recall.

It is better to miss a few soft asks than to flood the owner with vague pseudo-blockers.

---

## Card contract

The board cannot become good if a waiting session only exposes a vague chat bubble like:

> can you clarify this?

The session needs a structured checkpoint contract.

Each waiting session card should ideally expose:

- `action type`
  - `Clarify`
  - `Decide`
  - `Approve`
  - `Upload`
  - `Verify`
  - `Provide credential`
- `why blocked`
  - one sentence on what cannot proceed yet
- `read before reply`
  - 1-3 bullets of the minimum context to ingest
- `what I need from you`
  - the exact questions / deliverables
- `reply shape`
  - yes/no, A/B choice, bullet answers, file upload, freeform context
- `after reply`
  - one sentence on how the AI will continue

If a session cannot produce this summary cleanly, the problem is upstream in the prompt contract, not just in the UI.

---

## The key prompt contract

This product shape depends on the model emitting a crisp human checkpoint.

At any true blocking moment, the assistant should produce a structured block like:

```text
[HUMAN_CHECKPOINT]
type: clarify | decide | approve | upload | verify | credential
blocking: hard | soft
priority: now | soon | later
why_blocked: ...
read_before_reply:
- ...
- ...
request:
- ...
- ...
reply_shape: yes_no | choose | bullets | upload | freeform
suggested_reply: ...
after_reply: ...
```

The board then reads the latest unresolved checkpoint for each session and turns that into queue cards.

This keeps the architecture honest:

- the session remains the durable object
- the checkpoint is session-authored state, not a shadow board card object
- the UI is a projection over those checkpoints

---

## Prompt rules for the assistant

To make this work, the assistant needs a stricter operating rule:

1. Push the session forward until you hit a true human dependency.
2. Do not stop for weak uncertainty if a reasonable assumption keeps momentum.
3. When you do stop, batch the needed human inputs into one checkpoint instead of drip-feeding questions.
4. Tell the human what was already done before asking for more.
5. Ask for the smallest input packet that unlocks the largest next chunk of progress.
6. State what you will do immediately after the reply lands.

The model should optimize for **unblock quality per interruption**, not for polite conversational back-and-forth.

---

## Ranking logic

The owner does not need a perfectly accurate project-management score.
They need a good default order for attention.

V1 ranking should be simple:

1. `hard-blocked on human`
2. `small human effort unlocks large next progress`
3. `explicit urgency or deadline`
4. `higher project/session priority`
5. `more recent / context still warm`

Translated into a practical queue:

- first: sessions that truly cannot proceed without the owner
- second: sessions where a quick answer unlocks substantial autonomous work
- third: optional review or low-leverage asks

This is intentionally not the same as “most recently updated first”.

---

## Minimal state vocabulary

To stay compatible with the current session-first model, V1 should still keep workflow state lightweight.

At the board level, the owner mostly cares about four buckets:

- `needs_you`
- `running`
- `parked`
- `done`

`needs_you` can still map from session-level `workflowState = waiting_user`, but the richer routing quality should come from the latest checkpoint payload, not from inventing many new durable board statuses.

In other words:

- keep durable state small
- make the latest human checkpoint rich
- let the board derive its behavior from that checkpoint

---

## Open-session behavior

The queue alone is not enough.

When the owner opens a waiting session, the default focus should not be “drop them at the bottom of a long transcript and hope they scroll correctly”.

The session view should foreground a `checkpoint capsule` near the composer:

- what happened so far
- what matters now
- what input is needed
- suggested reply shape

Only after that should the full transcript matter.

This matches the actual workflow:

1. consume queue card
2. open session
3. ingest checkpoint capsule
4. recall external context from your own brain/files/apps
5. respond once
6. let the session continue

---

## Why a pure kanban is weaker here

Traditional kanban assumes the human is the ongoing operator of the work.

This product is different.
Here the AI is the default operator, and the human is a scarce unblock resource.

So a broad board with equal visual weight for every status risks teaching the wrong habit:

- browsing status
- manually supervising everything
- feeling responsible for continuous micromanagement

The better habit is:

- consume the unblock queue
- give high-quality context packets
- leave the rest alone until the next real checkpoint

That is why the primary surface should be queue-first even if a board-like projection still exists secondarily.

---

## Suggested V1 UI shape

If we were free to redesign the owner shell, a strong V1 would be:

### Top summary strip

- `3 need you`
- `5 running`
- `2 done to review`

### Main body

- default tab: `Needs You`
- secondary tab: `Running`
- tertiary tab: `Library`

### Queue card example

```text
[Decide] Auth callback strategy
Blocked because production domain choice affects the next deployment step.

Read first:
- Cloudflare tunnel is already healthy
- auth proxy works locally
- only the public callback URL is unresolved

Need from you:
- choose domain A or B
- confirm whether old URL can be retired

Reply shape: 2 bullets
After reply: I will update config, redeploy, and verify login end-to-end.
```

This is much closer to the actual job the owner is doing.

---

## What to ship first

The right first slice is mostly prompt and metadata, not a giant UI rewrite.

### Phase 1

- define the `[HUMAN_CHECKPOINT]` output contract
- teach the assistant to stop only at true blockers
- extract the latest unresolved checkpoint per session
- rank sessions primarily by unresolved checkpoint quality

### Phase 2

- add queue-first owner surface
- add checkpoint capsule inside session view
- demote generic board columns into a secondary projection

### Phase 3

- refine ranking with observed behavior
- add better checkpoint resolution semantics
- decide whether child/subagent sessions stay hidden unless escalated into the queue

---

## Practical design principle

The winning question for this surface is not:

> how do we represent all session states elegantly?

It is:

> how do we minimize the owner's cognitive cost to deliver the next high-value unblock input?

That should stay the north star for future iterations.

# Session Continuation Routing Architecture

Status: current working architecture as of 2026-04-14

## What this note is now

This note no longer describes the older `route_existing` / `route_new` classifier shape, and it also no longer describes the interim "every eligible turn goes straight into the full planner" design.

The current design is a two-stage pre-turn continuation-routing flow:

- stage 1: a lightweight model gate decides whether the incoming user turn can continue directly in the current session or whether it needs full split planning
- stage 2: only when stage 1 returns `needs_planning`, a full continuation planner decides concrete destinations and inheritance behavior

The important change is conceptual: the system is no longer trying to solve "should we split?" and "how exactly should we split?" with either hardcoded message rules or one overloaded planner call. Those are now separate responsibilities.

## Core product definition

Each user message that is eligible for continuation routing first goes through a hidden pre-turn control layer before the normal assistant turn begins.

That control layer now has two model surfaces:

- the continuation gate:
  lightweight
  transcript-light
  binary contract
  answers only whether this turn should continue directly or escalate into full split planning
- the continuation planner:
  heavier
  full-context
  destination-producing
  answers how the turn should continue when splitting is actually needed

The main session model should only handle work that already belongs to it after this routing layer finishes. It should not simultaneously answer the user and improvise session-routing decisions.

The important architectural boundary is:

- code may keep structural entry guards such as `dispatch enabled`, `message present`, `session exists`, or `internal turn exclusions`
- code should not own semantic routing rules such as keyword lists, topic-shift heuristics, agenda detection, or hardcoded split phrases
- semantic continuation decisions belong to model contracts:
  stage 1 decides `continue_direct` vs `needs_planning`
  stage 2 decides `continue` / `fork` / `fresh`

## Ambient assistant surfaces still use the same routing stack

Not every user-facing chat box is a topic-coherent work session. Personal-assistant style connector chats such as WeChat or Feishu DM threads can contain weather checks, reminders, one-off factual questions, and longer project work in the same running chat.

The current product cut does not add a second top-level product model for those surfaces. Instead, it keeps one continuation-routing stack and makes stage 1 conservative:

- simple one-off asks should usually remain `continue_direct`
- topic shift alone is not enough to escalate into full split planning
- only clearly separate durable work, obviously mismatched turns, or genuinely multi-task inputs should escalate into stage 2 and potentially split into `fork` / `fresh`

This keeps the product simpler while still avoiding the worst over-splitting behavior in loose connector chats.

## Stage 1: continuation gate

Stage 1 is intentionally not a keyword filter. It is a small model judgment with a deliberately narrow output contract.

Its job is only to answer:

- `continue_direct`
- `needs_planning`

It should see a compressed view of the current session:

- current session identity/summary fields
- the incoming user message
- only a recent transcript slice rather than the full planner context window

It should not:

- invent destination sessions
- rewrite delivery text
- decide `fork` versus `fresh`
- generate forwarded bridge context

Its design goal is to keep the hot path cheap while still being semantic rather than hardcoded.

The default bias is:

- weak evidence resolves to `continue_direct`
- only meaningful evidence of a separate downstream workstream escalates to `needs_planning`

## Stage 2: continuation planner

Stage 2 is the existing full continuation planner, but it no longer runs on every eligible turn.

It only runs after stage 1 returns `needs_planning`.

Stage 2 sees the fuller current-session context because it is solving a more expensive problem:

- should the current session keep one destination
- should one or more branch sessions be created
- should one or more fresh sessions be created
- what forwarded bridge context and scope framing each destination needs

## Continuation modes

### `continue`

The message still belongs to the current session's main thread. The current session remains the owning session and processes the input normally.

### `fork`

The message is strongly related to the current session and still depends on the parent transcript, but should branch into its own child session so the main thread and the new branch can continue independently.

This mode should inherit rich parent context.

### `fresh`

The message should become a new workstream. It may be triggered from the current session, but it should not keep accumulating inside the current session's main thread.

This mode should inherit only a minimal forwarded bridge context, not the full raw parent transcript.

## Multiple destinations

One user input may return multiple destinations when the planner can clearly identify multiple downstream workstreams inside the same message.

This is not "split because several nouns were mentioned." It is only valid when the message truly contains multiple continuations that should proceed separately.

The planner therefore returns destinations, not merely a single action. Each destination has its own continuation mode and its own inheritance profile.

## Inheritance profiles

### `reuse_current_context`

Used by `continue`. The current session keeps using its normal prompt and history.

### `full_parent_context`

Used by `fork`. The child session inherits the full parent continuation context in prompt space. The child does not need a copied visible transcript, but it should receive the same parent continuity material the current session was already using so the branch starts from the same understanding baseline.

### `minimal_forwarded_context`

Used by `fresh`. The child session receives only the minimal forwarded bridge needed to make sense of why it exists and what constraints or prior facts matter.

## Prompt/cache shape

The gate and planner intentionally do not use the same amount of context.

The gate should stay small and cheap. The planner and the eventual execution session should share the same upstream context prefix whenever they are reasoning about the same current thread.

That means:

- the gate should inspect only a compressed recent current-thread slice
- the planner should inspect the same fuller current-thread context the split decision needs
- fork branches should reuse that same parent context as prompt inheritance

The optimization goal is therefore not "copy the same summary everywhere." It is:

- keep the gate cheap
- only pay the full-context planning cost on actual split candidates
- reuse the same full upstream context prefix when the semantic relationship actually justifies it

For `fresh` sessions, semantic cleanliness matters more than forcing shared prefix reuse. A fresh session should start from a planner-written bridge summary plus only the required carried facts, not from the whole parent transcript just to chase cache hits.

## Output contracts

### Stage 1 gate contract

The gate may reason flexibly, but its output contract should stay narrow. At minimum it returns:

- action: `continue_direct` or `needs_planning`
- confidence
- reasoning

The system should treat stage 1 as an escalation decision, not as a hidden destination planner.

### Stage 2 planner contract

The planner may reason flexibly, but its output contract should stay stable. At minimum it returns:

- planner version / confidence
- overall reasoning and a short user-visible summary
- one or more destinations
- for each destination:
  mode
  inheritance profile
  destination reasoning
  scope framing
  delivery text
  forwarded context
  optional title hint

The system should treat stage 2 output as the authoritative destination plan once stage 1 has escalated into it.

## Execution flow

1. The user submits a message.
2. The system accepts and persists it, exposing a `checking` planning state.
3. Stage 1 runs against a compressed recent current-session slice plus the new user input.
4. If stage 1 returns `continue_direct`, the message is processed in the current session without invoking the full planner.
5. If stage 1 returns `needs_planning`, stage 2 runs against the fuller current-session context.
6. If stage 2 returns a trivial single `continue`, the message is processed in the current session.
7. If the result includes `fork` and/or `fresh` destinations:
   - `continue` destinations stay in the current session
   - `fork` destinations create child sessions with full parent continuation inheritance
   - `fresh` destinations create new sessions with minimal forwarded bridge context
8. The source session or connector surface receives a visible continuation notice when work was moved into one or more durable sessions.

## Visible history vs prompt inheritance

This architecture explicitly separates prompt inheritance from visible chat history.

Forked sessions should feel like they inherited the parent thread because the prompt carries the parent continuation context, not because the UI copied every old message into the child transcript.

Fresh sessions should begin with a clean visible history even though the first turn may still carry a small planner-written forwarded bridge in prompt space.

## Responsibility split

The continuation gate owns:

- deciding whether the turn can continue directly
- deciding whether full split planning is worth paying for

The continuation planner owns:

- deciding continuation mode once planning is required
- deciding whether there are multiple destinations
- deciding inheritance profile per destination
- deciding concrete split/no-split execution for the current user input after escalation

The main session model owns:

- only the work assigned to the current session after planning

The session-creation layer owns:

- creating child/fresh sessions
- applying the correct inheritance mechanism
- appending visible continuation notices

## Relation to old concepts

The new model absorbs older concepts rather than keeping them side by side:

- old `dispatch`: absorbed into the continuation planner
- old hardcoded routing heuristics: replaced by the lightweight continuation gate
- old `restore`: absorbed into inheritance profiles and prompt inheritance
- old session-spawn/delegate branching: remains an execution action, but should not act as a second routing brain for the user message itself

The key architectural rule is now:

The front door first decides whether heavy planning is needed. If yes, it then decides continuation mode. Session execution happens second.

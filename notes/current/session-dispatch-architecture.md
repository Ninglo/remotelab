# Session Continuation Planner Architecture

Status: current working architecture as of 2026-04-12

## What this note is now

This note no longer describes the older `route_existing` / `route_new` classifier shape.

The current design is a pre-turn continuation planner that decides how a new user input should continue relative to the current session:

- continue in the current session
- fork into one or more related branch sessions
- start one or more fresh sessions with minimal forwarded context

The important change is conceptual: the system is no longer trying to do arbitrary historical-session routing first. It is deciding continuation mode first, then deriving destination sessions and inheritance behavior from that result.

## Core product definition

Each user message first goes through a hidden planner before the normal assistant turn begins.

That planner sees the full current-session context that the main execution path would have used, rather than a thin summary-only view. The reason is simple: deciding whether something is the continuation of the current thread is a transcript-understanding problem, not a keyword-matching problem.

The planner does not belong to the main session model. It is a separate pre-turn control layer. The main session model should only handle work that already belongs to it after planning, rather than simultaneously answering the user and improvising routing decisions.

## Ambient assistant surfaces still use the same planner

Not every user-facing chat box is a topic-coherent work session. Personal-assistant style connector chats such as WeChat or Feishu DM threads can contain weather checks, reminders, one-off factual questions, and longer project work in the same running chat.

The current product cut does not add a second top-level product model for those surfaces. Instead, it keeps one continuation planner and makes that planner more conservative:

- simple one-off asks should usually remain `continue`
- topic shift alone is not enough for `fresh`
- only clearly separate durable work, obviously mismatched turns, or genuinely multi-task inputs should split into `fork` / `fresh`

This keeps the product simpler while still avoiding the worst over-splitting behavior in loose connector chats.

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

The planner and the eventual execution session should share the same upstream context prefix whenever they are reasoning about the same current thread.

That means:

- the current session transcript should be loaded as raw prompt material, not rewritten first
- the planner should inspect the same current-thread context the main execution path would have used
- fork branches should reuse that same parent context as prompt inheritance

The cache optimization goal is therefore not "copy the same summary everywhere." It is "reuse the same full upstream context prefix when the semantic relationship actually justifies it."

For `fresh` sessions, semantic cleanliness matters more than forcing shared prefix reuse. A fresh session should start from a planner-written bridge summary plus only the required carried facts, not from the whole parent transcript just to chase cache hits.

## Planner output contract

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

The system should treat that output as the authoritative pre-turn control result.

## Execution flow

1. The user submits a message.
2. The system accepts and persists it, exposing a `checking` planning state.
3. The pre-turn planner runs against the current session transcript plus the new user input.
4. If the result is a trivial single `continue`, the message is processed in the current session.
5. If the result includes `fork` and/or `fresh` destinations:
   - `continue` destinations stay in the current session
   - `fork` destinations create child sessions with full parent continuation inheritance
   - `fresh` destinations create new sessions with minimal forwarded bridge context
6. The source session or connector surface receives a visible continuation notice when work was moved into one or more durable sessions.

## Visible history vs prompt inheritance

This architecture explicitly separates prompt inheritance from visible chat history.

Forked sessions should feel like they inherited the parent thread because the prompt carries the parent continuation context, not because the UI copied every old message into the child transcript.

Fresh sessions should begin with a clean visible history even though the first turn may still carry a small planner-written forwarded bridge in prompt space.

## Responsibility split

The continuation planner owns:

- deciding continuation mode
- deciding whether there are multiple destinations
- deciding inheritance profile per destination

The main session model owns:

- only the work assigned to the current session after planning

The session-creation layer owns:

- creating child/fresh sessions
- applying the correct inheritance mechanism
- appending visible continuation notices

## Relation to old concepts

The new model absorbs older concepts rather than keeping them side by side:

- old `dispatch`: absorbed into the continuation planner
- old `restore`: absorbed into inheritance profiles and prompt inheritance
- old session-spawn/delegate branching: remains an execution action, but should not act as a second routing brain for the user message itself

The key architectural rule is now:

The front door decides continuation mode first. Session execution happens second.

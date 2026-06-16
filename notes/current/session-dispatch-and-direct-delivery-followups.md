# Session Dispatch And Direct Delivery Follow-ups

Status: active execution todo as of 2026-04-14

Companions:

- `notes/current/session-dispatch-architecture.md`
- `notes/current/wechat-connector-followups.md`
- `notes/current/connector-reply-publication-architecture.md`
- `notes/current/user-feedback-log.md`
- `notes/current/knowledge-layers-and-connectors.md`

## Why this note exists

- Recent work on session dispatch, accepted-to-checking UX, direct connector sends, and reminder delivery has been discussed across several sessions and is now too easy to lose as scattered chat residue.
- The older arbitrary historical-session routing behavior was disruptive enough to live discussion that the owner instance was temporarily switched to `dispatch=off`.
- The same debugging thread exposed a second boundary problem: deterministic outbound work such as reminders and notifications should not be forced through the same path as AI conversation replies.

## Confirmed current state

- The accepted-to-checking send UX remains the right direction:
  message send completion should mean accepted/persisted first
  any continuation planning should be visible afterward instead of hiding inside `sending`
- The architecture direction is no longer arbitrary historical-session routing first.
  It is now:
  stage-1 continuation gate
  stage-2 continuation planner
  continuation modes (`continue` / `fork` / `fresh`)
  per-destination inheritance profiles
- The stage-1 gate should read only a compressed recent current-session slice plus the new user input.
- The stage-2 planner should still read the fuller current-session transcript as primary evidence when stage 1 escalates into planning.
- Code-level gates should stay structural rather than owning keyword-level split logic.
- The repo implementation now aims to remove old `route_existing` / `route_new` semantics and old message-content routing heuristics from the main path rather than hardening them further.
- The continuation-routing path exists, but live instances should keep `REMOTELAB_SESSION_DISPATCH=off` until the routing design is revisited with stronger transcript-aware validation.
- Persisted accepted-check queue state now writes `pendingContinuationQueue`; legacy `pendingPlanningQueue` should be normalized away on load rather than kept alive as a parallel storage shape.
- The frontend/API activity contract for this stage is `session.activity.continuation`, with `checking` as the visible accepted-but-still-routing state.
- The current inheritance rule is now sharper:
  `fork` should reuse full parent continuation context
  `fresh` should start from planner-written minimal bridge context
- A new product boundary also needs to be accounted for:
  loose personal-assistant connector chats are not always topic-coherent work sessions
  for the current cut, simple self-contained asks in those surfaces should usually just stay in the current session
  only clearly separate or complex work should split
- Reminder delivery debugging confirmed that the current reminder pipeline is a direct programmatic path, not an AI/session path.
- The current personal reminder channel config includes `mac_notification`, `feishu`, and `remotelab_web_push`, but not `wechat`.
- Direct WeChat send capability exists at the connector transport layer, but the reminder flow does not currently wire that capability into its delivery config or main-instance policy.

## Priority backlog

### P0 — restore session continuity through two-stage continuation routing

- Problem:
  Misrouting an active design or debugging thread is worse than not routing at all. When the system cannot reliably recognize "this is clearly continuing the current thread," dispatch becomes a product regression rather than a convenience.
- Desired outcome:
  The front door should make continuity-first continuation decisions before the main session runs.
- Required shape:
  Stage 1 should use a lightweight model gate, not hardcoded message-content `if/else`.
  Stage 1 should see only compressed recent context and return `continue_direct` or `needs_planning`.
  Weak evidence should resolve to `continue_direct`.
  Stage 2 should see the fuller current-session transcript plus session description.
  Related-but-separate work should become `fork`, not an arbitrary historical-session route.
  Truly new work should become `fresh`, with only minimal forwarded bridge context.
- Acceptance:
  Multi-turn design/debug discussions that mention overlapping implementation keywords do not jump into unrelated historical sessions.

### P0 — separate split detection from split planning cleanly

- Problem:
  "Do we need to split?" and "how should we split?" are different-complexity questions, but the system keeps drifting between hardcoded gates and one overloaded planner.
- Desired outcome:
  The send path should have exactly two semantic model layers with distinct scope:
  stage 1 decides whether full planning is needed
  stage 2 decides concrete destinations only when needed
- Required shape:
  Stage 1 should not invent child sessions, rewrite delivery text, or choose `fork` versus `fresh`.
  Stage 2 should own destination design, inheritance profile, forwarded bridge context, and title hints.
  Normal model execution should consume already-scoped work rather than re-deciding whether to split or route.
  Delegation/session-spawn should remain an execution action, not a second routing brain.
- Acceptance:
  There is one clean gate contract and one clean planner contract, and downstream runs inherit scope instead of improvising it.

### P0 — keep send fast and make checking explicit

- Problem:
  Hidden pre-send routing checks create anxiety because the user only sees a slow `sending` state and cannot tell whether the message was accepted.
- Desired outcome:
  `send complete` means the system has accepted and persisted the message.
  Any routing/planning work becomes a visible follow-up stage.
- Required shape:
  `sending` should end as soon as the transport accepts the message.
  `checking` should be explicit and non-blocking.
  `checking` may cover both stage 1 and stage 2 internally, but the implementation should keep those phases distinct in code.
  The primary feedback should attach to the just-sent user message in the chat flow rather than living only in the composer footer.
  Final visible outcomes should distinguish:
  stayed here
  moved to an existing session
  created a new session
- Acceptance:
  Users can tell the difference between "message accepted" and "message still being classified."

### P0 — define the direct-delivery boundary clearly

- Problem:
  Deterministic outbound work such as reminders, alerts, acknowledgements, and simple pushes currently risks getting mixed with AI/session-oriented reply flows.
- Desired outcome:
  The main instance owns the policy choice between:
  direct connector delivery
  AI/session-mediated conversation
- Required shape:
  Deterministic pushes should prefer direct connector actions when a bound channel exists.
  Session injection should be reserved for work that actually needs model reasoning or transcript participation.
  Connector scripts should stay thin:
  transport
  auth
  binding
  retry/health
  not product-level delivery policy.
- Acceptance:
  A reminder or plain outbound confirmation can be delivered to the bound source channel without creating a synthetic AI conversation turn.

### P0 — wire WeChat reminder delivery intentionally, not accidentally

- Problem:
  A reminder visible in RemoteLab but absent in WeChat looks like a failed notification even when the actual root cause is simply missing WeChat channel wiring.
- Desired outcome:
  If WeChat is a desired reminder target, it becomes an explicit first-class delivery channel in the reminder flow.
- Required shape:
  Either:
  add WeChat as a supported reminder channel in the direct delivery pipeline
  or replace per-reminder channel wiring with a main-instance-owned source-channel delivery primitive that resolves the correct outbound target from session/source binding.
- Acceptance:
  A source-bound reminder reaches the correct WeChat target without relying on session-message injection or manual shell work.

### P1 — standardize connector-visible reply behavior across channels

- Problem:
  Different connectors still risk drifting in how they show processing acknowledgements, empty replies, final replies, and silent confirmations.
- Desired outcome:
  User-visible reply policy is owned centrally and applied consistently across WeChat, Feishu, and future thin connectors.
- Acceptance:
  Connector differences are transport-specific, not policy-specific.

### P1 — make connector capability discovery explicit to the agent

- Problem:
  The agent can mis-pick a session path when the direct-send capability exists but is not surfaced clearly enough as a first-class action.
- Desired outcome:
  Capability descriptions distinguish:
  what can be sent directly
  what requires an AI/session turn
  what is only available on some connectors
- Acceptance:
  Future reminder/notification flows do not depend on the agent "remembering" hidden connector-specific scripts.

### P1 — update stale architecture notes after the behavior settles

- Problem:
  `notes/current/session-dispatch-architecture.md` previously described the older sync-in-send + `route_existing` / `route_new` framing and needed to be rewritten around continuation modes.
- Desired outcome:
  Once the new planner/restoration direction is stable, current notes should describe the real target behavior without mixing historical implementation phases into one fuzzy narrative.
- Acceptance:
  A new contributor can read the notes tree and understand:
  why hardcoded routing heuristics were removed
  what stage 1 now does
  what stage 2 now does
  how direct delivery differs from AI conversation

## Immediate operating rule until the backlog lands

- Do not re-enable the old arbitrary historical-session routing path.
- Keep the two-stage continuation-routing path as the only routing path on the main instance.
- Do not treat deterministic reminders or plain outbound pushes as normal AI conversation turns.
- Prefer direct connector delivery when the outcome is already known and no model reasoning is required.
- Use this note as the backlog anchor before splitting the work into narrower implementation sessions.

## Restore criteria for the continuation-routing stack

- Stage 1 uses compressed recent current-session context, not hardcoded message heuristics.
- Stage 2 uses full current-session transcript context once stage 1 escalates.
- In loose personal-assistant connector chats, simple self-contained asks should still usually resolve to `continue_direct`.
- Weak evidence defaults to `continue_direct`.
- `fork` is used for related branches that still need full parent context.
- `fresh` is used for new workstreams with minimal forwarded bridge context.
- Send UX clearly shows accepted versus checking versus routed outcomes.
- The main system can explain routing decisions in a lightweight visible way without interrupting discussion.

## Current remaining todo after landing the two-stage path

- Validate the gate and planner in real owner-session usage and watch for the two main failure modes:
  over-eager splitting
  under-splitting that leaves unrelated work in one thread
- Validate that loose connector chats do not over-split on simple self-contained asks, while clearly separate or complex work still splits when appropriate.
- Improve observability so it is easier to inspect why stage 1 stayed direct or escalated, and why stage 2 became `continue`, `fork`, or `fresh`, without reading raw prompt output.
- Keep cleaning old naming residue in code and docs where `dispatch` still means the older routing model rather than the new continuation-routing stack.
- Polish the visible continuation notice / card layer so routed outcomes are easier to understand at a glance.
- Measure the actual runtime effect of the two-stage model path:
  latency
  token cost
  gate false-positive / false-negative rate
  prompt-cache behavior

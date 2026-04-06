# Session Main Flow + Context Freshness Next Push

Status: reference / mostly-landed execution pack as of 2026-04-06

2026-04-06 note:

- `session-first` 主流程、`cross-session context freshness`、`one-turn multi-session fan-out` 这几条能力已被视为基本落地，不再作为当前项目主推 backlog 挂着。
- 这份文档保留为设计和验收参考，不再代表当前最需要推进的小 todo 清单。
- 此前拆出去的回归修复线程也已完成并清掉；这份文档现在主要只作历史 / 设计参考。

Workflow baseline: `notes/current/session-first-workflow-surfaces.md`
Higher-level product operating note: `notes/current/product-mainline.md`

## One-line goal

- Make the next push feel like an AI collaborator that keeps work coherent across multiple sessions, not like a thin shell around isolated chats.

## Product shape for the next push

- The owner can operate RemoteLab cleanly from session-first surfaces.
- One manager/control session can take a single user request and fan it out into several focused parallel sessions when useful.
- A new or sibling session can pick up recent relevant context learned elsewhere so the user does not need to restate everything in every chat.
- Imported context stays bounded and inspectable; prefer summaries, refs, and explicit continuation packets over replaying entire transcripts.
- Sessions remain the canonical durable object; any richer workflow surface must be re-earned later as a derived optional layer.

## Demo we should be able to show

1. Open RemoteLab into the session-first owner flow.
2. Start or continue from a main session, session list, or lightweight dispatcher-style surface.
3. Ask something that assumes recent context from another session, such as “continue the approach we just settled elsewhere and split it into three parallel tasks”.
4. The system can either pull the right recent context automatically or make the linkage explicit in a lightweight way.
5. The manager session can spawn multiple worker sessions and later return a concise aggregation.
6. We can inspect what context each continued or spawned session actually received.

## Scope freeze

### In scope

- Clarifying the owner main flow from session-first surfaces.
- One-turn multi-session fan-out.
- A minimal cross-session context freshness contract.
- Observability and regressions directly blocking the above.

### Explicitly out of scope

- Reintroducing a secondary planning surface as the owner default.
- Introducing a separate durable `Task` or workflow-card object.
- A giant always-on global memory system or transcript-sharing layer.
- A broad core-domain refactor pass.
- Provider registry / provider settings UX.
- Full standalone `Control Inbox` productization.

## Concrete slices

### Slice 1 — validate the session-first main flow

**Outcome**

- The product can be evaluated cleanly through its session-first surfaces.

**Product rules**

- Session list, active session, or lightweight dispatcher surfaces are acceptable defaults.
- Do not let retired workflow affordances survive as hidden dependencies for everyday operation.
- If a UI element only exists to prop up an abandoned interaction model, remove it rather than preserving it as a latent constraint.

**Main files**

- `templates/chat.html`
- `static/chat/ui.js`
- `static/chat/compose.js`
- `static/chat/session-state-model.js`

**Acceptance**

- The owner can navigate and operate the main flow cleanly.
- Core orchestration does not depend on retired workflow surfaces.
- The interaction model feels clearer, not more constrained.

### Slice 2 — cross-session context freshness contract

**Outcome**

- Multiple sessions can feel connected without collapsing into one unbounded transcript.

**Product rules**

- Optimize for the "I already told you elsewhere" and "keep up with recent updates" cases.
- Reuse bounded summaries, refs, recent-decision packets, or explicit handoff blocks instead of raw transcript replay.
- Make source and freshness visible enough for debugging and operator trust.
- Keep automatic imports conservative until they prove safe.

**Main files**

- `chat/session-manager.mjs`
- `chat/session-continuation.mjs`
- `chat/history.mjs`
- `chat/runs.mjs`

**Acceptance**

- A new or sibling session can receive recent relevant context from related work.
- The imported packet is bounded and explainable.
- The user does not need to restate obvious recent context across every session.

### Slice 3 — one-turn multi-session fan-out

**Outcome**

- One user turn can intentionally create several worker sessions and get a clean orchestration result back.

**Product rules**

- Do not introduce a batch-orchestration object yet.
- Keep spawned sessions operationally independent after spawn.
- Prefer a concise source-session aggregation and normal session-level navigation over one required handoff note per spawned session.
- Prefer reusing the current spawn/delegate primitives over creating a separate orchestration stack too early.

**Main files**

- `chat/session-manager.mjs`
- `chat/router.mjs`
- `cli.js`
- `lib/session-spawn-command.mjs`

**Acceptance**

- Recursive or repeated spawn works end to end.
- Source-session orchestration stays lightweight.
- The source session can return a concise final aggregation.
- Spawned sessions remain independent and bounded.

### Slice 4 — continuation observability and bounded carry validation

**Outcome**

- Multi-session flows are cheap enough and debuggable enough to trust.

**Product rules**

- The important question is not “do we have memory?” but “what did this session actually inherit, from where, and how fresh was it?”
- Keep continuation paths explicit: raw history, same-session summary handoff, prepared branch context, and any new cross-session import packet.
- Treat this as focused enabling work, not a new memory architecture initiative.

**Main files**

- `chat/session-manager.mjs`
- `chat/history.mjs`
- `chat/runs.mjs`

**Acceptance**

- We can tell which continuation path a run used.
- Compaction remains safe and bounded.
- Cross-session imports do not silently drag too much transcript into the prompt.
- Prepared fork-context reuse is trustworthy again.

## High-priority open todo

- This deserves a dedicated design session once the current main-flow discussion stabilizes.
- The central unresolved question is how to deliver a “same friend across many chats” feeling without exploding the context window.
- Open questions:
  - How should related sessions be discovered: explicit linking, recency, shared app/group, manual pickers, or heuristics?
  - What is the minimal reusable unit: summary, decisions, refs, diff since last read, or a prepared context packet?
  - When should RemoteLab auto-import context versus suggest it versus ask the user?
  - How does the operator inspect or trim imported context before it bloats the prompt?
  - How do we avoid turning many bounded sessions into one hidden giant transcript?

## Remaining regression cleanup

- `tests/test-http-session-spawn-recursive.mjs` is red; this is the concrete canary for multi-session fan-out.
- `tests/test-session-forking.mjs` is red; this is the concrete canary for prepared fork-context confidence.
- These are now treated as focused cleanup items, not proof that the whole push is still unresolved.

## Tests that define “good enough” for the next push

- `tests/test-chat-session-state-model.mjs`
- `tests/test-http-runtime-phase1.mjs`
- `tests/test-http-session-spawn-recursive.mjs`
- `tests/test-session-forking.mjs`
- `tests/test-auto-compaction.mjs`
- `tests/test-http-session-summary-refs.mjs`
- Add a dedicated cross-session context-freshness validation once the contract is defined.

## Default decisions unless reality disproves them

- No separate `Task` object this push.
- No heavyweight persistent parent/child graph this push.
- The active owner flow stays session-first for this push.
- Prefer conservative, inspectable context imports over magical always-on sharing.
- `Control Inbox` stays a follow-on layer built on top of the session-first + multi-session contract, not a prerequisite.

## Historical push gate

- The owner flow is coherent on the active session-first surfaces.
- Cross-session context freshness is demoable in a bounded, inspectable way.
- One-turn multi-session fan-out is demoable end to end.
- Final aggregation is reliable without requiring heavy parent-side handoff UI.
- We can explain how a run got its continuation context.
- The two current red tests above are either green or explicitly judged non-blocking with a clear reason.

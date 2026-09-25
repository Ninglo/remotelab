# Prompt Projection Boundary

## Core stance

RemoteLab is a substrate above several capable Harnesses, not another semantic Harness.

Its prompt projection exists to tell the selected Harness facts that only RemoteLab can supply. It must not recreate task interpretation, planning, safety policy, execution judgment, self-review, reply style, or permission heuristics already owned by the Harness and the current user context.

## What belongs in the projection

- runtime and source identity, including an authenticated owner or share-link visitor role
- code-backed instance and authorization scope
- a uniform discovery entry point for available RemoteLab capability families; detailed invocation syntax when the task needs it
- short natural-language cues for core RemoteLab workflows whose intent is otherwise easy to miss
- connector identities and binding-scoped actions
- user-reachable artifact and delivery protocols
- memory/context pointers
- provider-neutral work state, explicit session agreements, and continuation material
- Agent template instructions explicitly chosen for the session

These are projections of product state or capability. Prompt text is not their source of truth.

## What does not belong

- a RemoteLab persona or house reply style
- generic instructions about when to continue, clarify, plan, split, or self-review
- generic secret, credential, filesystem, or content-handling policy for owner sessions
- copies of provider-native developer instructions or safety rules
- a shared startup-defaults bundle of cross-user behavior preferences
- per-turn manager reminders that repeat the same behavioral advice

When a rule is an actual access invariant, code must enforce or structurally expose it. A short role/scope fact may still be projected so the Harness can reason with the boundary, but prose must not pretend to be the enforcement layer.

## Current projection layers

1. `chat/system-prompt.mjs` renders the startup transport contract, compact core-workflow cues, context pointers, and uniform capability directory for a fresh provider thread.
2. `chat/turn-context-hook.mjs` projects optional local-bridge state, explicit agreements, and source metadata on later turns.
3. `chat/session-manager.mjs` adds source/runtime instructions, Session instructions, continuation, and explicit operator context when applicable.
4. Provider adapters invoke the Harness without a RemoteLab-owned developer-instruction default. An explicit operator override remains available.

## Stability gate

Every proposed always-on prompt line should answer: “What RemoteLab state or capability would the Harness otherwise be unable to know?”

If there is no concrete answer, the line belongs in user memory, an Agent template, repo-local instructions, an on-demand skill, or nowhere. Tests should assert both the facts that must remain and the behavioral policy blocks that must stay absent.

## Activation rule

Use the lowest layer that lets the Harness discover and correctly use a capability. Equal treatment means applying the same promotion criteria, not giving every capability equal prompt length. A long description of one connector beside silence about the others creates an accidental priority signal. Conversely, a pointer alone may hide a core workflow when users invoke it in ordinary language without naming a command.

| Layer | Admission test | Content |
| --- | --- | --- |
| Always-on transport contract | Needed for this Session regardless of task, and unavailable through the Harness or a tool response | Actual source and instance scope, user-reachable artifact/reply protocol, and short pointers to durable context. Keep code-enforced access boundaries in code; project only the role/scope fact needed to work within them. |
| Core workflow cue | Users often request this workflow indirectly in natural language, and a catalog pointer alone is unlikely to identify the right action | A short intent-to-action mapping, one stable entry point, and the result/receipt boundary. Session handoff and durable automated Tasks currently qualify; examples should clarify the distinction without becoming command manuals. |
| Uniform capability index | A supported user-facing capability that the Harness may need to discover | One comparable entry per capability family: purpose, current availability when known, and the command or resource that gives live status and usage. Include Session creation, triggers/schedules, agenda, user mailbox, Agent mailbox, connector actions, and local bridge under the same rule. The cue above may add justified depth to a core entry. |
| Task- or source-scoped detail | The current request, bound source, or explicit Session setup makes the detail relevant | Read CLI help, a skill, or a source-specific guide at use time. Project necessary source reply format, identity/binding information, active Session agreements, and continuation state only into the matching Session/turn. |

Promote or demote a workflow cue using observed request frequency, how often users omit the product's technical term, the cost of choosing the wrong workflow, and evidence from real task outcomes. Product centrality is a reason to test stronger discovery, not an exemption from size and neutrality review. Keep natural-language examples short and revise them when users' wording changes.

For the current core workflows, distinguish these intents:

- “Do this work in a new Session,” “hand this off,” or “do this in parallel” calls for a user-visible Session that starts the supplied work now. `session-spawn` returns a Session URL and admission receipt; admission is not completion. A request for an empty new Session is a different action and must not acquire an invented task.
- “Do/check this later” or “do this every day” calls for a durable automated Task backed by a Trigger or Schedule. Confirm its timing, target Session, and result destination from the request and returned record.
- “Task” alone may refer to immediate Session work, a timed automated Task, or an external to-do. Use the surrounding intent, time, and owner/delivery clues; clarify only the missing distinction when it cannot be inferred. Do not invent a schedule or a second task object from the word alone.

The prompt should contain a concise version of these cues and the discovery commands (`session-spawn --guide`, `trigger create --help`, `schedule create --help`). Detailed handoff packets, schedule syntax, connector binding, and failure recovery remain task-scoped.

The index must distinguish product support from a connector being ready in this instance. A startup snapshot is not authority for an action whose credentials, binding, or state can change; check live status when using it. A capability that is absent from the index should not be silently treated as unavailable if the Harness or local CLI exposes it.

Detailed commands, fallback invocations, subscription links, examples, error recovery, and connector-specific identity rules belong in the task-scoped layer unless their absence would cause an immediate wrong action before discovery is possible. If the latter is true, first ask whether the CLI/API can enforce the boundary or return it with the capability status. Prompt prose is the fallback, not the access control.

## Repeated-turn rule

Startup facts should not be replayed on every turn merely to keep them visible. Per-turn projection should contain fresh source metadata, explicit active Session agreements, and context needed to continue the current work. A compact core-workflow cue may be repeated when the provider's retained context cannot reliably preserve discovery; it must not repeat the full workflow guide or appear twice in the same assembled prompt. Memory writeback paths and general capability manuals should be retrieved when those workflows are active. A linked device or connector may add a short state and discovery pointer; its full command list belongs in its own help surface.

## Change review and drift control

For any addition to RemoteLab-owned model context, record in the change review:

1. The concrete failure if the text is absent, and evidence that the Harness cannot already discover it.
2. The owner and activation scope: every Session, one source, one Session, or one task.
3. The canonical source of truth and how live or changing facts will be refreshed.
4. The size and duplication effect on a fresh Session and a resumed turn, including whether the change makes one capability more prominent than comparable capabilities.
5. The scenario that verifies both correct use when relevant and no unnecessary influence on unrelated work. For a core cue, include casual natural-language requests and an ambiguous “task” request.

Prefer replacing an older instruction to appending a new one. Review the rendered model-context slots, not only source files: startup, per-turn, source/runtime, Session instructions, local bridge, continuation, and explicit operator overrides have different owners and lifetimes. Keep a dated size and scenario baseline when changing these layers; treat growth as a decision requiring evidence, not as a free side effect of adding a feature. Do this review during prompt-affecting changes and periodic product cleanup, without creating an extra background Agent or schedule solely to police prompt length.

## Audit baseline: 2026-09-23 owner instance

The 7696 service reported commit `772cc19f`; the prompt files inspected here were unchanged between that commit and the current worktree HEAD. These are rendered character counts, not token measurements or usage-frequency estimates.

| Rendered slice | Characters | Current activation and review outcome |
| --- | ---: | --- |
| Fresh-thread startup, total | 7,389 | Contains the transport contract plus detailed manuals for selected capabilities. |
| Session creation and scheduling | 1,973 | Always included for a parent Session; retain a short handoff/Task intent cue and entry points, and move detailed scheduling and conversation-binding rules behind discovery. |
| Calendar | 1,883 | Included when the instance feed exists; move workflow and subscription details to agenda help or task-scoped retrieval. |
| Gmail | 1,546 | Included regardless of Gmail readiness; replace with a uniform mailbox discovery entry. |
| Base per-turn hook, including delegation | 1,028 | Repeats nine memory paths and delegation guidance; retain current-turn context and relevant pointers, plus at most one compact core-workflow cue where needed. |
| Feishu source/runtime sample | 1,402 | Source-scoped, but includes general execution/style advice; review for transport-only instructions. |
| Linked local-bridge sample | 1,090 | Session-scoped, but repeats a full CLI command list; keep bridge state and discovery pointer. |

The baseline does not include variable Session instructions, active agreements, continuation text, source-message history, operator overrides, or dynamically listed connector actions. Their relevance and size must be reviewed in the scenarios that activate them.

## Implemented projection: 2026-09-23

The first pass replaced the selected long sections with a short natural-language handoff/Task cue and one comparable discovery entry per capability family. The rendered owner startup fell from 7,389 to 3,868 characters in the same instance. The unconditional per-turn pointer/delegation block was removed; only active local-bridge, agreement, and source context remains. Connector readiness and command details are fetched when the corresponding task needs them.

For owner-instance runs, the saved `manager_context` event contains all RemoteLab-supplied context slots for that run. The WebUI keeps the existing Markdown activity view and shows the complete saved body there, including visible `<private>` and `<hide>` blocks; deferred long bodies load into the same view. Historical run records keep their original text, and a retained provider thread may still carry its earlier startup context until a fresh thread is created. This is a RemoteLab-owned context audit, not an introspection of Harness-native instructions. Guest instances still do not persist this event. A new prompt change should verify both the assembled slot record and its WebUI display before claiming prompt visibility.

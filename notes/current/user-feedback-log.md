# Shared User Feedback Log

Status: active evidence log as of 2026-03-26

Companion operating note: `notes/current/product-mainline.md`

Directional synthesis: `notes/directional/product-vision.md`

## Purpose

- Keep product feedback visible to both human and AI collaborators.
- Preserve the signals that should change product judgment without storing raw private transcripts in the repo.
- Make it easy to see what repeated evidence already exists before starting new product discussions.

## Capture rules

- Log only sanitized product evidence.
- Prefer short entries with clear implications.
- Merge repeated evidence into existing themes when possible instead of duplicating near-identical entries.
- When a signal becomes stable product direction, promote it into `notes/directional/product-vision.md`, `README.md`, `README.zh.md`, or a current execution note.

## Current carried-forward signals

### 2026-09-04 — Automated tasks must not append control prompts to an existing conversation

- Source: direct owner feedback after a one-time WeChat reminder trigger inserted its internal execution instruction as a visible user message in the conversation where the reminder was created.
- User slice: mobile-first owner using long-lived conversations for ordinary work while also scheduling background tasks.
- Observed friction or ask: the scheduled task interrupted the original conversation and polluted its context. Every automatic task should execute in a separate new conversation by default; an existing conversation may be reused only when explicit continuity is the actual request.
- Signal strength: concrete production failure traced to `executionMode: existing_session` on a one-time trigger, compounded by CLI wording that described the source session as the target.
- Product implication: one-time triggers and recurring schedules both default to `fresh_session`, using the originating session only to seed folder/runtime/system-prompt context and any connector return route. Keep `--reuse-session` as an explicit legacy/continuity escape hatch, and regression-test that no trigger prompt or status event is appended to the source transcript.
- Follow-up: deterministic connector reminders should ultimately use a first-class `connector_action` rather than spending a model turn, but any interim AI-backed reminder must still run in an isolated session.

### 2026-09-01 — Keep hosted fleet administration outside the personal open-source core

- Source: direct owner review after discovering that the RemoteLab Admin dashboard and fleet commands now live in the main repository and are exposed under the main product route.
- User slice: product owner evaluating RemoteLab as both a personal open-source project and a possible hosted commercial product.
- Observed friction or ask: fleet users, trial instances, billing, host rollout, and instance lifecycle feel like a separate operator product; combining them with the personal workbench makes the open-source scope look overbuilt and suggests demand that ordinary single-owner users do not actually have.
- Signal strength: direct product-boundary correction grounded in a shipped surface, not a request to remove the existing internal operational capability immediately.
- Product implication: treat `/admin`, host/instance fleet control, trial allocation, and billing as an internal hosted-service plane rather than a headline RemoteLab feature. Keep the normal open-source install single-owner and lightweight; do not use admin infrastructure as evidence of end-user demand. Before further admin expansion, define a clear packaging boundary such as a default-off operator module, enterprise directory/package, or separate service/repository while preserving shared protocols where useful.
- Follow-up: decide the distribution boundary separately from the source-repository boundary, then remove fleet-admin language and dependencies from the default personal installation path unless a real hosted operation requires them.

### 2026-09-01 — Keep harness presentation provider-neutral

- Source: direct owner feedback after comparing Pi and Codex transcript behavior across two Pi progress-display experiments.
- Finding: Pi's “Planning”, “Validating”, and similar action phrases are provider `thinking/reasoning` events, not a hidden conversational progress stream. Pi emits ordinary assistant text only when the model deliberately writes it. The visible difference from Codex primarily reflects provider output style rather than a missing RemoteLab presentation path.
- Product implication: harness adapters should normalize native protocols into the shared event model; transcript projection should not branch on the originating harness. Keep reasoning, tools, routine status, intermediate assistant fragments, and intermediate usage in one default-collapsed Thinking row, followed by the final answer and one final usage summary.
- Implementation: both Pi-specific presentation experiments were removed. The protocol-level Pi adapter fix remains: completed streamed text/thinking blocks are captured early and authoritative `message_end` content is deduplicated.
- Follow-up: only revisit model-authored progress narration as an explicit cross-provider product feature, not as Pi-specific telemetry recovery.

### 2026-08-31 — connector failure notices must follow exhausted retry and capacity queues, not the first transient provider error

- Source: direct owner report after a WeChat bot repeatedly returned “reply generation failed” during ordinary conversation.
- User slice: mobile-first user treating WeChat as a primary conversational surface while the selected model account allows only one concurrent request.
- Observed friction or ask: accepted messages should wait for available capacity and recover from temporary provider overload; a generic failure notice should be a true last resort, not a frequent visible state. When the final provider reason is known, the user should see a safe, plain-language explanation such as concurrency full, temporary overload, exhausted balance/quota, invalid authorization, context too long, or timeout, plus the relevant next action. In the observed incident, Pi was still performing automatic retries, but RemoteLab terminalized the run on the first failed attempt, released the session early, sent the connector fallback within seconds, and allowed the next message to collide with the still-running retry loop.
- Signal strength: repeated production failures with a concrete lifecycle mismatch across connector queueing, runtime retry events, and provider-account concurrency.
- Product implication: treat provider attempts as non-terminal until the runtime emits its settled result, let thin connectors accept durable busy-session queue responses and wait on canonical reply publication, serialize known concurrency-one provider runtimes at the capacity boundary, and reserve failure copy for exhausted retryable recovery. Preserve the settled failure reason through reply publication, map known causes to localized and actionable user-safe copy, and use a generic notice only when no reason is available or classification is genuinely unknown. A connector-local inbound queue alone cannot solve account-level contention across sessions.
- Promote to: structured-runtime adapter contract, provider runtime capacity management, connector reply publication tests.
- Follow-up: monitor post-fix WeChat failure rates and distinguish retryable capacity/overload failures from terminal configuration or billing failures.

### 2026-08-30 — assistant-owned mail and user-owned Gmail need distinct sender semantics

- Source: direct owner review after an automated status email arrived from the user's connected Gmail account with a mojibake subject.
- User slice: owner delegating monitoring, reminders, and mailbox work while expecting the assistant to have a stable identity of its own.
- Observed friction or ask: agent-originated alerts should not impersonate the user or use the user's mailbox as a generic transport; Gmail should be reserved for reading, organizing, replying, or explicitly sending on the user's behalf. Non-ASCII subject corruption and visible `\n` escape text in place of body line breaks make even otherwise successful delivery unacceptable.
- Signal strength: concrete production delivery failure with a MIME correctness bug, an identity-routing policy gap, and an unsafe multi-line command pattern; a ready instance-owned mailbox already exists.
- Product implication: encode non-ASCII MIME headers according to RFC 2047, expose the ready Agent Mailbox in runtime connector context, default proactive/agent-originated mail to that identity, never silently fall back to user Gmail when agent-mail delivery fails, require an explicit `--as-user` acknowledgement for new Gmail sends, and require file/stdin body input whenever real line breaks are needed. Prompt policy alone is insufficient because already-running sessions and persisted schedule text can retain an older sender choice.
- Promote to: connector capability prompts, Gmail/raw-MIME tests, command-boundary sender acknowledgement, and sender-identity semantics for future outbound connectors.
- Follow-up: real Chinese-subject delivery was validated through the agent-owned sender as `rowan@…`; next, make outbound delivery audit metadata clearly identify the binding/account that acted across every connector path.

### 2026-08-11 — mailbox access must come from WebUI user OAuth, never a host CLI identity

- Source: direct owner correction after a Feishu mailbox-access query was answered from the machine's pinned `lark-cli` profile.
- User slice: a RemoteLab user connecting their own Feishu account and asking which mailboxes the current identity can access.
- Observed friction or ask: the product treated a host-configured CLI identity as though it were the current WebUI user's authorization. Mail access should instead require an explicit user SSO/OAuth flow exposed in WebUI.
- Signal strength: concrete identity-boundary and privacy failure in a live task.
- Product implication: add an instance-scoped Feishu Mail connector surface with authorize, callback, status, reauthorize, and revoke controls. Store and refresh user tokens inside that binding; enumerate accessible mailboxes only through the bound user token. If no binding exists, report authorization required and never fall back to a machine-global `lark-cli` identity. Shared/guest instances must not inherit the owner's Feishu mailbox token.
- Promote to: connector binding contract, Settings connector UI, Feishu Mail capability routing, system prompt capability declaration, and regression tests for missing-binding and cross-instance isolation.

### 2026-08-10 — shared Agent validation must start clean and preserve real review gates

- Source: direct owner review of a newly opened KOL workflow Agent.
- User slice: operator turning a proven internal workflow into a reusable Agent that other people can invoke independently.
- Observed friction or ask: the new Agent technically completed useful work, but it silently reused historical campaign assets and the automatic reply-completion review advanced past an explicit search-contract confirmation. This tested access to existing data rather than the intended end-to-end onboarding and decision flow.
- Signal strength: concrete live-session failure reproduced in tool history and the reply self-check timeline.
- Product implication: every new custom Agent session should default to an independent invocation. Stable instructions, skills, connector availability, and deliberately bundled template context may carry; prior sessions, task memory, historical business records, and local artifacts require explicit user scope. Named review gates are binding and must not be optimized away by automatic continuation. Agent creation should finish with a clean-room dry-run that receives only an explicit test packet and stops at the first real user checkpoint.
- Promote to: Agent prompt construction, reply self-check policy, Create Agent starter flow, shared-Agent regression tests.

### 2026-08-30 — multi-provider model controls need provider grouping and model-native reasoning choices

- Source: direct owner review after adding Kimi and GLM alongside OpenAI models in the live Pi runtime.
- User slice: mobile-first owner switching between several model providers and reasoning-capability shapes from the composer.
- Observed friction or ask: one provider-qualified model list becomes too long to scan, while a universal Thinking effort list falsely suggests every reasoning model supports the same levels. Adding more selectors can also crowd the narrow composer row.
- Signal strength: concrete live-catalog density and correctness issue with a bounded frontend/runtime-metadata fix.
- Product implication: split Pi selection into Provider then filtered Model, derive each model’s Thinking choices from provider metadata, expose every adjustable reasoning capability through one levels dropdown, represent on/off-only models as a two-level dropdown instead of a separate toggle contract, hide meaningless controls for fixed-thinking models, size selects from selected text, and keep the full control strip horizontally scrollable on mobile.
- Promote to: Pi model discovery, composer runtime controls, and mobile/static regression coverage.
- Follow-up: owner review on 2026-08-31 removed the separate toggle mode entirely; validate touch scrolling and native select sizing on iPhone, and only replace native selects with custom popovers if real-device behavior still feels cramped.

### 2026-08-30 — New Session should remain local until the first send

- Source: direct owner review of the normal New Session flow.
- User slice: mobile-first owner opening a fresh work thread, then sometimes leaving before writing anything.
- Observed friction or ask: clicking New Session immediately persisted an empty backend session. If the user abandoned that blank surface, the durable object had no useful destination except later archival.
- Signal strength: concrete product-model mismatch with a clear lifecycle boundary.
- Product implication: New Session should first open a local draft surface. Persist the session only when the first text or attachment is actually sent, while keeping runtime/Agent selection, shared-content drafts, and file attachments usable before materialization.
- Promote to: session lifecycle, composer send contract, and zero-session/new-session regression coverage.
- Follow-up: validate the local-draft-to-session transition on mobile and during reconnects so duplicate taps cannot materialize more than one session.

### 2026-08-30 — queued follow-ups should default to a count-only summary

- Source: direct owner review of the live chat queue surface.
- User slice: mobile-first owner steering a session while a prior run is still active.
- Observed friction or ask: queued message bodies can be long enough to cover the useful chat and composer area; most of the time the user only needs to know how many follow-ups are waiting.
- Signal strength: concrete UI-density issue with an immediate implementation path.
- Product implication: show queued work as a collapsed count-only row by default, let the user expand it on demand, preserve an explicit expansion during same-session refreshes, and keep expanded details scroll-bounded so they cannot take over the surface.
- Promote to: chat queue presentation defaults and frontend regression coverage.
- Follow-up: validate the collapsed row on narrow mobile screens and revisit whether individual queued items later need edit/remove controls.

### 2026-08-30 — Space and Project should be the only session-list hierarchy

- Source: direct owner review immediately after simplifying the live chat header and queue surface.
- User slice: mobile-first owner navigating many sessions across several durable contexts.
- Observed friction or ask: the Inbox/Projects sub-tabs add another choice without improving recovery; Space already separates broad contexts, and Projects already clusters the workstreams inside each Space.
- Signal strength: concrete information-architecture decision against a shipped surface.
- Product implication: remove the Inbox projection and its mode switch entirely. Always render the active Space as Project groups, while retaining attention signals only for ordering and compact status cues rather than as a competing hierarchy.
- Promote to: `notes/current/session-first-workflow-surfaces.md`, sidebar rendering defaults, and static frontend regression coverage.
- Follow-up: watch whether Project ordering alone surfaces waiting/running/unread work clearly enough without reintroducing a separate attention view.

### 2026-08-10 — shared instances need optional account-based session-list filtering, not RBAC

- Source: direct owner request for company teams sharing one RemoteLab process.
- User slice: an administrator plus several named coworkers using the same underlying runtime, files, tools, and connectors.
- Observed friction or ask: a shared session list becomes too large to scan; the administrator should see everything while each normal login sees only sessions tagged to that account.
- Signal strength: concrete product request with an intentionally narrow implementation boundary.
- Product implication: reuse the normal login route, add a default-off team session view and lightweight member accounts, stamp member-created sessions with a stable account ID/name, and filter the frontend catalog consistently across active sessions, search, source counts, and archives. Keep direct URLs and APIs shared; this feature is explicitly a display convenience, not authorization, tenancy, or data-security isolation.
- Promote to: login identity metadata, Settings account controls, session creation ownership, and frontend session-catalog tests.

### 2026-08-07 — live execution must override stale workflow labels

- Source: direct owner feedback after a session kept appearing under `Waiting on you` even though it had accepted the owner's reply and was actively running.
- User slice: mobile-first owner scanning the Project list to understand whether work is progressing or needs intervention.
- Observed friction or ask: the sidebar exposed a stale post-turn `waiting_user` label ahead of current run activity, so the user saw a request for attention without any actual input request in the conversation.
- Signal strength: concrete product-trust failure reproduced in live session metadata as `workflowState=waiting_user` plus `activity.run.state=running`.
- Product implication: accepting new user input must immediately clear prior workflow classification, and Project ordering/status cues must always let live busy activity override durable waiting, parked, or completed labels. Reclassify only after the new turn finishes.
- Promote to: session submission state transitions, Project attention ordering, and regression coverage for stale workflow labels.

### 2026-08-05 — default model upgrades must actively move stale user preferences

- Source: direct owner feedback after noticing RemoteLab kept using an older Codex GPT model even though newer product-default models were available.
- User slice: mobile-first owner/operator who expects RemoteLab to absorb model-choice maintenance instead of requiring manual picker audits.
- Observed friction or ask: updating the product default model was not enough because browser/local runtime selections and recent-model detection could continue pinning older GPT versions such as 5.4.
- Signal strength: concrete product trust issue in the runtime-selection layer.
- Product implication: runtime defaults should treat stale Codex model selections as upgradeable preferences, not durable user intent, unless a session is explicitly pinned for continuity. Browser localStorage, instance runtime-selection files, connector inheritance, guest defaults, and model-list default resolution should all converge to the current product default while retaining old models only as optional catalog entries.
- Promote to: runtime-selection defaults, connector inheritance tests, model catalog fallback tests.

### 2026-06-15 — remote SSH Codex workers should become a first-class execution target

- Source: direct owner architecture request while discussing RemoteLab as the control surface for distributed Codex work.
- User slice: owner/operator who wants to steer work from RemoteLab while execution may happen on one or many SSH-accessible machines.
- Observed friction or ask: the desired high-end shape is RemoteLab coordinating multiple SSH hosts, each running Codex workers for delegated tasks; the acceptable near-term shape is deploying RemoteLab on a single remote SSH host and letting it operate that host's local Codex.
- Signal strength: concrete product/architecture direction tied to existing multi-session orchestration and token-aware task splitting needs.
- Product implication: the current local-CLI run model should grow a worker/host execution abstraction. Remote host administration and guest-instance lifecycle are useful foundations, but they are not yet a complete remote Codex worker pool; the clean direction is a coordinator that dispatches bounded sessions/runs to registered worker hosts, tracks health/capabilities/load, and aggregates results through RemoteLab's normal session/run history rather than ad hoc SSH transcripts.
- Promote to: provider/runtime architecture, instance-factory/fleet admin roadmap, session dispatch design.
- Follow-up: define an MVP contract for one remote host first, then generalize to host registry, per-worker auth, workspace/artifact transfer, usage/compaction telemetry, and fan-out aggregation.

### 2026-08-05 — transcript scrolling must be one cross-device state machine

- Source: repeated direct owner feedback after mobile and desktop scroll fixes regressed each other.
- User slice: mobile-first owner reading and steering long, actively updating sessions from both phone and desktop.
- Observed friction or ask: the conversation repeatedly jumped back to older text while streaming or refreshing; device-specific patches made one surface better while destabilizing the other. A later review also found that opening a normal session at the absolute bottom skips the beginning of the latest AI answer the user still needs to read.
- Signal strength: recurring product-trust failure after several attempted fixes.
- Product implication: transcript position must have one shared owner with explicit user-intent modes: on session entry, wait for the canonical event render and anchor the top of the latest user message so the answer can be read downward; follow the bottom only while already following a live turn; preserve the same visible event while reading older content; restore an anchor across full timeline redraws; and never use page-level scroll corrections for keyboard movement. Browser native scroll anchoring and scattered direct `scrollTop` writes must not compete with that owner.
- Promote to: chat viewport controller, session-entry/redraw regression tests, mobile/desktop layout tests.
- Follow-up: keep full-transcript top entry for read-mode welcome/examples, and preserve the current viewport on background refreshes rather than reapplying the latest-turn anchor. A true top alignment near the end of a short historical transcript requires temporary trailing scroll room; the entry anchor must also remain authoritative through the first layout, resize, and mutation observer passes so they cannot immediately reclassify it as bottom-following.

### 2026-06-15 — reply self-check must count visible file delivery as turn completion

- Source: direct owner feedback after observing RemoteLab's background self-review on file-result turns.
- User slice: owner using RemoteLab to hand off work where the final deliverable is a generated file attachment rather than only chat text.
- Observed friction or ask: self-review could not see files the model had sent into the session, so a turn that had already delivered its result as an attachment could be judged unfinished and trigger unnecessary continuation.
- Signal strength: concrete product correctness issue in the turn-close loop.
- Product implication: completion review must use the same user-visible turn projection that includes result-file asset messages, not only the raw assistant text for the run.
- Promote to: reply self-check context contract, result-file asset regression tests, connector publication semantics.

### 2026-06-12 — Projects sorting should rebalance workstreams, not create one Project per session

- Source: direct owner product discussion while reviewing the Projects sidebar / Sort List behavior.
- User slice: owner using Chat UI sessions as the daily work-recovery surface.
- Observed friction or ask: a session-first system still needs controlled grouping granularity; if each conversation becomes its own Project, the Projects list loses meaning, but overly broad buckets also make later recovery hard.
- Signal strength: concrete owner instance sample showed 20 active Chat UI sessions spread across 17 Projects, including 16 singleton groups, while the current density budget is roughly 6 Projects.
- Product implication: per-session auto-labeling should be treated as provisional, while Sort List should run a full scoped rebalance over the active-session snapshot, merging related singleton feature slices, renaming compressed groups to clearer workstream topics, and splitting only genuinely distinct workstreams.
- Promote to: `notes/current/session-first-workflow-surfaces.md`, session label prompt, Sort List organizer prompt
- Follow-up: watch whether the next real Sort List run reduces singleton groups without collapsing unrelated KOL, RemoteLab, and growth work into one broad bucket; if autonomous sorting is added, gate it behind deterministic drift metrics, cooldowns, and explicit source scope rather than triggering after every new session.

### 2026-06-02 — automatic continuation replies should show both visible answer parts

- Source: direct owner feedback while using the background reply self-check / auto-continuation feature
- User slice: owner reviewing chat replies on mobile after self-check triggers a follow-up turn
- Observed friction or ask: when self-check decides the assistant stopped too early and launches an automatic continuation, the earlier visible assistant reply was folded into a hidden thought block even though the user needs the original reply plus the continuation to understand the final answer
- Signal strength: concrete repeated review behavior; self-check hit rate is rising and the user now routinely expands the previous folded message to recover the full conclusion
- Product implication: visible transcript projection should treat the original already-shown assistant message and the auto-continuation repair message as two user-facing parts of one final answer; hidden execution work can remain collapsed, but answer content should not be hidden by default
- Promote to: reply self-check display contract, session visible timeline regression tests, connector publication semantics
- Follow-up: keep this as a projection/cache-compatible behavior rather than a broad API contract change unless future surfaces need explicit response-part metadata

### 2026-05-28 — threaded chat surfaces should map topics to isolated AI sessions

- Source: direct owner product discussion while extending Feishu topic-group support.
- User slice: mobile-first owner/operator using IM connectors as a serious ongoing AI work surface.
- Observed friction or ask: a normal conversation group should keep the existing shared-session behavior, but a topic group should treat each topic as an independent discussion so unrelated work does not contaminate context.
- Signal strength: concrete connector behavior request with immediate implementation path in Feishu.
- Product implication: threaded external surfaces should make the group/channel the long-lived entry point and the topic/thread the session boundary; connector routing keys should prefer channel plus topic/thread identifiers when available.
- Promote to: connector routing defaults, Feishu/Lark connector tests, future threaded connector protocol

### 2026-05-25 — message timestamps need full date context

- Source: direct owner UI request while using the RemoteLab chat transcript
- User slice: mobile-first owner reading session history from the chat surface
- Observed friction or ask: per-message timestamps showed time-of-day but not the date, making older or cross-day conversation history feel incomplete
- Signal strength: concrete in-product readability issue with a low-risk UI fix
- Product implication: transcript metadata should show complete local date and time wherever message-level timing is already exposed
- Promote to: chat transcript timestamp defaults and frontend smoke coverage

### 2026-04-11 — discussion continuity should outrank session routing until dispatch is trustworthy

- Source: direct product discussion after active design/debug threads were routed into unrelated historical sessions, disrupting the conversation enough that runtime dispatch was temporarily turned off.
- User slice: mobile-first owner/operator using RemoteLab as a live working discussion surface, not as a demo of orchestration.
- Observed friction or ask: if dispatch cannot reliably recognize "this is clearly continuing the current thread," then routing feels random and makes the product harder to use than simply staying in one session. Users also want send acceptance and routing checks to be visibly distinct instead of hidden behind a slow `sending` state.
- Signal: session continuity should dominate dispatch policy. Routing must be conservative, transcript-aware, and visibly post-accept rather than a hidden pre-send stall. Dispatch should remain off until those conditions are good enough in real discussion.
- Product implication: move toward a single pre-turn planner that sees full current-thread context, defaults to staying in the current session on weak evidence, and restores dispatch only behind clear continuity-first gates.
- Promote to: `notes/current/session-dispatch-and-direct-delivery-followups.md`, `notes/current/session-dispatch-architecture.md`
- Follow-up: keep runtime dispatch off for live discussion, treat accepted-to-checking as the correct UX direction, and reopen routing only after transcript-aware validation is in place

### 2026-04-11 — thin connectors still fail if the main instance lacks a first-class source-channel delivery contract

- Source: direct debugging after a WeChat reminder appeared in the RemoteLab session but never reached WeChat, followed by a separate owner-poller outage.
- User slice: mobile-first owner/operator using WeChat as a serious primary ingress, not a toy connector.
- Observed friction or ask: if reminder / push delivery requires connector-local code or agent-written shell logic, then the promised "thin connector, main instance owns policy" boundary is not actually real. Missing fast acknowledgements and dead pollers are experienced as product failure, not connector trivia.
- Signal: RemoteLab needs a main-instance-owned source-channel delivery primitive plus repo-owned connector lifecycle/health management; otherwise thin connectors become an aspiration rather than a stable architecture boundary.
- Product implication: separate connector transport from outbound policy explicitly, move owner connector lifecycle out of ad hoc local scripts, and treat source-channel reminders as a first-class control-plane capability rather than a session-message workaround.
- Promote to: `notes/current/wechat-connector-followups.md`, trigger/delivery control-plane work, connector lifecycle management
- Follow-up: keep the current machine-local direct-send + watchdog stopgaps, but land a repo-owned source-channel delivery contract before treating the connector architecture as stable

### 2026-04-11 — stable connector bugs should trigger a shared contract fix, not a remember-later patch

- Source: direct product discussion after finding that WeChat and other thin connectors can publish the first completed run before reply self-check / automatic continuation has finalized the real user-visible answer.
- User slice: mobile-first owner/operator using RemoteLab as the main long-lived execution product and explicitly optimizing for future reliability over short-term patch speed.
- Observed friction or ask: when a bug appears on a stable architecture boundary, a local fix feels deceptively done but creates future memory debt; the operator may not remember the hidden edge case later, especially when they are not reading code day to day.
- Signal: for mature shared surfaces such as connectors, the default should be to define the missing shared contract now instead of patching one path and trusting future recollection. In this case, reply delivery needs a first-class response/publication lifecycle rather than more per-connector polling heuristics.
- Product implication: connector reply publication should become a shared server-side contract with stable response identity, finalization state, and canonical outbound payload, and thin connectors should consume that helper/API instead of reasoning from raw run completion.
- Promote to: `notes/current/connector-reply-publication-architecture.md`, `notes/current/connector-state-surface.md`, connector protocol and helper design
- Follow-up: implement the shared response-publication surface before adding more thin reply connectors or deepening the callback protocol

### 2026-04-09 — user-local computer access should start as a scoped device bridge, not ambient full-PC control

- Source: direct product discussion while evaluating long-term Revit Live workflow requirements.
- User slice: owner/operator exploring whether cloud-executed workflows need a path into the end user's own workstation for file-heavy desktop software flows.
- Observed friction or ask: cloud-side execution is convenient, but some valuable workflows still depend on artifacts or apps that live on the user's own computer; the tempting framing is "let the system just operate the user's computer and find what it needs," so the user does less manual handoff.
- Signal: this should not become a generic promise of ambient local-computer control. The cleaner product shape is an instance- or workspace-bound local device bridge with explicit capability grants such as folder access, file discovery inside approved paths, background sync/watch, and app-specific local actions. Full arbitrary desktop control is a much heavier trust, security, and support commitment.
- Product implication: if RemoteLab or a derivative product adds user-local execution, separate the shared substrate from domain adapters. The shared layer should own device registration, authorization, transport, audit, and capability gating; domain layers such as Revit can then add specific local actions on top. Product wording should describe explicit local access grants rather than implying unrestricted access to "your computer."
- Promote to: future device-binding / local-bridge architecture note, user-facing authorization wording, Revit Live capability planning
- Follow-up: validate whether the first valuable local capabilities are file/folder grants and app-specific export/open hooks rather than screen/keyboard remote control; only consider broader desktop control if repeated user evidence clearly demands it

### 2026-04-06 — settings should default to self-explanatory controls, not explanatory copy

- Source: direct product feedback while reviewing the owner settings surface.
- User slice: mobile-first owner/operator refining the mainstream product UX.
- Observed friction or ask: the settings area currently spends too much space on explanatory notes and status sentences for simple toggles/selects; users can usually understand the control from the option labels themselves, and the extra copy becomes skimmable noise rather than helpful guidance.
- Signal: for low-risk preferences, Settings should bias toward compact controls with self-explanatory option labels. Persistent explanatory paragraphs and "current status" restatements should be removed unless they prevent a real misunderstanding.
- Product implication: shrink settings surfaces to title + control + exception-only feedback, and move nuance into the option labels or into just-in-time error/help states instead of always-visible prose.
- Promote to: sidebar/settings UX defaults, copy standards for low-risk preference panels
- Follow-up: keep auditing settings-like panels for intro text that merely repeats what the control already says

### 2026-04-06 — low-entropy mobile tasks need a fast-response lane distinct from full-agent orchestration

- Source: direct product discussion using everyday plant logging as a concrete example.
- User slice: mobile-first users with frequent lightweight capture, identification, and journaling tasks.
- Observed friction or ask: for simple tasks, the current full-agent path can spend too much time on context recovery, routing, memory activation, and orchestration before producing a useful reply; this makes RemoteLab feel slower than the value of the task warrants.
- Signal: RemoteLab should support a low-latency quick-response lane for simple, low-risk tasks, while keeping the stronger full-agent path for ambiguous or execution-heavy work. The important distinction is not "weaker model vs stronger model" but "smaller orchestration/context budget vs full orchestration/context budget."
- Product implication: represent this as an execution/profile concept that can control context depth, routing/delegation allowance, and model reasoning defaults. Avoid treating "shorter prompt only" as the solution; the product needs a real fast path. Preserve one-tap or automatic escalation from quick to full when the task outgrows the lightweight lane.
- Promote to: app/profile design, runtime-selection defaults, memory-activation gates, and quick-to-deep escalation UX
- Follow-up: define a concrete quick-mode latency target and test whether faster first response plus optional escalation improves simple-task satisfaction without hiding needed depth

### 2026-04-06 — external actions must be instance-bound, not host-owner-local

- Source: direct product discussion about schedule writing, reminders, notifications, and Feishu delivery in the new multi-instance/guest-instance shape.
- User slice: owner/operator refining RemoteLab from a single-owner machine tool into a cleaner user-facing multi-instance execution surface.
- Observed friction or ask: RemoteLab can already perform host-side actions such as creating reminders or sending outbound messages, but the effect may still resolve through the operator's own local calendar, mailbox, or Feishu context; that makes the system appear more capable for end users than it really is, because the action does not land in the instance user's world.
- Signal: external writes should use shared connectors with instance-scoped account bindings, scopes, and delivery identities. The host machine is the execution substrate, not the semantic owner of the user's external apps. "Can the machine do it?" and "will it take effect for this user?" must be treated as separate states.
- Product implication: freeze product wording and implementation direction around connector/binding semantics, require explicit per-instance authorization before user-facing side effects, and keep host-local app integrations as owner-only compatibility paths rather than the default product promise.
- Promote to: `notes/current/instance-scoped-connectors.md`, `notes/current/knowledge-layers-and-connectors.md`, future connector/auth/binding UX
- Follow-up: define the minimum binding registry and trigger-side binding resolution path before adding more calendar / reminder / IM write features

### 2026-04-06 — missing context should prefer user-provided entry points over machine-wide search

- Source: direct product feedback after repeated macOS privacy popups were traced to RemoteLab/Codex workers running broad home-directory discovery commands.
- User slice: owner/operator on macOS using RemoteLab as a long-lived personal workbench with growing private machine state.
- Observed friction or ask: when memory does not surface the needed context, agents still fall back to recursive filesystem discovery, sometimes across the whole home directory; this creates low-value latency, violates the intended "the machine is the agent's workspace" mental model, and on macOS can trigger repeated "access data from other apps" privacy prompts by touching container paths.
- Signal: missing context should default to a user-facing request for a concrete entry point such as a project name, path, file, or link. Broad local search is the wrong default recovery mechanism; memory, continuity, and known project pointers should carry most routing, and targeted discovery should happen only after a real lead exists.
- Product implication: strengthen startup/runtime prompts and search-policy injections so "ask for the pointer" is the default branch after memory misses, and treat machine-wide search as exceptional rather than normal.
- Promote to: startup/runtime prompt assets, search-policy injection, future scope-routing UX
- Follow-up: watch future sessions for whether agents still reach for recursive search when scope pointers are absent, and whether product surfaces can expose better explicit project pickers to reduce ambiguity further

### 2026-03-31 — non-expert users need agent-side execution, not manual recipes

- Source: direct product feedback while reviewing a negative trial case with a non-programmer user.
- User slice: remote/mobile trial users who can judge outcomes but are not comfortable acting like the operator of the machine.
- Observed friction or ask: even when the host agent could keep going, replies still sometimes drift into implicit how-to mode and offload setup, host-side chores, or external-access steps back onto the user; this makes the product feel like it is asking the user to operate the system manually.
- Signal: RemoteLab's product advantage is that the AI has its own execution machine and should absorb the work there by default; when another service needs access, login, or authorization, the preferred pattern is a RemoteLab-side checkpoint that keeps later steps automated here rather than a long recipe on the user's own device.
- Product implication: strengthen startup/runtime prompts and onboarding copy so the default is server-side execution, RemoteLab-side auth capture when appropriate, and the smallest possible human checkpoint only when unavoidable.
- Promote to: startup/runtime prompt assets, welcome/onboarding copy, future auth/access UX
- Follow-up: watch future trials for whether replies still produce multi-step manual instructions and whether auth capture can move from wording alone into clearer product surfaces

### 2026-03-31 — mainland ingress should be prefix-only and must not repoint established paths silently

- Source: direct product feedback after a mainland natapp routing change caused confusion between ingress behavior and Codex/provider auth failures.
- User slice: owner/operator using mainland ingress for both the main service and long-lived guest/trial surfaces.
- Observed friction or ask: mixing root aliases with prefixed paths makes the access model inconsistent, obscures which runtime the user is entering, and turns provider-auth failures into ambiguous “the tunnel broke / Codex login dropped” incidents when a familiar URL silently starts targeting a different service.
- Signal: mainland ingress should use one explicit rule everywhere — `domain/{name}/...` for every product surface, including the main owner service — while the bare root stays only as a neutral directory or recovery surface.
- Product implication: remove root-path product aliases, treat the main service as just another named mainland prefix, prefer live launch-agent port data over stale registry records, and clean docs/operator wording so mainland access is always described in the same prefix-first model.
- Promote to: `docs/mainland-routing.md`, `README.md`, `README.zh.md`, mainland routing implementation and diagnostics
- Follow-up: keep auditing mainland-related docs and commands for root-alias language; later surface the named main-service mainland URL in status or ops views instead of relying on remembered conventions

### 2026-03-29 — mobile install should steer users into a real browser and reconnect the first standalone launch

- Source: direct product feedback while testing phone entry and home-screen install behavior
- User slice: mobile-first owner opening RemoteLab from a tokenized link
- Observed friction or ask: opening the token link inside a browser works, but adding RemoteLab to the home screen drops the login state and forces the user to paste credentials again; in-app browsers such as WeChat make the flow even worse; notification prompts also feel too early.
- Signal: mobile entry should default to a lightweight install-oriented onboarding flow that blocks only true in-app browsers, keeps iPhone browser acceptance relatively loose, reconnects the first standalone launch with a one-time handoff, and delays notification permission until after install succeeds.
- Product implication: add a dedicated mobile install guide, one-time install handoff / bridge mechanics, a browser skip path, and later notification timing instead of assuming browser and standalone storage share login state.
- Promote to: mobile onboarding implementation, install-handoff regression tests, future first-value notification timing
- Follow-up: once the install loop is stable, move notification permission from “first standalone launch” to a clearer first-value moment inside the product

### 2026-03-29 — capability accumulation should happen through selective post-task review, not prompt bloat inside the work step

- Source: direct product discussion about how RemoteLab should get better through repeated use, with drawing/image-generation used as a concrete example
- User slice: owner/operator shaping the product's long-term learning loop rather than a one-off prompt tweak
- Observed friction or ask: if the system solves a generally reusable problem, it should learn a reusable strategy from that success; stuffing more standing instructions directly into the drawing/generation prompt feels like the wrong mechanism because it diffuses model attention, is easy to forget, and mixes execution with abstraction.
- Signal: reusable capability accumulation should primarily happen in a bounded post-task or post-turn review layer that decides whether a strong-signal lesson is worth abstracting into durable memory, a workflow pattern, or a reusable skill candidate; execution-time prompts should stay focused on the immediate job.
- Product implication: keep the generation step narrow and task-focused; let end-of-turn review handle “did we learn a reusable pattern?”, “is this durable or just case-specific?”, and “where should it live?”; prefer selective promotion with validation over automatic prompt accretion.
- Promote to: `notes/current/model-autonomy-control-loop.md`, `notes/current/model-sovereign-control-architecture.md`, `notes/current/knowledge-layers-and-connectors.md`
- Follow-up: when the control loop grows beyond reply self-check and task-card refresh, add a small promotion candidate path that can classify a lesson as session continuity, private user memory, shared domain pattern, or reusable skill draft without auto-promoting weak or transient observations.

### 2026-03-31 — keep reusable workflow assets local-first; drop external provider and cloud skill paths for now

- Source: direct product decision after reviewing the hackathon-driven external-provider experiment against the simpler long-term product direction.
- User slice: owner/operator simplifying RemoteLab's reusable workflow model after early experimentation.
- Observed friction or ask: a temporary third-party domain-provider path and any future-looking skill upload/pull flow add surface area, auth shape, and architectural drift before local skill reuse is actually saturated.
- Signal: the near-term product should keep reusable workflow assets local on the machine: skills, prompts, scripts, checklists, and domain notes that can be discovered and reused without cloud packaging or third-party dependency.
- Product implication: remove experimental external-provider code and docs, keep skill abstraction local-first, and postpone any cloud pull/upload path until a real product need survives repeated local use.
- Promote to: `notes/current/knowledge-layers-and-connectors.md`, `notes/current/product-mainline.md`, `README.md`, `README.zh.md`, repo-local AI context
- Follow-up: keep validating whether local skill reuse plus explicit curation is enough before reopening any distribution or external-dependency design

### 2026-03-28 — separate knowledge layers from shared capability connectors even in the single-machine phase

- Source: direct product architecture discussion about domain reuse, user-private memory, and early connector strategy
- User slice: owner/operator defining the next reusable abstraction layer for RemoteLab itself
- Observed friction or ask: the team needs a simpler product frame for reusable assets without prematurely over-designing migration, marketplace packaging, or a full hosted account system; shared capabilities, domain knowledge, and user-private context were at risk of being mixed into one layer.
- Signal: the early architecture should separate a shared base agent, a retrievable shared domain layer, and a private user layer, while treating email/calendar/IM/docs-style integrations as a separate common connector surface with per-user configuration and permissions.
- Product implication: keep the first version simple — one reusable toolchain, a clean on-disk location for domain assets, private user context by default, and no automatic promotion of private case material into shared knowledge.
- Promote to: `notes/current/knowledge-layers-and-connectors.md`, `notes/directional/product-vision.md`, `notes/current/product-mainline.md`
- Follow-up: define the minimum retrieval path for domain packs and the minimum connector/auth shape without committing yet to a full marketplace or migration platform

### 2026-03-27 — background turn-completion checks should stay collapsed by default

- Source: direct product feedback during mobile transcript review
- User slice: mobile-first owner reading a live session transcript
- Observed friction or ask: visible `Assistant self-check` / automatic continuation cards expose internal turn-completion logic that most users cannot act on and do not care about; the exposed check feels louder than the actual decision it represents.
- Signal: background review that only decides whether the assistant can stop or continue should default to collapsed, low-emphasis disclosure rather than full inline explanation.
- Product implication: group reply self-check and automatic continuation artifacts into a subtle collapsed drawer by default so the transcript stays focused on user-visible work while still preserving inspectability.
- Promote to: transcript UI defaults, internal-vs-user-facing disclosure guidelines
- Follow-up: watch whether other internal housekeeping states should use the same collapsed pattern or remain explicit

### 2026-03-27 — mobile session entry must stay persistent, not hint-dependent

- Source: direct product feedback during phone-first chat-shell review, refined by a later live-header review on 2026-08-30.
- User slice: mobile-first owner using RemoteLab without product-specific habits yet.
- Observed friction or ask: the left header entry for sessions/sidebar was initially too easy to miss, but once the standard three-line menu icon was persistent, the added `Sessions` label and heavy accent treatment became redundant. `Fork` adds clutter; the standard Share icon also does not need a visible text label. Run state remains useful and reads more naturally immediately before Share.
- Signal: important mobile navigation cannot depend on onboarding hints or hidden gestures, but familiar persistent shell icons should not carry explanatory text merely to look discoverable.
- Product implication: keep the menu entry always visible as an icon-only accessible button, remove `Fork` from the top bar, keep Share icon-only with an accessible label, and place the current running/idle state directly before Share.
- Promote to: mobile header defaults, session navigation UX review.
- Follow-up: validate that the lighter icon-only treatment remains discoverable for first-time users without reintroducing permanent explanatory copy.

### 2026-03-26 — shrink product concepts before refactoring deeper

- Source: direct product strategy discussion after parallel architecture review
- User slice: owner/operator using RemoteLab as a single-owner AI workbench
- Observed friction or ask: `App`, `User`, and interactive `Visitor` concepts add conceptual and implementation weight without enough real pull, while `Welcome` as an App feels artificial compared with a normal seeded session
- Signal: the near-term product should contract toward owner sessions, runs, and read-only share snapshots; onboarding should use a normal session or injected first assistant message, not a special App object
- Product implication: remove app/user CRUD, filters, visitor entry flow, and welcome-app framing before deeper backend/frontend refactor so later cleanup targets a smaller and clearer product truth
- Promote to: `notes/current/product-mainline.md`, `notes/current/session-first-product-contraction.md`, `notes/current/core-domain-refactor-todo.md`
- Follow-up: first removal wave should target sidebar filters/settings, app/user routes, visitor entry flow, and welcome bootstrap

### 2026-03-26 — attachment entry should use clear upload wording, not icon-only affordance

- Source: direct product feedback during chat-composer review
- User slice: mobile-first owner using the default chat input without prior RemoteLab habits
- Observed friction or ask: an icon-only attachment control is easy to miss or misread; users may not infer that it is the file upload entry point
- Signal: attachment entry should be placed early in the composer control row and use explicit upload wording instead of relying on icon recognition alone
- Product implication: mainstream intake flows should prefer clear labeled actions over compact icon-only affordances for important first-step actions like uploading examples or source files
- Promote to: composer UX defaults, future intake/onboarding review

### 2026-03-26 — abstract welcome needs concrete showcase examples

- Source: direct product discussion after reviewing fresh-instance onboarding
- User slice: first-time owner opening a newly created RemoteLab instance on mobile
- Observed friction or ask: a pure conversational welcome is still too abstract; users need to see a few concrete finished cases before they understand what they can hand off
- Signal: new instances should not rely only on generic intake copy; onboarding should expose 3–5 example workflows with visible outcomes, such as a scheduled news digest emailed to the user, an uploaded Excel file cleaned and returned as a result file, or an incoming email that opens a new processing session automatically
- Product implication: Welcome should teach capability through clearly labeled example sessions that let users read a believable end-to-end flow — the starting ask, intermediate handling, and final deliverable — so they learn how to use the product by following a real transcript rather than by interpreting abstract capability cards
- Promote to: `notes/directional/product-vision.md`, welcome/onboarding implementation
- Follow-up: seed fresh instances with 3–5 pinned showcase sessions; if lightweight visual entry points are still useful, keep them as simple labeled launchers into those example transcripts rather than as self-contained explanatory cards; keep the first canonical scripts in `notes/directional/product-vision.md`

### 2026-03-26 — new instances need an auto-open welcome session, not an empty chat shell

- Source: direct user feedback while testing a fresh trial instance
- User slice: first-time owner opening a newly created RemoteLab instance on mobile
- Observed friction or ask: landing on an empty session list (or a stray blank default chat) gives no guidance and makes the product feel broken instead of guided
- Signal: new instances should auto-create the built-in Welcome session and open it by default; zero-active-session owner states should prefer guided recovery over an empty shell
- Implication: server-side bootstrap should guarantee an active Welcome session for owner-first entry, and onboarding must be resilient to legacy blank archived sessions
- Promote to: onboarding implementation, welcome-session regression tests

### 2026-03-26 — showcase demos should combine real workflow value and explain mail gating up front

- Source: direct onboarding feedback after reviewing seeded starter sessions
- User slice: first-time owner trying to infer what RemoteLab can reliably automate from example transcripts
- Observed friction or ask: separate one-capability demos understate value; a stronger showcase combines content collection/summarization with delivery, and the inbound-email affordance currently hides the allowlist prerequisite
- Signal: starter examples should prefer believable end-to-end flows such as “summarize current industry signals and send the digest to a target inbox” instead of showcasing isolated primitives; any mail-to-instance affordance should warn users to register their sender address before testing so the first attempt does not get silently filtered
- Product implication: onboarding examples should teach compound outcome-oriented workflows, while Welcome should surface the sender-allowlist safety gate in plain language before users try inbound email
- Promote to: welcome/bootstrap copy, starter-session design, email-onboarding defaults

### 2026-03-25 — mainstream automation framing beats orchestration-first framing

- Source: synthesis of recent user interviews and product review
- User slice: early high-fit non-technical operators and coordinators
- Signal: users respond more strongly to "hand repetitive digital work to AI" than to orchestration or session jargon
- Implication: keep multi-session and context carry as enabling-capability language, not the first-sentence product promise
- Promoted to: `README.md`, `README.zh.md`, `notes/directional/product-vision.md`

### 2026-03-25 — early high-fit users are time-pressed coordinators with digital admin work

- Source: recent interview summary
- User slice: traditional-industry middle managers and small owner-operators
- Signal: the best early users already delegate to people, still carry digital admin overhead themselves, and care sharply about saved time
- Implication: onboarding and examples should center on repetitive information work, not AI-native power-user language
- Promoted to: `notes/directional/product-vision.md`

### 2026-03-25 — first trusted automation win matters more than capability breadth

- Source: product-direction reset and interview synthesis
- User slice: mainstream guided-automation users
- Signal: people need a fast, concrete automation win before advanced workflow organization matters
- Implication: prioritize intake, welcome flow, review, delivery, and a trusted first outcome over showcasing orchestration depth
- Promoted to: `notes/directional/product-vision.md`, `notes/current/product-mainline.md`

### 2026-07-12 — session organization should be AI-owned, compact, and Space-based

- Source: direct owner review of the live mobile session sidebar
- User slice: mobile-first owner with hundreds of long-lived and temporary sessions
- Observed friction or ask: colorful status dots on every row create visual noise; only active execution and completed-but-unread results deserve row-level indicators. Manual sorting is also the wrong ownership model: AI should assign durable Spaces and Projects while temporary sessions remain explicitly loose.
- Signal strength: direct review after implementing and visually testing a denser two-line session row
- Product implication: keep session rows compact and mostly monochrome; retain dots only for running and completed-unread states; use an AI-managed Space switcher above Project groups with no manual classification controls
- Promote to: session naming/grouping metadata, sidebar information architecture, automatic project maintenance
- Follow-up: backfill existing Chat UI sessions into a small set of Spaces, then tune Space labels and cardinality from real use rather than fixed rules

### 2026-08-06 — connector replies should carry AI-generated files back to the source conversation

- Source: direct owner request followed by a live Feishu private-chat validation
- User slice: owner using Feishu as the intake and delivery surface for RemoteLab work
- Observed friction or ask: files listed under RemoteLab `Attached files` stayed available only in the web session; the corresponding Feishu conversation should receive those files through the platform API without requiring the agent to improvise a second sending workflow
- Signal strength: end-to-end validation succeeded with one generated text attachment, one body message, one native Feishu file message, and explicit user confirmation that the result looked correct
- Product implication: reply-publication attachments should remain the canonical cross-surface artifact contract, while each Connector transport owns native upload, rendering, limits, and idempotent multipart delivery
- Promote to: external message protocol, Connector capability contract, future media-capable Connector implementations
- Follow-up: validate group/topic and multi-file delivery during normal use; reuse the same publication-to-transport pattern for other Connectors instead of adding source-specific artifact logic to agents

### 2026-08-06 — project headers should avoid overlapping count badges

- Source: direct owner review of the live mobile Projects sidebar
- User slice: mobile-first owner scanning grouped sessions in a narrow sidebar
- Observed friction or ask: showing both a highlighted attention count and the project session total creates redundant visual weight; the extra highlighted number does not add enough value to justify another badge
- Signal strength: direct screenshot-based review of the shipped surface
- Product implication: keep project headers to one neutral total count; attention may still influence project ordering, but should not add a second numeric badge unless later evidence shows a clear decision-making need
- Promote to: sidebar information density and status-display defaults

### 2026-08-25 — Space and Project classification must be account-local

- Source: direct owner correction after reviewing a live multi-account session-list rebalance
- User slice: administrator of a shared RemoteLab instance where each account represents a different person and work view
- Observed friction or ask: a global organizer treated every account as if it should share one Space/Project taxonomy, overwriting classifications that belong to other people
- Signal strength: direct correction backed by live session metadata showing several distinct account-owned catalogs
- Product implication: namespace visible grouping and sidebar order by account; filter Space lists, label catalogs, manual sorting, and automatic maintenance to exactly one account before deriving or patching metadata; an all-account admin view must never become a cross-account rebalance scope
- Promote to: `notes/current/session-first-workflow-surfaces.md`, session organizer and label-context tests
- Follow-up: keep broader account authorization/security changes separate; this correction establishes classification and model-context isolation regardless of the current access-control model

### 2026-09-03 — inbound mentions should commit business changes without chat polling

- Source: direct owner review of an active creator-supply Campaign update
- User slice: internal teams that give an agent operational instructions from several Feishu conversations
- Observed friction or ask: an explicit mention already wakes the agent, so chat-specific polling and group whitelists add machinery without improving discovery; the real gap is reliably attributing the sender and committing the resulting business delta
- Signal strength: direct workflow correction backed by a prior weekly-target message that affected execution but left stale projections and incomplete audit state
- Product implication: Connector source context should expose stable message revision and sender identity, including internal-tenant classification when verifiable; the domain workflow should own classification, idempotent authority writes, read-back, projection repair, and the source-thread receipt
- Promote to: Feishu source-context contract and domain-specific Campaign change ledgers
- Follow-up: validate the next naturally occurring edited message and durable Search Contract change end to end

## Entry template

### 2026-05-25 — large audio attachment send should not be tied to message submission

- Source: live trial8 user report while sending an audio-file request from mobile chat
- User slice: mobile-first owner using chat as the primary intake surface
- Observed friction or ask: after tapping send with an audio attachment, the composer stayed in sending state and then failed, leaving the draft in the input
- Signal strength: concrete failed workflow with server evidence; two `/messages` uploads stayed open for about five minutes and ended as aborted requests
- Product implication: non-storage installs still need direct local attachment upload before message submission so large media files do not hold the whole message request open
- Promote to: composer attachment upload reliability and local file-asset defaults
- Follow-up: consider visible upload progress and clearer failure copy for slow or interrupted mobile uploads

### YYYY-MM-DD — short title

- Source:
- User slice:
- Recurring work:
- Observed friction or ask:
- Signal strength:
- Product implication:
- Promote to:
- Follow-up:

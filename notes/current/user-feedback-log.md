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

### 2026-03-27 — mobile session entry must be visually primary, not hint-dependent

- Source: direct product feedback during phone-first chat-shell review
- User slice: mobile-first owner using RemoteLab without product-specific habits yet
- Observed friction or ask: the left header entry for sessions/sidebar is too easy to miss; if users skip or forget a hint, they may not understand how to switch sessions. `Fork` adds clutter while `Share` can stay only as a lighter secondary action.
- Signal: important mobile navigation cannot depend on onboarding hints or hidden gestures; the persistent UI itself must make the session entry feel obviously tappable and primary.
- Product implication: make the left header sessions control visually heavy, remove `Fork` from the top bar, and keep `Share` as a lighter secondary button that still reinforces icon clickability.
- Promote to: mobile header defaults, session navigation UX review
- Follow-up: watch whether stronger primary navigation reduces missed-sidebar confusion without requiring extra coaching copy

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

## Entry template

### YYYY-MM-DD — short title

- Source:
- User slice:
- Recurring work:
- Observed friction or ask:
- Signal strength:
- Product implication:
- Promote to:
- Follow-up:

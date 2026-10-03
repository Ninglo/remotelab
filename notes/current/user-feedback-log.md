# Shared User Feedback Log

### 2026-10-03 — Organize automations without reducing retained information

- User goal: see one business automation, fold its repeated records by calendar date, and switch directly between regular, one-time and stopped work. Completed one-time work must remain discoverable as one-time work.
- Presentation: fold purpose sections for reviews, checks, reports, reminders and other work. Show the recorded initiator, source Session and result destination alongside cadence and actual execution totals. Preserve full instructions, all historical child definitions, configuration, controls, errors, identifiers and log links inside the appropriate details.
- Evidence boundary: purpose and calendar grouping are read-only views. Partial history pages label loaded record counts; check totals remain separate from AI executions. Missing attribution stays unrecorded. Never apply producer actions to a synthetic group or feed grouped IDs into monitoring.
- Verification: isolated categorization/history and monitoring regressions plus real desktop/mobile rendering. Browsing must issue no mutations; deployment must retain native producer definitions and alert policy.

### 2026-10-03 — Verify the complete Feishu reply flow

- Observed friction: a short question required several minutes of investigation but received a fixed creation notice, two separate progress posts and a final post, with no task card.
- Cause: a message-only Jev decision suppressed task-card guidance before the executing Harness knew the actual work. Prior acceptance verified updates of existing cards, not the new-task flow.
- Change: the opted-in Harness decides cards from actual work; merge the Session entry into its useful opening; keep ordinary progress on the original card and distinguish questions/final replies. Do not create a late card after the final reply.
- Evidence boundary: API patch success is not full client experience acceptance. Verify message order, card identity, scope and content; retain live acceptance as pending until an actual new task is observed.

### 2026-10-03 — Resource monitoring and routine reports

- Source: direct operator feedback after separate account, disk, skill and project notifications accumulated.
- Ask: monitoring should first show urgent interruptions and capacity that can support useful work. Retain Settings and familiar automation controls; add Overview above Automations under Monitoring. Project tasks and daily reports belong in local Markdown and existing report publication, without separate UI entries.
- Delivery implication: put routine monitoring into the existing daily report. A new dashboard, image or Base is optional presentation, not another required information source. Only urgent new incidents warrant separate group notifications; batch related events and preserve delivery receipts.
- Evidence boundary: a full allowance does not prove waste, unknown reads do not prove health, and fixed test requests are not project output. Scope observations to connected sources. The earlier dedicated Base remains historical and is no longer the daily output contract.

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

### 2026-10-03 — Resume monitoring safely after an automation source change

- Observed friction: changing the automation task source led to continued alerts, so the independent resource observer was stopped. The user wants the original important-task coverage retained and reliable observation restored.
- Change: retain native task IDs and the existing delivery destination; require positive recovery evidence before rearming an incident, show missing monitored IDs as coverage gaps, and support a read-only notification preview and a reviewed resumption baseline.
- Verification boundary: reproduce source disappearance, renamed tasks, unfinished retries, repeated observations and restart; verify genuine recovery still allows a new alert. A quiet test does not prove that every future alert will be correct.

### 2026-10-03 — Amber 固定展示实例额度与会话 Token

- 用户验收了紧凑用量样式，并明确要求：任何人选 Amber 都看到宠物旁的额度与会话标题右侧的 `k` 单位 Token；其他主题不显示。
- 数值仍须分清实例 Codex 额度和 Session 累计 Token。会话用量改为简短接口，避免扩大用户范围后反复下载完整账单。实现及范围见 `notes/current/amber-usage.md`。

### 2026-10-02 — Keep account switching out of request startup

- Observed friction: the first account-pool implementation queried quota before each request and held an exclusive account lock for the full run. Both added avoidable waiting to the normal conversation flow, including background metadata helpers.
- Requested behavior: preserve the original startup and concurrency. Leave a 10% quota reserve for running tasks; background samples select another independently authenticated account for subsequent requests.
- Implementation: foreground requests read the saved default and register their own liveness without quota RPCs or shared execution locks. Idle monitoring and native usage updates change the default at 10% or below only when another subscription has fresh quota above that reserve. Ongoing runs remain on their original account; a confirmed exhaustion updates the next default without restarting the run. Unknown or stale quota and network/authentication failures do not trigger rotation.
- Evidence boundary: scenario tests cover concurrent startup while the monitor holds its control lock, zero foreground quota queries, reserve selection, ongoing-run isolation, and batch/native conversation continuation. The reserve reduces the chance of exhaustion during work; it cannot guarantee that every long task fits.

### 2026-10-02 — Expose native questions with a bounded fallback

- Requested behavior: display numbered native question options in the existing conversation. Exact in-range numbers select options; all other text is a custom answer. Use a fixed five-minute timeout for this first trial and support both Codex and Claude.
- Implementation: the detached native host publishes questions to Web and the bound chat, captures answers before ordinary steering, and returns them through each Harness's native protocol. Codex Plan-mode blocking requests and Default-mode async question messages share the same resolver; Claude uses the stdio `can_use_tool` callback for `AskUserQuestion` only. Other permission requests remain denied.
- Fallback: disclose option 1 and the deadline before waiting. Each unanswered question defaults after five minutes; a question without options returns unanswered. Persist whether the answer came from a user or timeout, and identify timeout values to the Harness as system defaults rather than user consent. Multiple questions appear in order; Claude multi-select accepts `1,2`. Native secret inputs are not collected through ordinary chat.
- Evidence: real installed Codex and Claude CLIs against local model fixtures accept numbered and custom answers. Scenario coverage checks the bound Feishu conversation, visible Web projection, durable origins, timeout/cancellation races, controller restart, reply replay and exactly one native answer. Ordinary group usability still needs the trial; no new buttons, per-person settings, label prompts or question classifiers were added.

### 2026-10-02 — Distinguish progress from delivered results in Feishu

- Observed friction: useful additional messages still require readers to inspect every body to tell whether work continues or a result has arrived.
- Requested behavior: try shared labels for the small current user group, rather than adding a personal preference. Iterate after actual use.
- Follow-up correction: keep the first trial a pure rule system that is transparent to the AI. No third label and no prompt instructions asking the model to control labels. Running execution maps to `【进展】`; stopped execution maps to `【交付】`. Hold an early final for terminal publication so it cannot claim delivery while execution continues. Reuse receipt deduplication; do not add a classifier or increase message frequency.
- Evidence boundary: stopped execution does not establish task success. Automated coverage checks running and stopped publication, terminal fallback, replay, and other connectors; reader comfort remains a trial.

### 2026-10-02 — Route by engineering depth and latency, with Sol xhigh as the default

- User preference: GPT-6.1 Sol xhigh is sufficient for most tasks at an acceptable cost. Routine work should keep that reasoning effort; lower tiers should serve an explicit need rather than automatic token savings.
- Product implication: proactively select Astra xhigh for large projects with serious architecture design and implementation. Use Sol low for focused tasks that prioritize fast turnaround, retain medium for explicit preference, and reserve Luna for exceptional explicit Luna or absolute-lowest-cost requests. Ordinary debugging and local features remain Sol xhigh; asking for xhigh alone does not imply Astra.
- Scope: this changes new Auto Session routing. Concrete model selections and existing Sessions retain their runtime; independent background metadata helpers keep their own policies.

### 2026-10-03 — Group useful progress even without an acceptance checklist

- Observed friction: an enabled web conversation received the current rules, but its progress still appeared as separate chat messages because no task checklist existed. The user experienced this presentation gap as a partial rollout.
- Requested behavior: useful progress belongs in one place. Keep simple deliveries free of acceptance checklists; presentation must not depend on the Harness creating one.
- Implementation: a deterministic progress panel per Run reuses the existing Web renderer and Feishu route worker. Later updates patch the original place, and a later real acceptance list upgrades it. Openings, user questions and final answers remain separate. Original history remains intact; old delivered Feishu messages are not replayed or recalled.
- Acceptance boundary: verify the reported web conversation on read, multiple progress updates, replay/restart, recipient isolation and upgrading to a real task. No model classifier or additional model call is introduced.

### 2026-10-02 — Hold to speak, review, and send on phones

- Source: a direct mobile voice-input request followed by approval to try the researched interaction.
- Observed friction: starting and stopping dictation requires separate taps; the user initially wanted to hold, speak, and release to submit recognized text, then changed this to review before sending after the phone trial.
- Product implication: keep short taps and holds predictable. A temporary hold does not change the default mode; explicitly choosing the wide voice control persists for that Person's phone view, independently of desktop.
- Implementation: reuse the recognizer and optional personal transcript cleanup, then keep the final text as an editable draft until explicit Send. Sliding upward or tapping Cancel discards the capture; editing uses the normal text composer. Existing text and attachments stay in the composer. Permission delays, interrupted touches, navigation, backgrounding, and stale recognition results are guarded.
- Evidence boundary: automated touch/browser checks use a real browser audio-capture path with simulated recognition. Physical microphone quality, recognition accuracy, and thumb comfort still need a phone trial.
- First phone-trial feedback: speech reaches the conversation, but the recording surface looks cluttered and editing after automatic submission is unavailable. The user requested a visual refinement.
- Refinement: one compact voice composer with a proper keyboard icon, an integrated recording surface, live audio bars, readable transcription, and explicit Cancel / Edit first choices. Editing still happens before submission; this slice does not introduce historical message editing. Browser acceptance covers 320/390/430px, light/dark, long text, and native slide gestures.
- Follow-up phone feedback supersedes automatic submission: release should leave the recognized text in the composer for checking or editing, and only explicit Send submits it. Default review keeps the phone keyboard closed; choosing Edit opens it. Replace the synchronized bar scaling with a smoothly moving history of actual microphone volume; silence stays quiet. Automated checks cover varying-volume PCM through real browser capture, with recognition simulated.
- 2026-10-03 phone feedback: remove the redundant lateral Edit gesture; slide up to cancel and tap recognized text to edit. First authorization is a separate enable gesture. Consecutive takes reuse a disabled microphone stream for up to one idle minute; switching to typing, backgrounding, or closing the page releases it. AudioContext resumes in the touch event rather than after the hold timer, and local audio is buffered while recognition connects. Only actual audio readiness displays the listening prompt. Browser permission retention remains browser-controlled; Safari's per-site Allow setting is the persistent option. Synthetic PCM verifies the startup buffer and one microphone acquisition across consecutive takes; actual Safari prompts and phone recognition still require device acceptance.

### 2026-10-02 — Reuse independent hardware discussion recording on every instance

- Requested behavior: an ordinary office computer should continue normal use while several independent discussions start/stop from hardware buttons and automatically enter RemoteLab. Adding receivers must add separate sources, rather than sharing one global left/right namespace.
- Implementation: an optional macOS/Linux recording component binds receiver identity plus channel to a lane and keypad command. Local WAV segments and submission manifests survive interruption; the existing Session/asset/message path owns analysis and delivery. It ships disabled and requires one-time software, permission, source and delivery configuration. See [the activation guide](../../docs/platform-skills/hardware-recording.md).
- Evidence boundary: automated multi-stream capture and real HTTP submission tests use synthetic PCM and a fake Harness; CI compiles the macOS helper. Physical receiver/keypad compatibility and remote transcription are separate acceptance items, not inferred from these tests.

### 2026-10-01 — Show an opening, useful progress, and the final conclusion

- Observed friction: Connector replies omit the first useful assistant message, while native Harness commentary mixes important findings with routine activity. Readers lack context unless they open the Web transcript.
- Requested behavior: show a short opening and the final answer; let the Harness explicitly publish additional meaningful progress through a lightweight XML tag. Hide untagged intermediate messages in the Web process record. Use the same rule across Web and Connectors.
- Implementation: `<progress>...</progress>` publishes only its enclosed text. A shared deterministic selector drives Web display and durable live deliveries, with restart-safe receipt IDs and a per-turn prompt for resumed threads. Simple answers can remain one message. See [the display contract](../../docs/assistant-message-visibility.md).

### 2026-10-01 — Temporarily let the Session model judge every Jev-group message

- Observed friction: Jev's reply gate produces too many false negatives, leaving questions and follow-ups unanswered. Missing a needed response costs more than an occasional extra reply, especially in an intentional conversation.
- Interim behavior: forward every admitted human message to the Session model, including Jev silence, reaction-only, binary-answer and classification-failure outcomes. Keep Jev's existing reaction choices and work-placement hints. The Session model chooses whether to contribute text; reaction-only classification cannot prevent it from reading the message.
- Scope: this temporarily bypasses the `jevReactions` submission gate. Existing mute, Bot admission, topic routing and request deduplication still apply. A complete redesign remains future work.

### 2026-10-01 — Keep the accepted checklist and result behavior as a baseline

- Observed friction: a Session checklist worked in the web view but Feishu split it into several cards and delayed the final result. A later model-capacity failure left a card apparently running. The user wants the repaired behavior to persist across future tasks, rather than depend on one successful turn.
- Accepted behavior: one task retains one card across Runs; publish the initial deliverables before investigation and update each verified item immediately. A task may remain incomplete after a Run ends and must still deliver its explanation. Work completion and result delivery use separate state and receipts. Ordinary commentary, final text and internal execution plans cannot overwrite acceptance conditions or close the task.
- Implementation and maintenance: both surfaces project the same Session snapshots; durable card IDs, revision guards, creation fences and task-bound result receipts support restart recovery. The scoped worker has no expiry or stop-time opt-out. Keep Person/Bot opt-in limits. The [current baseline](feishu-workboard-pilot.md) and `npm run test:workboard` are the maintenance entry; required CI runs it, including previously omitted activation, frontend and HTTP/CLI scenarios.
- Evidence boundary: original-card updates, cross-Run continuation, restart recovery and a separate final receipt were verified in a real Feishu topic. Native streaming/files and failure scenarios also have isolated integration coverage. Legacy phase-less adapters still publish results at Run end; activation was not expanded to all people or groups.

### 2026-09-30 — Failed actions must show their reason in the product

- Observed friction: a model change followed by Steer returned HTTP 409, but the frontend logged the reason only in the browser console. The user had to inspect the API to understand why the message was not sent.
- Product implication: display action failures immediately and retain recent notifications in a visible place. Preserve rejected message text and attachments so the user can correct the setting and retry.
- Implementation: failed HTTP actions show the server reason in an in-app toast and the header notification panel. The panel retains the latest 50 notices in this browser, scoped to the signed-in Person and product path, and survives reload. Existing runtime admission rules stay in effect.

### 2026-09-29 — Group transcripts need durable speaker attribution

- Observed friction: a group Session's visible transcript stored each person's raw message without a speaker label. The short-term source context knew the current sender, but a paired project's message stream recorded human posts before profile enrichment and omitted both readable names and stable identity. Readers could mistake conflicting statements by different people for one person's changing view.
- Product implication: show the speaker on old group messages from saved metadata, and put a stable speaker label into each new group Session message. Carry that identity through same-chat history and cross-group excerpts. When an identity is unavailable, say so rather than merging anonymous speakers. Keep original message IDs for source checks and leave historical transcript bodies intact.

### 2026-09-29 — Finish voice dictation with an automatically cleaned draft

- Observed friction: a personal voice trial exposed an extra “Review draft” and “Use revised text” sequence after dictation. The user expected one automatic cleanup after recording and found an enabled speech recognizer easy to mistake for an enabled cleanup model.
- Product implication: keep the opt-in personal switch and hotwords, but when a model key is configured, replace only the just-finished transcript in the composer automatically. Preserve manual edits, retain an Undo action, and let Send wait for in-progress cleanup. Show the missing-model state plainly when hotwords work but cleanup cannot run.
- Trial setup: seed a short personal dictionary from recent recurring project and product names; keep model credentials separate from speech recognition credentials.

### 2026-09-29 — Reuse fixed Connector actions to save model tokens

- Observed friction: documenting Feishu commands and trimming chat history still left the model composing card JSON and provider calls during some tasks. The user expects recurring Connector work to use prewritten, reusable actions. Their specific token-cost question concerns the **post-answer conversion** into Feishu display form, not ordinary answer generation.
- Product implication: during the normal task turn, the model should infer the useful result from the user's goal, including a card for a scannable status or a real calendar/task resource for a commitment or follow-up, even when the user does not name the format. Deterministic code owns provider request shape, Bot identity, validation, compact output, readback, and post-answer display conversion. Apply this pattern to other Connectors as their repeated workflows become clear.
- Implementation: `remotelab feishu` exposes fixed Bot actions for contacts, messages, status cards, reactions, calendars, tasks, and Base records. The native `lark-cli` remains the provider client and fallback for less common operations. The ordinary Feishu reply adapter compiles the generated answer to rich text locally, without a second model call. The Feishu guide and source prompt now describe in-turn selection by user goal. A card still sends as a separate action; the durable source-delivery reply does not yet carry a native card variant.

### 2026-09-30 — Open a Feishu Thread for work admitted from a trial group

- Observed friction: a substantial request in a trial group's main timeline was admitted by Jev and handed to a separate work Session, but the visible progress reply stayed in the group main timeline. The group member expected a Feishu Thread on the source message.
- Product implication: keep observation and work admission in the shared group Session, then bind the work request's visible delivery to a Thread rooted at the inbound message. Do this in the connector so it does not depend on the Harness emitting a special reply marker. A later human reply in that Thread should resolve to its own Session.

### 2026-09-30 — Only targeted reactions when a trial group does not start work

- Observed friction: the trial groups now retain every message in their main Session, and the broad no-work reaction fallback creates more visible responses than the user finds useful.
- Product implication: honor Jev's no-work decision even for a direct @ mention. For no-work messages, react with `WOW` only to clear praise of the assistant or its work and `DULL` only to clear criticism or rejection. Otherwise record the decision and stay silent. Keep the direct-mention work fallback only when Jev cannot make a confident work decision. The user plans to test this in a trial group.
- Scope: this narrows the `jevReactions` path; the older `quickReactions` path has a separate outcome policy.

### 2026-09-28 — Short praise still needs a visible response

- Observed friction: two consecutive short acknowledgements praising the assistant were correctly left without a text reply, but the contextual reaction selector chose no reaction both times. The user noticed the missing response immediately.
- Product implication: each admitted message gets one final, visible outcome reaction. A temporary receipt may appear first, but must be removed after the outcome succeeds. If the assistant cannot choose an outcome, use `EatingFood` rather than leaving the message without a final reaction.
- Implementation: the continuing Session selects the outcome, and the Feishu connector applies it as the Bot. The durable delivery path supplies the fallback and removes its own temporary reaction after the outcome succeeds; normal processing does not launch a CLI command per message.

### 2026-09-28 — Applied side-display layouts are persistent settings

- Observed friction: an applied personal layout was automatically withdrawn after 24 hours and appeared to the user as a disconnected display, even though the computer was still online.
- Product implication: retain applied layouts across time, transient service outages, and restarts until explicitly replaced or removed. Keep pairing, computer connectivity, current frame delivery, and USB playback separate in status reporting.
- Implementation: remove the sidecar's implicit 24-hour layout expiry, read authenticated playback status without a short-lived browser grant, and test old records, restart persistence, and explicit removal.

### 2026-09-28 — Keep ordinary conclusions in the conversation

- Observed friction: AI-generated documents sent alongside a normal answer split one conclusion across a chat reply and a file; the extra document was often less readable than the reply.
- Product implication: keep file delivery available, but make the conversation the default. Attach a file when requested or when the result needs a file for use, editing, or sharing. Keep the reply understandable on its own instead of making a document merely to repeat it.
- Implementation: clarify this priority in the RemoteLab startup context; preserve explicit `Artifacts:` delivery and native connector attachments.

### 2026-09-28 — Distinguish RemoteLab automations from project tasks

- Observed friction: calling RemoteLab's scheduled and triggered AI work "Tasks" led users to confuse it with the separate Feishu project task list.
- Product implication: label the RemoteLab surface "Automations" (自动化), explain its schedule and trigger scope, and retain existing task URLs and API identifiers for compatibility.
- Project priority belongs to the Feishu action list and its review process; changing this UI label does not assign priority to people or their work.

### 2026-09-27 — Login state must survive a failed session-file write

- Observed friction: a user needed to sign in again every day even though RemoteLab issues 30-day cookies; the login page has no separate “remember me” option.
- Cause: while the disk was full, direct writes truncated `auth-sessions.json`. Service restarts then failed to parse it and discarded existing browser sessions. Repeated service-token logins also grew the file rapidly.
- Implementation: write a complete temporary file before replacing the session file, serialize writes, and reuse one service-token session. Keep the existing 30-day browser cookie behavior.
- Validation: isolated persistence and HTTP tests cover a failed write preserving the prior file, write ordering, service-session deduplication, and repeated service-token login.

### 2026-09-26 — Select SOTA with a task shortcut in chat

- Observed friction: selecting the strongest tier takes a separate `/tier sota` command, while Quick already accepts a task directly.
- Implementation: `/sota <task>` resolves the configured SOTA preset, follows the chat's reply placement, and persists the selection before submitting work. Bound Standard Sessions switch in place; fixed Quick Sessions explain how to start a new topic.
- Validation: parser, runtime-command and connector tests cover task text, reply placement, first-request runtime, existing Sessions, invalid combinations, and retrying a saved selection.

### 2026-09-26 — Keep the simple display editor while linking detailed settings

- Observed friction: the expanded display studio needs a clear path back to RemoteLab; the existing GIF plus sentence editor remains useful. A disliked pet should leave both the picker and automatic rotation.
- Product implication: link the two editors from the device settings area, keep the simple editor intact, and make switching display modes actually change the device source. The detailed editor's current pet catalog excludes the rejected frog.
- Validation: route, settings UI, preview stream and browser checks cover navigation, mode handoff, and pet migration.

### 2026-09-26 — Chat links should open login, not an authentication error

- Observed friction: opening a LangSmith entry shared in chat without a RemoteLab browser cookie returned a JSON authentication error instead of a login page.
- Implementation: the existing entry now opens the username/password form and resumes the selected Session/run after login. `/log` uses that entry while retaining the raw provider URL in the search API.
- Validation: an isolated HTTP test covers anonymous navigation, failed and successful password login, preserved run destinations, authenticated redirects, and unchanged authentication for other APIs. RemoteLab login does not grant LangSmith project access.

### 2026-09-26 — Explain missing LangSmith links in historical search

- Observed friction: `/log` found historical Sessions but called every absent snapshot “no records,” including queued backfills and Sessions never covered by the collector.
- Implementation: report disabled, untracked, pending, waiting, failed, unsupported date/type, and empty states separately. Resolve explicitly configured historical imports as well as live/backfill snapshots; label historical imports in the reply.
- Validation: resolver, search, and Feishu command tests cover status propagation, historical import links, and fallback to a valid snapshot when another source is corrupt. Search remains read-only and does not start an upload or grant LangSmith access.

### 2026-09-26 — `/log` should find the current topic first

- Observed friction: asking `/log` to debug the current Session returned three unrelated historical Sessions, all without LangSmith links, even though the bound Session had a verified trace.
- Product implication: resolve the active conversation binding for `/log` and clear current-Session wording; keep explicit historical keyword search available. Show the exact trace entry first and the Session page second.
- Validation: connector tests cover bare `/log`, current wording, historical search and missing upload states; an isolated HTTP test checks authenticated JSON status and the existing browser redirect.

### 2026-09-26 — Remove automatic Agent Case links from replies

- User request: retire the Agent Case link appended below assistant replies.
- Implementation: reply publication and connector formatting no longer generate or append this footer, including failed and cancelled task notifications. Previously issued authenticated case URLs can still resolve for historical inspection.
- Validation: `tests/test-langsmith-case-link.mjs` covers publication and connector formatting with legacy case metadata, alongside the existing snapshot lookup checks.

### 2026-09-23 — Auto belongs before model selection; Quick can be an internal tier

- Observed friction: the composer puts `Auto (Jev)` inside the model list while separately offering Standard and Quick, making the selected runtime unclear even though the first-turn route already persists a concrete model and Effort.
- Product implication: offer Auto / Custom only before the first message. Auto chooses a concrete runtime once; both paths then show the same editable runtime dropdowns. Keep Quick as an internal low-Effort tier rather than a third visible mode.
- Evidence and limit: a five-tier Jev candidate matched 21/22 holdout synthetic first-message labels, with one conservative Quality escalation. GPT-6 Sol low and xhigh both answered 6/6 short tasks; low did not improve median latency in this small CLI check.
- Implementation follow-up: the Web composer shows Auto / Custom only before the first message, then returns to the ordinary runtime dropdowns. The Auto router includes Quick with its own configurable prompt, and Settings exposes tier editing plus a read-only route preview. Legacy Quick Sessions and connector commands remain compatible.
- Evaluation: `notes/archive/auto-custom-routing-eval-20260923/README.md`.

### 2026-09-15 — Codex login needs account identity and current limits

- Observed friction: frequent account changes made a plain signed-in badge insufficient to identify the account currently used by the instance.
- Product implication: show the available account name, email and plan next to login status, with remaining quota windows and reset times. Fetch this operational state through deterministic account APIs without starting AI work.
- Implementation: `notes/current/codex-account-status.md`.

### 2026-09-15 — Thinking should stay one block when a user interrupts

- Observed friction: a new user message changed the preceding unfinished turn
  from one thinking block into a stack of separate Thought rows. Intermediate
  usage events split tool activity into additional blocks.
- Product implication: each user-message turn owns at most one thinking block.
  Keep its intermediate commentary, reasoning, tools and usage together, including
  when the turn is interrupted. Keep the final reply and delivered files accessible.
- Implementation and regression evidence:
  `notes/current/thinking-turn-fold/BUGFIX_VERIFICATION.md`.

### 2026-09-15 — Browser read indicators belong to Chat UI conversations

- Observed friction: externally delivered conversations showed unread review
  badges and read-based title dimming based on visits to RemoteLab, even though
  users expected to read their replies in the connector's own application.
- Product implication: show these effects only for Chat UI sessions without an
  external conversation binding. Keep live execution status visible for every
  origin. An independent Chat UI handoff retains its own reading indicators.
- Implementation: `notes/current/session-origin-filter.md`.

### 2026-09-15 — Handoff origin must match where the child can be found

- Observed friction: independent children created from Feishu inherited the Feishu
  origin label without receiving a Feishu topic. Users filtering for Chat UI lost
  track of work that could only be continued there.
- Product implication: a handoff child belongs to Chat UI. Keep parent lineage
  separate from the child's interaction surface, and repair older unbound visible
  children without changing their history or archived state.
- Implementation: `notes/current/session-origin-filter.md`.

### 2026-09-14 — Installed PWA launches must not replay installation

- Source: an owner reported seeing the setup/redirect page on every cold launch from the home screen.
- Cause: the install manifest used the guide as its permanent start URL; the guide waited for service-worker registration/update before redirecting standalone apps.
- Product implication: launch new installs through the HTTP-only login bridge, which reuses authenticated sessions before considering the short-lived handoff. Existing icons can retain the old start URL indefinitely, so route standalone guide visits before first paint and without waiting for assets or service workers. Keep ordinary browser installation guidance intact; do not require reinstalling or a shared browser/PWA storage flag.
- Validation: `tests/test-mobile-install-flow.mjs` covers new/repeat HTTP launches, signed-out recovery, stable app identity, and the pre-paint iOS/Android/browser/prefixed legacy-entry tests.

### 2026-09-09 — Private chat identity and task titles serve different purposes

- Source: owner found connector fork prefixes redundant but needs a recognizable home for long-running Feishu/WeChat private conversations.
- Product implication: task and fork titles follow normal AI naming; long-lived direct chats keep a fixed source identity across topic changes. Preserve explicit user titles and distinguish a direct chat from a topic opened inside it by the durable conversation key.

### 2026-09-09 — Reading a Session must not move its row

- Source: owner reported losing the selected Session when clicking it reordered the sidebar.
- Cause: review, running and workflow attention ranks overrode activity timestamps for Sessions and groups.
- Product implication: keep Sessions newest first and compare groups by their most recent Session activity. Read/unread status is a visual cue only. The organizer changes Space/Project labels, not chronological order.

### 2026-09-08 — Connector admission must not wait for AI completion

- Source: owner reviewed connector timeout behavior and explicitly prioritized WeChat and Email while retiring WhatsApp Business and the local Voice Connector.
- Observed failure: a connector-local ten-minute wait can expire while the accepted AI request is still healthy, misreport model failure, block following input, and lose responsibility for the eventual reply.
- Product implication: reuse Feishu's durable inbox and independent request-outbox delivery architecture. Acknowledge durable receipt, hand off the request, and end inbound processing; publish each request's result independently of session idleness. Keep per-operation network deadlines and sender leases, not an overall AI deadline. Merely changing a timeout to infinity does not fix restart recovery.
- Scope boundary: retire unused connector surfaces rather than broadening abstractions for them. Keep browser/mobile Shortcut input separate from the retired local Voice Connector, and keep user-owned Gmail operations separate from Agent Mailbox reply transport.
- Contract: `docs/external-message-protocol.md`.

### 2026-09-08 — Group attention gates should not add friction inside an invited AI thread

- Source: owner compared an AI thread interaction with the recently restored mention-only group policy.
- Observed friction: requiring an explicit Bot mention on every thread reply prevents natural follow-up after the Bot has already been invited. Removing the mention gate for the whole group instead floods a broad audience with AI output.
- Product implication: gate entry at the public group boundary; once a Bot has joined an exact thread, admit subsequent human replies there without another mention and preserve the existing Session. Keep this participation durable and isolated by Bot, chat and thread, never inferred from a group-wide Session. Sender access control and Bot loop protection remain separate and unchanged.
- Implementation and verification: `notes/current/feishu-thread-continuation.md`.

### 2026-09-07 — Browser notification permission needs an explicit activation and recovery path

- Source: owner reported missing notifications while Chrome still showed the site's permission as `Ask`; RemoteLab had never asked.
- Observed failure: the instance had no push subscriptions or recent subscription requests. Ordinary page startup only registered push when permission was already granted; prompting was limited to a post-install flag, and Settings had no notification activation control.
- Product implication: distinguish browser permission from a server-confirmed subscription. Provide a user-gesture-bound enable button, visible blocked/unsupported/error states, and a reconnect action. Never report success when subscription persistence fails; do not treat Chrome's `Ask` state as user refusal or require users to discover browser settings to activate the feature.

### 2026-09-06 — Session execution state needs text, not color alone

- Source: direct owner feedback while reading the live mobile Session list.
- User slice: mobile-first owner monitoring work across active Sessions.
- Observed friction or ask: the compact sidebar reduced running and completed-result state to small colored dots, making progress hard to understand and requiring users to remember color meanings. Restoring `running` alone was insufficient: when a run ended, the result became visually indistinguishable from ordinary finished conversations because the review cue depended on delayed workflow classification.
- Signal strength: concrete production usability failure after the compact status treatment shipped.
- Product implication: keep the compact row, pair the green running indicator with `running`, and show an explicit `review` badge as soon as an idle Session has an unseen assistant result. Do not gate this badge on the later workflow-state classifier; color may reinforce state but must not carry the meaning alone.
- Promote to: Session-list accessibility and mobile status defaults.

### 2026-09-04 — Automated tasks must not append control prompts to an existing conversation

- Source: direct owner feedback after a one-time WeChat reminder trigger inserted its internal execution instruction as a visible user message in the conversation where the reminder was created.
- User slice: mobile-first owner using long-lived conversations for ordinary work while also scheduling background tasks.
- Observed friction or ask: the scheduled task interrupted the original conversation and polluted its context. Every automatic task should execute in a separate new conversation. This should be the only behavior, not a default plus a reuse exception.
- Signal strength: concrete production failure traced to a one-time trigger treating the source conversation as its execution target, compounded by CLI wording that blurred source and target.
- Product implication: do not model conversation reuse as a configurable mode. One-time triggers and recurring schedules have one execution rule: create a new session, using the originating session only to seed folder/runtime/system-prompt context and any connector return route. Remove the mode field, reuse flag, conditional runtime branches, and associated documentation; regression-test that no trigger prompt or status event is appended to the source transcript.
- Follow-up: deterministic connector reminders should ultimately use a first-class `connector_action` rather than spending a model turn, but any interim AI-backed reminder must still run in its own session.

### 2026-09-04 — unattended Agents should execute reversible work instead of waiting at invisible review gates

- Source: direct owner correction after repeated Agent workflow iteration.
- User slice: owner delegating low-loss, reversible work to background or otherwise unattended Agents.
- Observed friction or ask: broad approval, acceptance, and manual-review defaults do not create safety when nobody is watching the queue. They silently stop the workflow, hide defects, prevent retries, and leave no practical audit loop even though executing the action incorrectly would usually be nearly harmless.
- Signal strength: repeated cross-workflow collaboration failure plus an explicit review of the current risk profile.
- Product implication: default to `execute -> append audit evidence -> verify -> bounded retry or visible failure` for low-loss, reversible, auditable actions. Human checkpoints are reserved for hard authorization, unavailable credentials/real-world actions, irreversible high loss, or material financial/legal/privacy/availability/third-party impact not already scoped. Every retained checkpoint must actively notify a responsible person and preserve an exact resume path; an invisible `waiting_user`, approval queue, or preview-only state is an operational failure.
- Promote to: Agent creation defaults, Session state classification, platform skills, connector recovery contracts, mailbox intake defaults, setup docs, and shared memory.

### 2026-09-04 — Retire the standalone fleet-admin plane

- Source: direct owner review followed by a live dependency and usage audit of the only host still running the standalone Admin service.
- User slice: product owner simplifying a host that runs multiple single-user RemoteLab chat instances; each user instance contains its own set of task Sessions.
- Observed friction or ask: fleet users, trial allocation, billing, host rollout, and instance lifecycle had grown into a separate operator product inside the personal workbench repository. The dashboard had no runtime dependents, remote fleet records were stale, the current main instance had no team-account configuration, and no recent main-route Admin requests were present.
- Signal strength: explicit retirement decision backed by live service, route, state, repository-reference, and guest-activity inspection, followed by an owner correction of the multi-user boundary.
- Product implication: remove the standalone dashboard, `/admin` proxy, fleet-host CLI/registry surface, Admin-specific ingress routes, and active docs/tests. Preserve the local `guest-instance` primitive, guest registry, automatic inactivity parking, and active guest services because per-user chat-server instances—not Sessions—are the current multi-user isolation boundary. A Session isolates one work thread's conversational context inside an instance; it does not isolate users, files, memory, Connectors, or machine permissions.
- Follow-up: completed in the same cleanup round—the unused team-session-view/member-account code, UI, metadata, tests, and active documentation were removed. Keep necessary per-instance lifecycle operations as small deterministic host primitives rather than recreating a separate Admin product.

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

### 2026-08-10 — shared Agent validation must start from an independent invocation

- Source: direct owner review of a newly opened KOL workflow Agent.
- User slice: operator turning a proven internal workflow into a reusable Agent that other people can invoke independently.
- Observed friction or ask: the new Agent technically completed useful work, but it silently reused historical campaign assets and the automatic reply-completion review advanced using context that was not part of the test packet. This tested access to existing data rather than the intended end-to-end onboarding flow.
- Signal strength: concrete live-session failure reproduced in tool history and the reply self-check timeline.
- Product implication: every new custom Agent session should default to an independent invocation. Stable instructions, skills, connector availability, and deliberately bundled template context may carry; prior sessions, task memory, historical business records, and local artifacts require explicit user scope. Agent creation should finish with a clean-room dry-run that receives only an explicit test packet and executes every low-loss reversible step. The older conclusion that named review gates should bind the run is superseded by the 2026-09-04 risk-tiered execution rule above.
- Promote to: Agent prompt construction, Create Agent starter flow, shared-Agent regression tests.

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
- Promote to: provider/runtime architecture, explicit worker-host execution contracts, and session dispatch design; do not revive the retired Fleet Admin product merely to support remote execution.
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

### 2026-09-03 — inbound mentions should commit business changes without chat polling

- Source: direct owner review of an active creator-supply Campaign update
- User slice: internal teams that give an agent operational instructions from several Feishu conversations
- Observed friction or ask: an explicit mention already wakes the agent, so chat-specific polling and group whitelists add machinery without improving discovery; the real gap is reliably attributing the sender and committing the resulting business delta
- Signal strength: direct workflow correction backed by a prior weekly-target message that affected execution but left stale projections and incomplete audit state
- Product implication: Connector source context should expose stable message revision and sender identity, including internal-tenant classification when verifiable; the domain workflow should own classification, idempotent authority writes, read-back, projection repair, and the source-thread receipt
- Promote to: Feishu source-context contract and domain-specific Campaign change ledgers
- Follow-up: validate the next naturally occurring edited message and durable Search Contract change end to end

## Entry template

### 2026-09-23 — a Feishu thread on an inline reply created two Sessions

- Source: owner screenshot and live connector event, Session, and delivery receipts
- User slice: owner continuing an agent conversation inside a Feishu thread
- Observed friction or ask: the first mention and a later mention shown in one thread opened separate RemoteLab Sessions
- Signal strength: reproduced from the stored event shape: the first mention had a parent message ID but no thread ID; its first bot reply returned the new thread ID
- Product implication: when RemoteLab starts a thread from a message that is already an inline reply, the new thread root is that inbound message, not its inherited parent ID. Session identity, reply destination, and local binding must use the same root.
- Promote to: Feishu thread routing regression coverage and connector release
- Follow-up: verify a naturally occurring thread started from an inline reply reuses one Session on its next mention

### 2026-09-17 — fresh provider sessions need a measurable preflight gate

- Source: direct owner request with a concrete version-probe workflow
- User slice: owner starting RemoteLab Sessions during a provider rollout where nominal model selection may not establish serving freshness
- Observed friction or ask: run a no-network knowledge probe before the real first turn, replace a provider session after a configured stale answer, and report daily whether the gate loaded normally, whether replacement was actually needed, and the observed proportion
- Signal strength: direct workflow request with explicit stale marker and one-minute retry interval
- Product implication: treat preflight activation, first-attempt pass, replacement-required, eventual pass, and terminal failure as distinct durable states; describe the result as a heuristic signal rather than model-version attestation
- Promote to: native Harness startup path, instance policy, and local daily operational statistics
- Follow-up: use observed replacement rate and false-positive evidence to decide whether this should remain an instance policy or become a broader runtime capability

### 2026-09-20 — preflight progress should be visible in the Thought block

- Source: direct owner review after using the session-start freshness gate
- User slice: owner waiting for a fresh provider Session while one or more preflight attempts run before the real request
- Observed friction or ask: the gate was useful but too implicit; without a visible trace, the startup delay looked unexplained and the user could not tell what was being checked or why a replacement was happening. Live follow-up also showed that exhausting all attempts failed the run before the original prompt reached the Harness, making a later “continue” operate on probe context instead of the actual task.
- Signal strength: direct feedback on the live workflow, confirmed against the affected Session's durable run manifest and history
- Product implication: keep probe turns out of user/assistant messages, but project the configured probe, attempt number, returned answer, stale-marker match, retry wait, and outcome into the folded Thought block. Treat preflight as fail-open warming: exhaustion or a probe error is recorded, then the same durable run must submit the original prompt; only failure of the real request may fail the run.
- Promote to: native Harness startup observability and other backend-owned warming steps that delay a real turn
- Follow-up: observe whether the detailed trace is understandable without becoming noisy; consider structured/localized activity rendering if more startup gates adopt the same pattern

### 2026-05-25 — large audio attachment send should not be tied to message submission

- Source: live trial8 user report while sending an audio-file request from mobile chat
- User slice: mobile-first owner using chat as the primary intake surface
- Observed friction or ask: after tapping send with an audio attachment, the composer stayed in sending state and then failed, leaving the draft in the input
- Signal strength: concrete failed workflow with server evidence; two `/messages` uploads stayed open for about five minutes and ended as aborted requests
- Product implication: non-storage installs still need direct local attachment upload before message submission so large media files do not hold the whole message request open
- Promote to: composer attachment upload reliability and local file-asset defaults
- Follow-up: consider visible upload progress and clearer failure copy for slow or interrupted mobile uploads

### 2026-09-22 — settings and global actions should use a flatter, reachability-first layout

- Source: direct owner review of the current RemoteLab Web UI
- User slice: owner moving between Sessions, Tasks, and instance settings from phone and desktop
- Observed friction or ask: Settings had become a long undifferentiated page, repeated containers made the interface feel heavy, the full-width header used space inefficiently, and New Session / Tasks still took too much effort to reach on mobile
- Signal strength: direct review of the shipped interaction model followed by an explicit request to implement and iterate on a flatter version
- Product implication: keep high-frequency actions one tap away, group Settings behind a stable five-part page directory, use spacing and typography before borders, and reserve framed cards for objects or states that genuinely need a boundary
- Promote to: application shell, Settings information architecture, responsive navigation, and shared visual tokens
- Follow-up: review the first implementation on real desktop and mobile surfaces, then tune density and grouping from concrete screenshots rather than adding more decorative material effects

### 2026-09-23 — settings title alignment and New Session reachability need a second pass

- Source: annotated screenshot review of the first flat Settings implementation
- User slice: owner navigating a wide desktop Settings page and frequently starting new work
- Observed friction or ask: the Settings title aligned with the directory instead of the form content, leaving an awkward empty corridor; the directory should sit farther left, while New Session at the sidebar's top remained unnecessarily far from the user's working position
- Signal strength: direct visual annotation after the first implementation was deployed
- Product implication: align page titles with their primary content column, keep local page navigation in a clearly separate leading column, and place high-frequency creation actions in a reachable persistent zone with a discoverable keyboard shortcut
- Promote to: Settings grid alignment, sidebar action placement, and global shortcut conventions
- Follow-up: validate the bottom-sidebar placement and `Command/Control + Shift + Enter` on real desktop and mobile use

### 2026-09-23 — test an incremental memory and Skill review loop before automating promotion

- Source: owner discussion after reducing always-on model context and restoring full Markdown context visibility
- User slice: owner trying to keep long-lived memory and reusable capabilities useful without letting context grow by accumulation
- Observed friction or ask: a daily scheduled review of memory and possible new Skills sounds useful, but the owner is unsure whether it will produce real value once running
- Signal strength: direct product hypothesis; a later turn authorized a seven-run pilot to the Claude Tag discussion group, but outcomes are not yet observed
- Product implication: evaluate a bounded incremental review that checks new candidates, stale/conflicting active context, and repeated successful workflows. Keep Skill creation and promotion tied to sourced repeated cases and actual reuse; record no-change days and review cost instead of manufacturing daily output.
- Promote to: memory curation and capability-accumulation trial design if a scoped pilot is agreed
- Follow-up: review the seven-run pilot's missed useful corrections, false positives, reuse of Skill candidates, and reading cost before adding an enduring schedule or automatic memory edits

### 2026-09-25 — make voice input keyboard access opt-in per person

- Source: direct user request after tracing a double-Fn microphone to the Mac's own dictation shortcut
- User slice: a desktop Person who wants to start RemoteLab's in-page voice input without using the mouse or changing other people's keyboard behavior
- Observed friction or ask: RemoteLab's voice button had no keyboard shortcut; the requested control is off by default, editable in Settings, and scoped to the signed-in Person. Three Option taps is a desired binding.
- Signal strength: direct request, supported by inspection of the shipped voice-button handler
- Product implication: keep shared voice-service credentials separate from individual shortcut preferences; reuse the button's recording path and treat OS-reserved shortcuts as outside the page's control
- Promote to: desktop voice input settings and Person preferences
- Follow-up: validate three Option taps in the user's Mac browser and check for OS shortcut conflicts

### 2026-09-25 — Claude Code model choices and effort must track the installed Harness

- Source: direct request after the Claude Code picker fell behind current releases.
- Observed friction or ask: Fable and Opus 5.5 were absent, and the available thinking effort levels were unclear.
- Product implication: expose current aliases and useful pinned versions, show effort by model, and keep the installed Claude Code CLI current enough to run them. A model's native default remains available when no override is selected.
- Follow-up: recheck the official Claude Code model and effort table when upgrading the CLI; verify the live picker and a real account canary.

### 2026-09-25 — 副屏飞书提醒以真实已读状态和发送者为准

- Source: direct user correction after the persistent new-message reminder was shipped.
- Observed friction or ask: a notification should disappear when the user reads it in Feishu; the display should show who sent it, and the user asked whether message content is technically readable.
- Product implication: use the authorized user's batch message read-status endpoint, resolve sender names through the existing Feishu app, and show only sender names on the shared display. Keep a clear fallback if read status is temporarily unavailable.
- Follow-up: validate the live service and public preview, then verify an actual unread-to-read transition when a new message arrives.

### 2026-09-25 — 副屏 Session 更新与定时提醒需可感知

- Source: direct user report of lagging Session status and water, activity, and custom reminders not appearing as expected.
- Observed friction or ask: data should refresh promptly, and timed reminders should remain visible long enough to be noticed and verified.
- Product implication: avoid redraws caused only by poll timestamps, shorten the Session status check interval, retain timed reminders for ten minutes, and surface an empty custom reminder as incomplete configuration.
- Follow-up: verify a real Session state transition and a timed reminder on the paired device; browser and service checks alone do not establish physical pixels.

### 2026-09-25 — 副屏去重、结果来源、天气和飞书会话来源

- Source: direct user feedback on the v46 display layout and Feishu reminders.
- Observed friction or ask: remove repetitive headings and status labels; identify which Session produced a pending result with a short context; put time on the left and current weather on the right; summarize unread Feishu messages by group, topic or private conversation instead of sender name.
- Product implication: separate work context from actionable reminders, use a configurable city with clearly credited weather data, and resolve Feishu chat metadata without exposing message bodies.
- Follow-up: verify live group-name lookup, weather availability, rendering and current paired-device playback; clarify that individual topic titles are not present in the message-search metadata.

### 2026-09-25 — 副屏天气城市定为北京

- Source: direct user clarification after the configurable-city weather preview was published.
- Observed friction or ask: the user's location for this display is Beijing, while the first weather preview defaulted to Shanghai.
- Product implication: use Beijing for new drafts and migrate the old Shanghai default once; preserve later user edits and apply Beijing to the current paired-device preview.
- Follow-up: verify the public preview, persisted active payload, sidecar frame, and matching device USB playback receipt.

### 2026-09-25 — 副屏同步延迟和伪宠物动作

- Source: direct user report after trying the Beijing weather version.
- Observed friction or ask: Feishu reminders still feel delayed; quantify Session versus Feishu delay and remove whole-image pet motions that do not animate the character itself.
- Product implication: measure message creation to first observation separately from API and device refresh, keep Feishu polling off the Session response path, and use only original character GIFs. Do not call image translation a new action.
- Follow-up: verify real API timing, public page, removed assets, active paired frame, and USB playback receipt.

### 2026-09-25 — 副屏提醒默认覆盖晚间并缩短飞书缓存

- Source: direct correction after the latency review.
- Observed friction or ask: the prior 09:00–18:00 default hid evening Feishu reminders, and a 3-second cache was still too slow.
- Product implication: default to workdays 09:00–22:00, migrate the old default once, apply it to the current device, and shorten the single-flight Feishu cache to 1 second while preserving the 2-second display read interval.
- Follow-up: verify evening visibility, actual API availability, and device playback after applying the current payload.

### 2026-09-26 — 飞书重连不能把历史消息当成新未读

- Source: direct user correction after Feishu reconnect.
- Observed friction or ask: the user expects one continuing authorization; reconnection surfaced many messages already viewed in Feishu as fresh unread alerts, which then persisted.
- Product implication: rotate refresh tokens in the background, record each new grant as an observation boundary, reconcile pregrant messages into a private audit instead of a new-message alert, and compare read status with newer read messages in the same ordinary chat.
- Follow-up: verify live new-message and read transitions. A false read-status result alone cannot prove that a historical message is currently unread in the Feishu client.

### 2026-09-26 — 话题提醒只认明确提及，矩阵默认得意黑

- Source: direct user correction after using the display.
- Observed friction or ask: topic replies without an exact mention were still read into the reminder feed; the Matrix preset should use Smiley Sans as its default full-screen font.
- Product implication: remove the directed-reply exception, recheck already queued topic alerts, and update the Matrix theme preset while preserving explicitly chosen custom fonts.
- Follow-up: verify the live Feishu summary, published editor, and paired display playback after the rule and preset are applied.

### 2026-09-26 — 副屏飞书提醒按消息层级判断

- Source: direct user correction after the topic-message filter was applied.
- Observed friction or ask: private and ordinary group messages should alert when unread; a top-level message in a topic chat is still a group message. Only replies inside a topic or conversation need an exact mention of the user. Calendar events should begin alerting about 30 minutes before they start.
- Product implication: classify replies by the message's `parent_id`, not the chat's topic mode; retain the recipient read-state check and baseline existing messages when changing the filter so old items are not presented as new.
- Follow-up: verify a new unread-to-read transition for each message class and an upcoming real calendar event. Message read status alone does not expose the client's exact notification badge.

### 2026-09-26 — 副屏未读漏报与主题使用埋点

- Source: direct user report of one Feishu unread message missing from the display and a request to learn which display themes people use.
- Observed friction or ask: compare the prior evening's and today's notification logic, keep genuinely unread ordinary messages visible, and record theme use without adding a website report.
- Product implication: a known message can still be unread; a newer read message or outgoing reply in the same group must not clear it. Track theme selections separately from successful display applications, with only a pseudonymous Person key and theme ID in a private local event log.
- Follow-up: verify a real unread-to-read transition and inspect the private theme event log after an authenticated selection and application. Report aggregate theme use only when requested.

### 2026-09-26 — LangSmith 链接必须定位到对应 Session

- Source: direct user report after following a Session's LangSmith entry.
- Observed friction or ask: the link exposed the project instead of selecting the requested Session.
- Product implication: validate the exact root run and workspace, support both provider run URL forms, and migrate verified history indexes together with collector account changes.
- Follow-up: verify each entry against the destination project's Session metadata and concrete run URL; distinguish API verification from authenticated browser acceptance.

### 2026-09-28 — 群主线应独立可查，工作与私聊另走 Session

- Source: direct user correction and pilot request.
- Observed friction or ask: a private web continuation of a group-bound Session was published back to the group. The user wants a separate read-only area for group histories, with participation only through the source group; substantial work belongs in a separate project or personal work Session. Begin with a small exact-chat pilot and leave other groups on their current route.
- Product implication: bind each group mainline to a service-owned Session, gate browser writes at the server, choose delivery from the current request, and keep group checkpoints out of personal memory. Save incremental nightly review state and retain source message IDs.
- Follow-up: verify live chat IDs, first-message cutover, reply destination, read-only UI/API behavior, nightly checkpoint, and actual work handoff before extending the pilot.

### 2026-09-28 — 飞书群聊入口应使用用户认识的名称

- Source: direct user feedback while viewing the first group Session in the sidebar.
- Observed friction or ask: the sidebar showed an opaque Feishu chat ID above the group name. Name the section “飞书群聊” so people can recognize it at a glance.
- Product implication: keep chat IDs for routing and diagnostics, but show a plain section label and each group's name in the navigation.
- Follow-up: verify the label after the browser loads the latest frontend files; an already open tab may still display its previous sidebar code until refreshed.

### 2026-09-28 — 飞书群聊应独立于所有人的工作区

- Source: direct user correction after opening a group Session in ChatUI.
- Observed friction or ask: the group history appeared among personal Sessions and contributed to personal filter counts; after reading it, the user could not find an obvious way back to Mine.
- Product implication: show group histories under their own top-level navigation entry, exclude them from every Person's session list and counts, and provide a visible return to Mine both in the sidebar and beside the conversation title.
- Follow-up: verify the two pilot groups appear only in the group area, personal counts stay unchanged, and return works on desktop and narrow screens.

### 2026-09-28 — 群聊只占用现有会话归属选择器

- Source: direct correction after seeing the extra group navigation, Space tabs and origin filter in the sidebar.
- Observed friction or ask: keep only the existing Mine/Person selector in that area. Put “飞书群聊” beside the People in that selector, remove the extra group entry and return buttons, and avoid a special permission label in the group list.
- Product implication: selecting a group or Person should show that scope's Sessions and give a direct way back through the same selector. Keep group Sessions out of personal counts and lists; do not create another navigation level for them.
- Follow-up: verify switching Mine → group → Mine, the two pilot group names, no duplicate group heading or permission badge, and no leftover hidden origin or Space filter.

### 2026-09-29 — 语音输入整理应由个人选择并保留原文

- Source: direct user feedback on the existing speech-to-text input.
- User slice: a Person dictating chat messages with recurring names and technical terms.
- Observed friction or ask: offer optional cleanup and correction, disabled by default, and allow the Person to try it alongside the original transcript. A personal vocabulary should help with recurring terms.
- Product implication: once a Person opts in through settings, review each completed dictation automatically in the editable input box with Undo. Store vocabulary outside the shared People directory. Send opt-in personal terms as Doubao relay recognition hotwords and as hints for draft correction; other voice providers only receive the correction hints.
- Follow-up: compare real utterances with and without personal vocabulary to measure recognition gains and unwanted substitutions. Record latency and token use for the chosen review backend.

### 2026-09-29 — 语音整理不应默认消耗 Codex CLI

- Source: direct user correction after the personal voice trial shipped.
- Observed friction or ask: the Codex Luna fallback consumes too much fixed context for a short transcription cleanup; use a small, preferably free API model instead.
- Product implication: no implicit model fallback. Keep personal ASR hotwords available, but offer draft review only after a dedicated model API is configured and report that state in settings.
- Follow-up: compare free small models on real Chinese dictation, including name correction, meaning preservation, latency, and actual request limits before choosing an operator default.

### 2026-09-29 — 个人语音整理需要可见的 API 配置入口

- Source: direct user question after the small-model API change.
- Observed friction or ask: settings did not show where to enter a model API key, so the personal trial could not be completed from the product surface.
- Product implication: put supported provider choice and a personal API key field next to the voice-review toggle and hotwords. Show whether a key is saved without returning its value, and keep the feature off until the Person enables it.
- Follow-up: verify that a new Person can configure a provider, save hotwords, preview a correction, and remove the provider from the same settings screen.

### 2026-09-29 — 豆包识别用户希望豆包完成草稿整理

- Source: direct correction with a screenshot of the Sessions settings area.
- Observed friction or ask: provider choices omitted Doubao even though the instance already uses Doubao for speech recognition; the settings path was unclear from the current page.
- Product implication: offer a Doubao Ark model for personal draft review, explain that the Ark API key differs from the speech recognition App ID and Access Token, and point users from Sessions settings to the Connections section.
- Follow-up: verify a real Ark call with a user-supplied key and compare short Chinese corrections, latency, and cost.

### 2026-09-29 — 自动语音整理须去口水词并按口述结构分点

- Source: direct correction with a screenshot of a completed four-item dictation in the chat input.
- Observed friction or ask: the automatic review visibly ran, but left filler words and all four explicitly enumerated items in one paragraph.
- Product implication: instruct the personal review model to remove only meaningless filler and self-repetition, preserve each item's information, and format explicitly enumerated speech as a numbered list. Keep the cleanup light and editable with Undo.
- Follow-up: check a fresh browser dictation after deployment; compare it with the original transcript for item coverage, names, negation, and unwanted rewriting.

### 2026-09-29 — 语音转写要边显示边组织，状态不要占一整块

- Source: direct user correction with a screenshot of a new organized dictation.
- Observed friction or ask: the cleaned text is usable, but the separate success panel takes too much space and personal hotwords still miss some names.
- Product implication: show a compact status and Undo beside the composer controls; format clearly enumerated points as recognition streams, then run one final model review. For opted-in Doubao ASR, request semantic smoothing and dual-pass refinement. Treat hotwords as recognition hints rather than guaranteed substitutions.
- Follow-up: verify a fresh browser recording for status size, live point layout, final correction latency, and exact names before adding term aliases.

### 2026-09-29 — 语音整理过度压缩，个人词典需要明确错词

- Source: direct correction with before/after screenshots of a three-item dictation.
- Observed friction or ask: the final text shortened full spoken sentences into terse action summaries. The Person perceived two cleanup passes and confirmed one recurring English project name was misrecognized.
- Product implication: use one light proofreading pass after ASR, preserve full clauses and speaker framing, reject summary-shaped short outputs, and support explicit heard-form to canonical-term corrections in a personal dictionary. Keep name terms grounded in the accessible company directory and focus the hotword budget on frequent collaborators and domain terms.
- Follow-up: compare a fresh recording against the original for complete item detail, the confirmed alias, and unrelated-name false corrections.

### 2026-09-29 — 优先豆包识别顺滑，不追加模型整理

- Source: direct user correction after the lighter model-review trial.
- Observed friction or ask: the Person prefers the ASR provider's built-in semantic smoothing and asks whether a second model review is needed at all.
- Product implication: offer ASR-only smoothing as the simple path, keep personal hotwords and confirmed exact-term corrections, and make any post-recording model review a separate opt-in choice. A saved model key must not cause a model call when that choice is off.
- Follow-up: verify a fresh recording for filler removal, term accuracy, preserved detail, and zero post-recording model requests.

### 2026-09-29 — 会话清单与监视状态必须在 Thinking 外可见

- Source: direct correction during a single-Session workflow pilot.
- Observed friction or ask: a checklist written only in chat and a one-off process wait did not provide a visible checklist or monitor. Native plan events could also be folded into Thinking.
- Product implication: for an opted-in Session, let a cheap structured decision determine whether the Harness should publish a checklist with an existing tool; project checklist updates outside Thinking and show native Run state in the same Session. Do not create a second workflow engine for this pilot.
- Follow-up: verify a real multi-step turn creates and updates the visible checklist, a short turn skips it, and the monitor reaches a terminal Run state without affecting other Sessions.

### 2026-09-29 — 会话清单应原位更新并说明验收标准

- Source: direct correction after a three-deliverable single-Session trial.
- Observed friction or ask: four progress events appeared as separate collapsed plan cards, so the Person could not perceive one checklist changing state. The checklist also lacked a short explanation.
- Product implication: keep one current checklist in the opted-in Session workboard, update its completion state in place, and give it a one-line task title plus one or two plain sentences explaining the outcome and completion standard. Keep each item concise with a checkable condition.
- Follow-up: verify live event updates, the rendered workboard, and a non-pilot Session separately; do not infer that stored events alone prove the page changed visibly.

### 2026-09-29 — 清单每项独占一行，历史更新不能堆叠

- Source: direct correction after the first workboard rendering change.
- Observed friction or ask: the Person still saw a pile of checklist cards and asked for each deliverable to occupy its own row, with the next deliverable starting on a new row.
- Product implication: use one workboard panel for the opted-in Session, keep prior checklist state available there, and suppress separate transcript cards for every checklist update. Put an item's short title and completion condition on the same row; the task-level explanation stays above the list.
- Follow-up: verify current live events and served assets separately from the running server process and the Person's already-open browser tab.

### 2026-09-30 — 清单应是会话内的一条消息

- Source: direct correction during the opted-in checklist pilot.
- Observed friction or ask: the checklist floated on mobile and was absent from the desktop view; the Person wanted one checklist message that updates progress, followed by one result message.
- Product implication: show the latest checklist revision inline in its turn on both viewport sizes, keep one row per deliverable, and place the final answer after it. Preserve raw revisions for audit without rendering them as separate cards.
- Follow-up: verify the current Session on mobile and desktop after fresh load; confirm a second update changes the same visible checklist and other Sessions retain their normal transcript.

### 2026-09-30 — 清单用目标开头，真实进度与思考都应可见

- Source: direct follow-up during the single-Session checklist pilot.
- Observed friction or ask: the Person asked for `目标：` directly above the deliverables, a real state change in the same checklist, and an expandable Thinking block. A steering message during unfinished work started a new Run and exposed a gap in per-turn checklist coalescing.
- Product implication: coalesce checklist revisions across steering messages until the result closes the work, keep one expandable Thinking block per user turn, and let WebSocket invalidation refresh the inline checklist after a genuine update.
- Follow-up: verify the current Session receives an invalidation, projects one updated card, and loads its Thinking event range; the already-open browser tab may need one refresh to load changed JavaScript.

### 2026-09-30 — 单人飞书私聊试用动态交付清单

- Source: direct request after the Session checklist pilot was tested.
- Observed friction or ask: the Person wants Zhang Siyuan to test the same checklist and separate result in his Feishu conversation without changing other people's conversations.
- Product implication: enable the checklist judgment on only his bound private Session, mirror checklist revisions by editing one Bot message, and leave the existing final source delivery as a separate reply. Keep Thinking inside RemoteLab because Feishu chat text has no native expandable Thinking block.
- Follow-up: validate a real multi-step Feishu request, one message ID across revisions, final result delivery, and other private chats remaining unchanged.

### 2026-09-30 — 试验群开工后仍需分短回复和复杂任务

- Source: direct correction after observing a work reply without a dedicated topic.
- Observed friction or ask: routing every admitted reply into a Thread loses brief mainline answers, while routing complex work from the group Session does not create a separate work Session.
- Product implication: Jev first decides whether to work, then selects short mainline work in the existing group Session or complex work in a new Thread and Session. For no-work messages, retain only explicit praise (`WOW`), explicit criticism (`TOASTED`, 飞书「衰」), or silence.
- Follow-up: verify both work paths and all three no-work outcomes with fresh messages in a pilot group; inspect Feishu delivery receipts and Session bindings.

### 2026-09-30 — 试验群需要按问题接话，表情不能代替答案

- Source: direct user correction after reviewing a full pilot-group exchange and a screenshot of an unwanted reaction.
- Observed friction or ask: an @ mention of the assistant plus a test phrase opened a work topic even though Jev had not admitted work; a new topic inherited an old reaction instruction and posted only「摸头」. Questions about the assistant's behavior, implementation, rollout and group coverage went unanswered without an @ mention. Criticism produced a dog-head emoji because `DULL` had been mistaken for 飞书「衰」.
- Product implication: use the Jev work decision rather than @ presence as the work gate. Treat concrete unanswered questions and actionable bug feedback about the assistant as work even without @. Give short answers on the group mainline and investigation in a new topic Session; do not let that Session emit a reaction-only answer. Map explicit no-work criticism to `TOASTED`; keep pure test phrases silent.
- Follow-up: use fresh pilot messages to read back reactions, mainline answers, topic creation and Session bindings. Historical replay is useful for classifier tuning but does not prove live delivery.

### YYYY-MM-DD — short title

- Source:
- User slice:
- Recurring work:
- Observed friction or ask:
- Signal strength:
- Product implication:
- Promote to:
- Follow-up:

### 2026-09-30 — Keep one live checklist and publish final answers independently

- Observed friction: an opted-in group task created a second checklist card after a progress message, and its final answer remained local while a follow-up kept the native execution active.
- Product implication: one execution supplies two independent outputs: one card updated after each verified deliverable, and a separate final result. Progress text does not end the card cycle. The existing event-driven publisher observes durable completion events; it is not a second semantic planner.
- Implementation: preserve native message phase and item identity, keep one card per task across Runs, validate status/evidence/revision snapshots, separate public deliverables from native execution plans, replay unseen card revisions in order, and commit completed final answers with ready assets to the durable outbox before the native process exits. Delivery identities prevent replay and terminal settlement from sending that final again. Local file and image publication retains its asset-materialization boundary.

### 2026-10-02 — Account rotation must preserve normal conversation speed

- Source: direct feedback during a production account-switching incident review.
- Observed friction or ask: people expect the same parallel conversation behavior as before saved accounts; a 10% reserve should permit asynchronous selection of the next account without a quota lookup or account queue on the request path. The operator requested implementation first and explicitly deferred deployment until a later hands-on test.
- Product implication: quota persistence and collection are observational background work. They must not delay replies, change successful task results, or impose per-account model concurrency limits. Coalesce passive observations and sample one existing native connection per account rather than adding a timer to every conversation. Keep current tasks pinned to their selected account and change only future requests.
- Follow-up: keep this candidate out of the live checkout until the later acceptance session; verify concurrent visible replies, cache-failure isolation, and next-request rotation before rollout.

### 2026-10-03 — Monitoring should foreground issues and account allowance

- Source: direct follow-up after using the first monitoring overview.
- Observed friction or ask: consumption and opportunity prose separated urgent issues from allowance readings. People want issues first, allowance second, and lower-priority details below; the same top section should be readable as a group snapshot.
- Product implication: sort urgent issues before warnings, show account percentages and reset times with meters, retain explicit unknown readings, and put the visual snapshot in the existing daily message rather than adding another routine notification.
- Verification: desktop and phone views, snapshot source timestamp, native inline-image delivery in one Feishu post, and real instance readback.


### 2026-10-03 — Name the resource and runtime view; browse automation failures by task

- User goal: know which resources remain and whether anything needs attention, then inspect an automation only when diagnosing its triggers or failures. A flat list of each historical admission obscures this purpose.
- Response: call the destination Operations (运行中心), and the exported summary Operations overview (运行概览). Keep the Overview / Automations switch. Keep the original automation card appearance and order. Repeated one-time follow-ups are grouped by their source work and execution lineage, including follow-ups with different titles or prompts; recurring schedules remain distinct. A small red dot and failure count on the package lead to a collapsed trigger timeline with retained errors and execution-log links.
- Evidence boundary: task enablement, a failed trigger, a later successful run and an old admission without execution evidence are distinct states. Historical records stay available; grouping cannot cancel or rewrite their producers. Test previews are private to the requesting person until accepted for production delivery.

### 2026-10-03 — Output architecture needs a readable chronology and explicit handoffs

- Source: direct follow-up with a supplied reference webpage after reviewing the output architecture diagram.
- Observed friction: the overview mixed desired behavior with current execution and did not identify synchronous waits, asynchronous workers, the two Session handoffs, or Jev's remaining responsibilities. A source/CI pass had also been mistaken for acceptance of the real Feishu experience.
- Change: make the stable output page a chronological reading guide with selectable actual entry paths, numbered swimlanes, per-step ownership/input/output/waiting facts, and folded source details. Keep proposed interactions in a separately named appendix and scenario. Explain observation versus executable admission, conditional Auto routing, the groupFeed card exclusion, pending-question text binding, and the two independent delivery workers.
- Acceptance boundary: website delivery is separate from live message-flow acceptance. Immediate receive reactions, cross-worker arrival ordering, question levels and interruption semantics remain explicit gaps; a new real complex-task delivery sample is still required.

### 2026-10-03 — Group the parent automation without redesigning its cards

- Correction: matching identical titles and prompts missed multi-stage automations whose follow-ups change instructions. The compact summary redesign and failure-first ordering were explicitly rejected.
- Product response: retain the original card layout, lifecycle filter, metadata and controls. Follow the source Session and execution ancestry to collect the parent automation; show only a red dot and failure count outside, then chronological records, full errors and individual child controls inside. Never reorder packages because one child failed or apply a lifecycle action to a synthetic group. Independent schedules from the same setup Session stay separate.
- Acceptance: verify different-title follow-ups, active children, recurring execution follow-ups, retained older failures, timeline pagination and phone layout. Test previews go only to the requesting person.

### 2026-10-03 — Use Monitor as the navigation name; inspect UI changes on the website

- Feedback: Operations / 运行中心 was harder to understand than 监控器. Use Monitor / 监控器 for the navigation and page heading, retaining the Overview / Automations switch and original card appearance.
- Delivery preference: routine changes to this website are reviewed by refreshing the website; do not send additional Feishu preview messages, including private screenshots. The previously accepted resource summary in the normal daily report remains a separate workflow.
- Refresh diagnosis: the supplied screenshot already contained the new Trigger history entry; a familiar card appearance alone does not prove that old assets are being served. Verify the actual instance and both language labels before declaring deployment complete.

### 2026-10-03 — Automation summaries must describe the parent task's operation

- Correction: adding collapsed trigger history while leaving the original configuration dump outside did not meet the goal. The outer view is for understanding one business task, its plan, today's outcome, next run, total attempts and failures. A familiar card appearance is not evidence that this information is clear.
- Response: retain the existing card borders, type and colours; show those four runtime fields with a readable plan and a small red dot for retained failures. Move prompts, runtime/delivery configuration and lifecycle controls inside. Group repeated triggers by the task's source and execution ancestry, and recreated identical schedule definitions by business purpose. A shared generic Feishu chat must not merge unrelated tasks.
- Lifecycle: ongoing and one-off tasks are visible; paused, finished and disabled task sections start folded. Preserve producer order within each section, without moving failures to the front. Actions still operate on actual schedules or triggers, never on a synthetic package.
- Evidence: count attempted executions, not future plans or cancellation before execution; separate today's verified successes, failures, live executions and unavailable old outcomes in the task's timezone. Validate desktop and phone layout, nested records/settings, older failures and pagination, then the actual website. Do not send additional Feishu previews.

## 2026-10-03 — Avoid task cards for one straightforward delivery

An opted-in user reported that project renames and similar small changes were
receiving deliverable lists too often. Routine inspect/edit/check steps are not
separate user outcomes. Keep the strong Harness responsible for intent and
acceptance; default bounded single deliveries to a direct final reply. Reduce
mechanical card overhead through validated state deltas, compact receipts and
on-demand evidence lookup, while preserving immediate per-deliverable updates.


### 2026-10-03 — Show the latest execution and retain lifetime counts

- Correction: today's outcome made a long-running task appear unused on a quiet day. The four outer fields are latest execution time and result, next run, cumulative executions and historical failures. Future plans and pre-execution cancellation do not supply a latest run or inflate totals. Missing records say no retained execution records instead of claiming an all-time zero.
- Counting boundary: direct schedules use all retained actual attempts across days. Conditional script automations keep exact persisted check totals, clearly labelled as checks; show their AI execution totals separately inside. Neither substitute the number of AI launches for script checks nor add both phases as independent runs. Preserve historical gate errors as well as retained AI failures without fabricating per-check history.
- Live evidence: the existing daily-report schedule retains executions from September 2, including migration-era trigger IDs; the newly created daily feedback-review schedule is a different business task with its first run still pending at inspection time. Verify both the source ledger and actual website, without sending another Feishu preview.

## 2026-10-03 — Instance-wide task-card rollout after stability review

A pilot user asked to roll the mechanism out to all members of the current
instance, including Feishu and web, after checking stability and persistence.
The clarified scope is this instance only. The policy must include future
registered members without a static enrollment list, keep bounded small tasks
as direct deliveries, and preserve strong Harness interpretation. Route-wide
Feishu publication must replace the Person-only worker without duplicate cards
or historical backfill. Canonical rules, isolated regression and durable service
settings are separate from verified live deployment and delivery.

## Web continuation of connector-origin conversations (2026-10-03)

- Feedback: after instance-wide workboard activation, continuing a Feishu conversation from Web still produced scattered progress and no task checklist for a substantial repair.
- Verified cause: admission checked the Session's original Feishu destination against the actual Web identity, set this turn's activation false, and injected a restriction against new cards.
- Wider audit: replaying current admission rules across 20 recently active conversations and 90 inputs found the same mismatch in 16 ordinary Web turns across three Feishu-origin conversations. This measures routing coverage, not whether every turn semantically needed a checklist.
- Fix: instance-default activation follows the authenticated Web member even in connector-origin conversations. Group feeds and excluded members remain excluded; Web activation does not grant a Feishu send admission.
- Acceptance: cover Web continuation of private and group-thread Sessions, identity mismatch, exclusions and unchanged connector admission; verify the actual affected conversation on the deployed service.

## Workboard outcome and delivery-state risk recheck (2026-10-03)

- Follow-up: a user requested another risk review after the instance-wide rollout appeared complete.
- Verified gap: terminal fallback deliveries omitted the final answer identity, so confirmed results did not reach the task's history receipt projection. Web-only tasks also displayed an unconditional pending external-delivery label.
- Fix: retain answer identity and multipart count on terminal settlement; recover old receipts only from exact retained payload and destination matches through idempotent acknowledgements. Show a neutral work-complete label without external receipt evidence. Preserve task acceptance, original messages and delivery outcomes.
- Acceptance: native restart integration must observe final receipts in durable history, including text plus file; an earlier answer cannot settle later work or an ambiguous answer bundle. Recheck current Web/mobile views and original provider messages separately from CI.

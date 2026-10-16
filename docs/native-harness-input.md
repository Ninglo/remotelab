# Native Harness input

RemoteLab forwards additional user messages to an active native Harness as soon
as its input channel is available. The Harness owns when those messages affect
model inference, tool execution, retries and subsequent turns. Receiving an
input is not a claim that an already-running model call has consumed it.

## Supported transports

| Harness | Transport | Active input | Stop |
| --- | --- | --- | --- |
| Codex | App Server, JSON-RPC over stdio | `turn/steer`, with `expectedTurnId`; `turn/start` only after a definite no-active-turn rejection | `turn/interrupt` |
| Pi | `--mode rpc` | `prompt` with `streamingBehavior: "steer"` | `clear_queue`, then `abort` |
| Claude Code | `--input-format stream-json --output-format stream-json` | streamed user messages with UUIDs | native interrupt control request |
| Antigravity | `--input-format stream-json --output-format stream-json` | FIFO streamed user messages; acceptance is recorded at the matching `user_input` step | bounded process-signal fallback; the protocol has no in-band interrupt message |

The built-in tools select native input. Custom tools retain their existing batch
contract unless their tool record explicitly declares `"inputMode": "native"`.
An arbitrary program that only mimics a CLI's output is not automatically a
bidirectional implementation of that CLI's protocol.

The HTTP endpoint remains `POST /api/sessions/:id/messages`. It durably accepts
each requestId and returns a response address. Compatible active native inputs
return `queued: false`; they are forwarded without waiting for the root task to
finish. Incompatible Harness/model/effort changes during an active native task
return HTTP 409 (`SESSION_BUSY`). Stop the task or wait for completion before
sending with the changed configuration. Internal maintenance operations and
explicit batch-only custom runtimes retain their separate sequential contract.
This includes ordinary user input arriving while the active request is an
internal operation (such as `trigger_delivery`): it returns `queued: true`, stays
visible in the Session queue, and can be removed until execution or native
handoff starts. Admission and dispatch share the request compatibility checks;
native capability alone does not mean a follow-up can join the active request.

## Continuing an execution from its Feishu reply Thread

New group mainline inputs use `feishuThreadSessionVersion: 1`: the Harness opens
a bound independent thread Session through `work route` `mode:new` before
substantive work. Thread follow-ups use ordinary native input in that Session;
after completion they start its next turn. No running native execution is moved
between Sessions. Dispatch does not steer a new-version mainline input into a
pre-upgrade execution with a different frozen thread contract. Existing bound
topics continue normally. The origin-run continuation below is retained only for
legacy mainline-owned reply threads and already accepted inputs.

When an ambient mainline execution places its reply in a new Thread, the
successful delivery receipt connects subsequent Thread input to that exact
active native Run. Existing independent Thread bindings still win. The temporary
connection expires when that execution stops and cannot follow a later mainline
Run. The connector keeps the main Session prompt and the input's own Thread
reply address; source context explains that this is a continuation, not a fresh
assignment.

Only new Runs advertising `feishuThreadContinuationVersion: 1` in their saved
options participate; a server restart cannot upgrade an old detached host.
Admission validates `sourceContext.feishuContinuationRunId` against the actual
Thread receipt. A pre-admission completion re-resolves normal Thread routing.
After admission, `continuationOnly` prevents a stale addition from launching a
new Run or Codex `turn/start` after a no-active-turn rejection. It instead retains
the input with an explicit failure. Already dispatched but unacknowledged input
to a cancelled Run likewise never clears into a new execution. Ordinary fresh
inputs and normal completion-race fallback retain their existing contract.

Opening publication is once per conversation within the execution. Supplementary
answers still use `<reply>` and useful progress uses the existing progress
policy. Hidden openers do not reappear when later input selects a Thread.
The Harness remains responsible for understanding stop scope and explicit
natural permission to resume; the transport does not classify message meaning.

New ambient mainline inputs carrying `feishuReplyPlacementVersion: 1` require
an explicit inline/thread choice before visible output. They cannot join an
ordinary pre-upgrade mainline Run with a different placement contract; a
receipt-proven Thread continuation retains its existing destination. Missing
placement produces at most one structural error through the same native input
channel, with `continuationOnly` and `referenceOnly`: it cannot start a settled
turn or answer a pending human question. The publisher retains unplaced content
and never replays the blocked opening after a correction. If no choice arrives
before completion, only a delivery-failure notice is sent, while the generated
answer remains available in Session history. This does not add a semantic
reviewer or another model. See [group reply placement](feishu-bot-setup.md).
For an unplaced pending question, one failure notice links to the original Web
question controls; it neither answers that question nor selects inline placement.

## Rule recovery after native compaction

Codex standard native inputs install a process-local `SessionStart` / `compact`
hook. It restores the current immutable RemoteLab rule snapshot before the next
inference, including automatic compaction during a turn. Rule-reference reuse
requires this recovery capability; other Harnesses conservatively receive full
rules per input. An unavailable hook or unreadable selected snapshot stops
reference-only continuation with an explicit error. A rule-recovery hook stop
settles the RemoteLab Run as failed, even if Codex labels the stopped turn
completed; it must not appear as a successful empty result. This requires a Codex build
supporting native hooks (verified on 0.159.2); no persistent user configuration is
rewritten. Existing active hosts acquire it on their next Run, not by silently
changing an already accepted input. See [context delivery and validation limits](connector-turn-context.md).
## Personal Feishu input-tool trial (v1)

This optional trial is off by default. A person can ask the assistant to enable
or disable it using `remotelab message-replies input-trial on|off|status --json`.
The current accepted human Request supplies the verified identity; callers do
not supply a Person ID. Only `preferences.inflightTrial` changes, preserving
existing opening, checklist, progress and work-start preferences. This is a
Feishu trial; the setting can be managed through either authenticated surface.

New Feishu inputs capture the sender's setting. Tool use requires BOTH the
current input and the root task to have opted in for the same Person, in the
same conversation (including a receipt-proven Thread continuation of that exact
Run), and the saved personal switch to remain on. Other people do
not inherit it from a shared Session. Turning it off disables new tool use
immediately; already queued deliveries retain their existing outbox lifecycle.
A shared Session still has shared model history, so this is a capability scope,
not a private-context sandbox. Start a new task after enabling to exercise v1;
an execution accepted before opt-in keeps its original contract.

The Harness decides when these tools help; there is no extra classifier or
parallel worker. Ordinary steer admission, request IDs, uncertain-input recovery
and native reply publication are unchanged. The optional capability description
joins the stable rule-context snapshot; only the current input address is new
per input. Unknown acceptance still conservatively retains context rather than
claiming it was consumed. This does not promise zero repeated background text.

- `input-trial inspect --request-id <id> --json` reads this execution's accepted
  opted-in inputs, retained unanswered questions and delivery receipts. Input
  bodies are omitted unless `--include-text` is requested. It does not inject,
  resend or acknowledge input; do not poll it.
- `input-trial reply --file <json> --json` accepts
  `{sourceRequestId,replyId,requestIds,text}`. It can answer several of the
  person's inputs together through the existing source outbox. A stable replyId
  reserves the immutable packet and native-publication marker atomically with
  the delivery. An identical retry returns that receipt, including after an
  uncertain response; different content with the same ID is rejected. A missing
  history mirror is repaired on retry. This prevents duplicate enqueueing for
  the same ID, not semantically equivalent answers with different IDs. The
  Harness must not repeat the answer in a reply tag or the task's final result.
  The source's existing publication policy still applies. Ambient-group replies
  also obey the execution's explicit placement choice; a first tool reply can
  include the same hidden inline/thread prefix. An omitted choice is returned as
  a tool error, and the hidden prefix never appears in delivered text.
- `input-trial stop --request-id <id> --expected-run <runId> --json` requests
  cancellation of that exact execution. It never falls through to the next
  active run or changes participation mode. It does not stop independently
  running external jobs or guarantee immediate interruption of a tool call.

The response rule is to send useful established answers promptly. Combine
compatible questions if that helps; do not wait for a slow second query or use
a fixed debounce window. New facts that invalidate an unsent answer require a
revision. Already delivered answers require a concise correction. Superseded
native question controls are not kept alive by this trial: inspect retains the
unanswered requirement, and the Harness asks again if still needed. Silence,
continued discussion and side answers are never approvals.

Implementation: `chat/inflight-trial.mjs`, `chat/router-inflight-trial.mjs`,
`lib/inflight-trial-command.mjs`, and the existing settings, admission and
rule-context modules. Validation is included in `test:native-harness`;
`tests/test-inflight-trial.mjs` covers personal scope, mixed senders, uncertain
acceptance, outbox/history recovery, native publication deduplication, exact-run
stop and disabling. Live user experience remains a separate trial acceptance.


## Answering native questions

Codex and Claude questions appear once in the existing Web conversation and
bound chat. Web users click an option, select several checkboxes, or type a
custom answer in the original question. Feishu uses one interactive card with
option buttons and a custom-answer form; multi-select questions use a dropdown.
Replying `1`, `2`, or `3` still selects an in-range option. Custom answers are
submitted in the card form. Other ordinary text, including an out-of-range
number, continues the conversation without selecting an option. Claude
multi-select also accepts comma-separated numbers such as `1,2`. Several
questions appear in order.

Web controls submit with `nativeQuestionAnswerSource: "control"`; Feishu callback
Request IDs identify the same control path. The answer stays in raw history as
`native_question_answer` and reaches the native question tool. The visible
conversation acknowledges it on the original question instead of adding a user
bubble. Typed replies remain ordinary messages. The selected option stays
visible with a filled marker and completed tint; only other options are folded.
Question surfaces use the active theme's accent, background and text colors in
every state. Completion adds a stronger tint and a check mark instead of changing
to an unrelated success color. System appearance follows the OS light/dark mode.

Ordinary questions have no automatic timeout. The original question and its
controls remain pending until the person answers, sends a continuation, or stops
the run. Opening or refreshing the conversation does not start a five-minute countdown, hide the
options or choose on the person's behalf. The detached host stays available
while waiting; the final result settles after the answer and resulting work.

When an ordinary human message is accepted by the native Harness, the host
retires the questions captured before dispatch as `superseded`. Web and Feishu
update the original card and disable its controls; waiting clears unless another
question or runtime wait remains. The original question stays in history and the
new message reaches the Harness unchanged, so the Harness decides whether it
answers the question, changes the task, or still requires clarification. No option
or authorization is inferred. Blocking tools return the answers already supplied
and leave unanswered fields empty. Async questions inject no additional answer
turn when nothing was answered; genuine answers already collected from a partial
batch still reach the Harness, with remaining questions marked unanswered. Rejected inputs preserve the pending question. A concurrent answer, a new
question, an internal reference or a duplicate receipt cannot retire a different
question. Already running detached hosts keep their loaded implementation until
their run finishes; restarting the controller does not upgrade those hosts.

The broker still supports an explicitly configured finite timeout, with the
fallback disclosed before waiting. Such a deadline updates the original
question in place and records any fallback as a system default, not a user
answer; a question without options returns unanswered. Existing questions keep
their recorded deadline. Native tool replies identify timeout defaults, so
silence cannot be mistaken for user consent. Native secret
inputs are not accepted through ordinary chat. Permission approval requests are
separate from question tools and remain denied.

Codex Plan-mode `item/tool/requestUserInput` requests receive JSON-RPC answers.
Default-mode `request_user_input_async` emits an async `agentMessage` with
structured questions; its answers are delivered as native user input, using
steering while running or a new turn after inference finishes. Claude
`AskUserQuestion` uses the stdio `can_use_tool` callback with `updatedInput.answers`.
The native host remains available until questions and their resulting work finish.
No instructions asking the model to manage these surfaces are added.

The detached host owns the deadline and `native-question.json` pointer, and
journals answers in `native-questions/`. Controller restarts preserve the waiting
question and deadline. Input receipt identity prevents a repeated reply from
answering twice; captured answers arriving after their question expires are not
forwarded as unrelated instructions. Stopping the run cancels pending questions.
These guarantees cover controller restart, not replaying tools after a native
process crash.

Web buttons and Feishu callbacks submit to the same messages endpoint with an
explicit `nativeQuestionId`. An old or ended question returns HTTP 409
(`QUESTION_EXPIRED`), never a new model task or an answer to a different question.
Authenticated Web users can answer a pending question in a group-feed Session;
ordinary Web writes to those Sessions remain blocked. Feishu callbacks check the
durable card receipt, source route, original chat, tenant and actor access policy.
Answers and timeout events remain in raw history for audit, while the transcript
projects them onto the original question. Terminal Feishu cards remove controls.
The Connector stores creation receipts and content hashes: restart/replay updates
the existing card; it cannot create a late notification when no original exists.
An uncertain creation is fenced rather than automatically sent again.

## Ownership and recovery

The main process owns request identity, source context, attachments, history and
reply delivery. It does not choose a tool-result boundary or inject fabricated
tool results to make steering possible.

The detached sidecar owns the native process's stdin/stdout and a private local
control socket. Losing or restarting the main process does not close this
channel or stop the Harness's active tools. On native settlement the sidecar
closes the process; the next independent run uses the existing native session
resume mechanism. This is a bidirectional connection for active work, not a
second permanent chat service.

Additional requests keep independent request/response IDs and reference the
execution through `nativeDispatchRunId`. Their input text, attachment references
and source Context are recorded before transport. Requests consumed by one
execution normally share its final result. The authorized Feishu routing pilot
uses a versioned per-input exception: each protocol-2 input saves its own topic
handoff or explicit local reply, and an unhandled additional input remains
incomplete rather than inheriting the root answer. See
[the pilot reply contract](session-work-awareness.md) and the
[human-facing experiment flow](architecture-atlas/output/routing.html). The root request atomically reserves reply
destinations, so the same conversation gets one final reply while distinct
destinations still receive their result.

Visible child delegation publishes its creation notice using the invoking Run's
saved reply destination, independently of the eventual Harness final answer.
The delegation API and CLI return `noticeDelivery` beside the child Session and
Run receipt; a notice enqueue failure must not be mistaken for a failed child
creation or retried as a new delegation. See the
[visible delegation workflow](platform-skills/session-delegate.md).

Each sidecar journals native input as `dispatching`, then `accepted` or a
definite `rejected` result. Retrying a requestId reads the receipt or joins the
original pending acknowledgement. A lost acknowledgement is never converted
into a fresh model run. If the sidecar dies with an uncertain receipt, that input
fails explicitly instead of replaying potentially side-effecting work. A definite
native rejection fails only that input and leaves the existing task running.

Cancellation stops new handoffs into the cancelling execution. Already accepted
native inputs remain part of that execution; the Harness owns interruption of
its tools. The sidecar retains bounded process termination as a fallback when
the native interrupt cannot finish.

## Completion and streamed output

Native lifecycle events determine completion. A single `turn.completed`, Pi
`agent_end`, Claude `result`, or Antigravity `result` is insufficient if the
Harness has more work.
RemoteLab does not terminalize native runs from intermediate spool status events.
This also lets native error recovery finish before RemoteLab declares failure.

Codex preserves native item IDs, tool events and raw text deltas; the existing
transcript continues to publish finalized text items. Reasoning summaries stream
with projection state for replay deduplication. Pi retains its structured
tool/text/thinking events. Claude tracks input UUIDs and acknowledgement events;
`queued_turn_count: 0` alone does not establish that all submitted messages have
finished. Thinking projection state survives observer restarts, and cumulative
Claude cost is converted into per-result deltas. Antigravity preserves official
conversation IDs across detached runs, projects completed response and tool
steps, and derives per-turn usage from step usage instead of the protocol's
cumulative conversation totals.

The implementation uses Harness integration protocols. It does not depend on a
particular model's `async` tool flag or promise that arbitrary inference streams
can be mutated after a request has started.

## Feishu ingress

The connector already returned after main-service admission. It now dispatches
immediately on durable receipt and HTTP completion, and independent topics in
one chat no longer share an input slot. Short shared-index writes are serialized
to preserve bindings under concurrency.

The connector retains durable transport retry and same-topic ordering through
attachment preparation and HTTP admission. These protect `/mute`, model commands,
first-thread binding and exact retry payloads. They never wait for model output.
Moving raw upstream attachment ingestion into the main process would be a
separate transport architecture change; it is not required for active Harness
input. See [Feishu ingress verification](../notes/current/feishu-ingress-dispatch/verification.md).

## Verification and activation

`npm test` includes native protocol, transport, request dispatch, detached
recovery and connector regressions. The native-only gate is
`npm run test:native-harness`; Antigravity protocol coverage also runs through
`npm run test:antigravity`.

Optional real CLI tests use isolated homes, dummy credentials and loopback mock
model APIs, with the first inference held while another message is submitted:

```sh
REMOTELAB_NATIVE_CODEX_BIN=/path/to/codex \
REMOTELAB_NATIVE_PI_BIN=/path/to/pi \
REMOTELAB_NATIVE_CLAUDE_BIN=/path/to/claude \
npm run test:native-installed
```

Question handling is additionally validated against Codex CLI 0.159.2 and
Claude Code 2.1.282 with loopback model fixtures. General input validation
includes Codex CLI 0.153.4, Pi 0.85.0, Claude Code 2.1.267,
and Antigravity CLI 1.2.7 (installed and auth-gated on 2026-09-20). Tests
establish actual CLI protocol behavior against simulated model responses; they
are not production Feishu or live-model acceptance tests.
Older Claude versions can acknowledge at the replay/consumption boundary rather
than immediately; the driver still writes later inputs without waiting on that
acknowledgement. Older CLI versions in general are not certified by these tests.

Activation is an instance-specific step. Before activation,
retain the known-working checkout and a maintenance shell, advance the intended
instance to the verified main commit, restart only that instance, and check a
real follow-up while its Harness is running. Do not treat publishing the source
commit as proof of deployed behavior.

Official protocol references:

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Pi RPC](https://pi.dev/docs/latest/rpc)
- [Claude native questions](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Antigravity headless mode](https://antigravity.google/docs/cli/headless/)

## Codex account allocation

Optional [Session account allocation](codex-session-routing.md) distributes new
Sessions across the instance’s logged-in accounts. Healthy Sessions retain account
affinity across turns and restarts. With automatic switching enabled, unavailable
bindings migrate; quota/rate-limit failures resume the saved native thread on another
eligible account after the failed provider process stops. Each subscription is tried
once per Run. Model and reasoning settings stay unchanged, and completed tool
results remain in the saved thread. No fresh-thread replay occurs after work has
been produced. Pool exhaustion ends the attempt with an explicit failure.

### 已确认的跨群转交

个人分流试点的任务转交复用原生问题。来源 Harness 展示服务端生成的完整转交预览和“确认转交／暂不转交”按钮；服务端按当前待答问题核对预览与草稿后解析本人的选择，既不相信 Agent 提供的批准字段，也不把普通追加或沉默当作确认。飞书按钮回调保留作者和点击时间，重复回调复用首次接收记录。过期或已变化草稿保持未发送，并在来源说明失败。具体范围及回传见 [工作认知与分流](session-work-awareness.md)。

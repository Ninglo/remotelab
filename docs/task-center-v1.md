# Operations and Automations v1

The sidebar entry is **Monitor** (监控器), with Overview, Usage analysis, Automations and Feedback tabs. Overview is the default; `?tab=tasks&monitor=automations` opens the existing automation view directly. Automations retains its existing controls. Overview joins resource and runtime observations; see [Monitoring](monitoring.md). Project tasks and daily reports stay in their existing Markdown and publication workflows, without another application entry. Existing `tasks` tab URLs, component IDs, and `/api/automation-tasks` paths remain stable.

This is the authenticated control surface for RemoteLab's durable automated tasks. It is a top-level application workspace, separate from the ordinary Session transcript. The first version is deliberately a projection and control facade over the existing trigger and recurring-schedule stores; it does not add another scheduler, systemd producer, or workflow engine.

## Compact flow explanations

Inside **Monitor → Automations**, an instance can show a small flow panel above the existing task list. System monitoring, memory, progress tracking and knowledge discovery each show input and reuse explanations, then peer task rows with start → processing → write destination → delivery timing and recipient. Links open the original resources. “Related tasks” filters the original list by task ID, including packaged members; it does not create a duplicate list or alter a producer. Lifecycle filters or “Show all tasks” clear this local selection. Records, runtime settings and lifecycle controls remain on the original cards; result-relay controls also appear alongside delivery explanations. Task purposes are grouped for display into monitoring, memory, progress and knowledge, with an unclassified fallback; persisted purposes are unchanged.

The optional instance file `CONFIG_DIR/automation-flows.json` holds version 1 and `groups` with IDs `operations`, `memory`, `tracking`, `knowledge`. Optional `language` (`zh-CN` or `en`) keeps the explanation labels and schedule text in the same language as the instance-authored content without changing browser language preferences. A row can put exact storage paths in `writeDetails`, shown under “File locations”, while `write` stays readable. Each group has an optional instance-authored `title`, `read`, optional `readAt` (a human explanation, not a second schedule), optional `note`, and `rows`. A row has `title`, `taskIds`, optional `backgroundIds`, optional `trigger` (the reviewed business condition, separate from cadence), `process`, `write`, `send`, optional `note` and HTTP(S) `links` (`title`, `url`). The `definitions` map stores `automationDefinitionHash(task)` for each bound task after its explanation is reviewed. The hash covers instructions, cadence, admission gate, idle wake/policy, execution target and result delivery, excluding changing run counters. Schedule times and lifecycle status always come from the current task projection. Background references reuse the existing mechanism projection and `automationBackgroundHash` of its ID, title, trigger and note; changing observation state does not invalidate the explanation. Missing or revised background definitions need review too. Background-only rows open the existing monitoring overview, without introducing another collector or alert sender. The input block describes reuse without implying that every row shares one completed read. Each task has four aligned stages, with arrows only within that task; narrow containers stack the same stages vertically. Group scope and proposed changes appear above the tasks, and row caveats remain visible. Session continuation mechanics are collapsed below the two execution/history links and preserve their expansion state during refresh. Missing or changed definitions show a review notice; absent configuration hides the panel, while invalid/unreadable configuration shows a warning without blocking the original list. The authenticated task API adds the read-only `automationFlows` projection. Descriptors contain human explanations, not executable instructions or another scheduler. Instance destinations and personal details never belong in shared source examples.

A group may also include a `plan` to explain a proposed or accepted data flow in place of the peer-row overview. The plan has `title`, an explicit human-authored `status`, `summary`, `footer`, and ordered `stages`. Each stage has a `connector` explaining its dependency, an optional `kind` (`shared` or `delivery`), and up to four parallel `nodes`. Nodes contain a `label`, `title` and plain-text `lines`. Shared artifacts are rendered distinctly from processing steps. Connector wording must name which results are reused; parallel consumers must not appear to be dependencies of an unrelated downstream step. All content is bounded plain text, never HTML or executable workflow configuration.

With a plan, the original rows move into “Current tasks and execution records” beneath the diagram. This keeps actual schedules, changed-definition warnings and existing run/history links separate from intended behavior. The disclosure preserves its open state across refresh and tab changes. Narrow screens stack nodes without shrinking the text. Updating a plan changes only the explanation; its status must explicitly state any remaining execution changes. It must not imply a scheduler dependency or a successful read merely because an arrow is shown.

Updating this presentation does not apply a proposed time change, merge tasks, reopen a consumer, change Session/context policy or send notifications. Planned changes must be marked in notes, separate from the current schedule. The explanation is not evidence that a run read, wrote or delivered anything; actual records remain in the existing execution history.

## Delivery details and controls

Flow rows may add `delivery: { recipient, condition, format, content, control }`, bounded plain-text explanations reviewed against the task and its business workflow. The default overview shows the start condition first, then the result destination beneath every task title, without expansion. Conditions combine the live schedule with the reviewed row `trigger`; a periodic check is not described as an unconditional AI run. Flow views put the destination list before the longer diagram; each destination stays visible while sending details are collapsed. Task cards and flow summaries use the same condition → result order. Explain stored files, sites and records by their actual output; do not add a redundant “no group message” badge for workflows that save locally. Sending conditions, format, content and controls expand separately. Recipient names are resolved from matching route/chat Session source metadata (newest known name); unresolved names are explicitly labelled instead of presenting an ID as a name. A workflow-owned sender is not described as “RemoteLab only” merely because its platform relay is absent. For tasks without reviewed descriptions, link to the original task instructions instead of inferring a business destination. Audit all active and scheduled entries, including workflow-owned senders and newly registered tasks; tasks with different actual recipients need separate descriptions even when they share a report program.

Tasks with a configured conversation have a separate **automatic result relay** switch. Authenticated `PATCH /api/automation-tasks/:id/delivery` takes boolean `enabled` and `expectedRevision`; conflicting edits return 409. `deliveryControl` projects support, enabled state and revision. Settings and a bounded change history are stored in instance-owned `automation-delivery-settings.json`; changing this setting preserves the task, target, schedule, instructions and saved results. It does not enable a missing recipient.

The scheduler reads the current parent task setting when admitting an occurrence, including occurrences created before the setting changed. Disabled relay sets the existing `suppressSourceDelivery` request option. Already admitted requests retain their delivery snapshot; no queued message is retracted or resent. Independent workflow tool/script sends and separate alerts are outside this switch and are labelled as such. Missing settings preserve existing behaviour; unreadable settings fail closed. The UI does not toggle production settings simply by displaying or testing a task.

## Timeline in the original automation tab

Automations presents Overview, Flows and Task details as three peer tabs, with only one visible at a time. Overview opens by default; selecting a related task switches to Task details and retains the targeted filter. Switching views and refreshing retain expanded rows and flow selection. The tabs support arrow keys, Home and End.

The timeline, flow descriptions and task list share the same centered 880px reading column as Monitor navigation. The timeline uses the complete task projection, independently of task-list filters. Active daily cron schedules with numeric hours and minute are expanded into sorted daily time groups (including both occurrences of a twice-daily task); time zones stay explicit. Intervals and other cron expressions retain their cadence and next occurrence rather than being guessed into daily times. Pending/running one-time work is listed by its actual scheduled timestamp; accepted runs whose retained state cannot be verified stay discoverable in the original task records.

Rows distinguish direct AI starts from condition checks, show current producer/business state, and expand to the next run and existing write/delivery explanations. Missing explanations link to the original task rather than invent destinations. A separate expander covers all registered background mechanisms including disabled ones; it makes no completeness claim for unregistered OS services. Stopped and finished records remain in the original list. Refresh preserves expanded timeline rows. The view is a schedule, not an execution/completion promise. Reading it makes no writes, collector or model call. Only an explicit delivery-switch action changes result-relay settings, with the scope described below.

## Automation Session collection

The Session selector has an **Automations / 自动化** collection alongside People and
Feishu group chats. Participation is explicit: a schedule or trigger template
sets `sessionCollection: "automations"`. New `scheduled_execution` Sessions
inherit that marker. Unselected internal Sessions remain hidden as before;
ordinary People lists exclude collected runs. Archived runs retain their marker.
Opening a collected Session, including a direct URL restored before the sidebar
loads, selects the collection automatically.

The automation API projection exposes the template's `sessionCollection`.
Opted-in task cards and flow rows link to the newest retained execution Session,
not the source discussion. Before the first execution, the card explains that no
execution is available. Execution history retains all its existing links.

For an authorized migration, snapshot the selected schedules and existing
execution Sessions. Patch only selected `sessionTemplate.sessionCollection`, and
use `PATCH /api/sessions/:id` with `sessionCollection: "automations"` for eligible
historical executions. The API rejects human/group-feed Sessions. Check trigger
associations too: never move a discussion or a Session shared with excluded work.
Empty `sessionCollection` removes the marker. Pending occurrences retain their
captured templates and must be reviewed separately. Collection membership does
not change execution reuse, cadence, ownership, delivery or authorization. There
is no implicit migration of all tasks, and no automatic cross-topic edit routing.

## Task browsing and failure diagnosis

The default automation list shows **current tasks**, with compact summaries of cadence, next trigger, last execution and failures in the last seven days. Task enablement and execution health are separate: an enabled schedule can have a failed run, while a successful latest run does not erase earlier failures. Attention and recent failures sort first; the failure filter includes both. A historical admission without a retained Run is unverified, not an active job.

Open a task to see its newest-first trigger timeline. The read-only `GET /api/automation-tasks/:id/executions?limit=25&cursor=trg_...&status=all|failed` paginates durable triggers with a stable cursor and can scan past successful pages to find failures. Every row retains its scheduled time, actual state, full recorded error, Run ID and execution Session link for logs. Check errors before admission appear separately using the latest retained scheduler error; the application does not invent a history of checks the store did not retain. Settings and lifecycle controls remain inside each task.

Historical one-time triggers with an identical source Session, title, instruction, execution target, result destination and creator may be folded into one display group. The original records remain intact; current one-time triggers and distinct schedules are never merged. Display groups never receive lifecycle actions. History and all-task filters retain access to old records with progressive loading.

The sidebar uses **Operations / 运行中心** and exported allowance snapshots use **Operations overview / 运行概览**. Existing Overview and Automations tabs, `tasks` URLs and API paths remain stable. Test previews must go to the requesting person or the current conversation; group delivery uses only the separately accepted production workflow.

## Product boundary

RemoteLab owns generic automation mechanics:

- when automated work should be admitted
- which Session receives the instruction
- whether each occurrence gets an independent Session
- where the resulting reply may be delivered
- durable admission, retries, status, and safe lifecycle controls

The execution Session still interprets the instruction and decides the concrete work. Task Center does not know evaluation, GPU, report, inbox, or other domain semantics.

Settings remains the place for instance configuration. RemoteLab uses one persistent, ChatGPT-style sidebar: New Session and Operations sit above the Session list, while Settings sits below it. Selecting a Session, Operations, or Settings swaps the main workspace inside the same application document; there is no second application rail and no template-management destination. Operations and Settings share the same flat, readable main-canvas geometry and never insert management cards into a Session transcript. The sidebar shows the product brand only in the global header, keeps origin filtering next to the Session list, and does not spend primary space on build metadata. The URL query remains shareable/restorable UI state rather than a separate page load.

There is no per-Session template selector or preferred-template browser state. New Sessions start from the selected tool/runtime only. Interactive template objects and shared-guest routes do not exist in the v1 product model.

## Domain model

`AutomationTask` is a read model rather than a third persisted producer:

| Task kind | Durable source | Stable ID |
| --- | --- | --- |
| `one_time` | one at-time Trigger | `trg_*` |
| `recurring` | one recurring Schedule plus its occurrence Triggers | `sch_*` |

The public projection keeps the existing `trg_*` / `sch_*` identity and makes cadence, lifetime, admission, execution, and delivery independent dimensions:

```json
{
  "id": "sch_...",
  "kind": "recurring",
  "title": "Weekday review",
  "prompt": "Review the project and choose the next action.",
  "createdByIdentityId": "identity_...",
  "state": "active",
  "schedule": {
    "type": "interval",
    "everySeconds": 30
  },
  "lifetime": {
    "mode": "bounded",
    "maxExecutions": 5
  },
  "gate": {
    "mode": "script",
    "runtime": "bash",
    "snapshotSha256": "...",
    "timeoutSeconds": 5,
    "cooldownSeconds": 60
  },
  "target": {
    "mode": "new_session",
    "sourceSessionId": "..."
  },
  "resultDelivery": {
    "mode": "remotelab"
  },
  "alerts": {
    "mode": "remotelab",
    "on": ["gate_error", "execution_failure"]
  },
  "counters": {
    "checks": 18,
    "matches": 3,
    "admittedExecutions": 3,
    "remainingExecutions": 2
  },
  "nextRunAt": "...",
  "lastExecution": {
    "state": "completed",
    "runId": "run_...",
    "sessionId": "..."
  },
  "recentExecutions": [],
  "actions": ["pause", "cancel"]
}
```

There are two explicit execution modes:

- `fixed_session`: every occurrence submits its wake-up instruction to the selected existing Session. Normal Session queueing remains authoritative, so overlapping work is serialized there.
- `new_session`: the selected Session supplies explicit provenance and starting context. Every occurrence creates an independent execution Session through the existing scheduled-session path.

Legacy `calendar_day` schedules remain visible and are projected as `calendar_day_session`; Task Center does not rewrite them.

### Creator attribution

Task ownership is a UI attribution label, not a separate runtime user or an access-control boundary. A task created in the browser belongs to the signed-in Person. A task created by an Agent or connector through service authentication inherits the Person attached to its source Session. Recurring occurrences keep the task creator instead of becoming owned by the scheduler, and every newly created execution Session inherits the same identity. `System` remains an internal fallback for genuinely senderless maintenance work but is not exposed as a Person in the user-facing directory.

`createdByIdentityId` is fixed at creation time. Selecting another Person's Session as the execution target does not transfer task ownership; it only chooses where or from what context the work runs.

### Model policy

Task Center, one-time triggers, recurring schedules, and their CLI commands share `runtimePolicy`:

- `auto` (the default when creating a task without runtime overrides): every new execution Session starts from Auto. A reused fixed or calendar-day Session retains its own profile. The legacy value `follow_default` is accepted and normalized to `auto`.
- `fixed`: persist a complete profile. Explicit `tool`, `model`, `effort`, or enabled `thinking` implies this policy unless `runtimePolicy` is specified. Task Center can pin the selected template Session's profile; the API/CLI can specify any supported runtime.

The task card shows the policy and the last execution's resolved profile. `PATCH /api/automation-tasks/:id` accepts runtime settings; switching to `auto` clears saved overrides. The same fields work on the trigger and schedule APIs. CLI creation accepts `--runtime-policy auto|fixed`.

Occurrence triggers preserve `executionRuntime` before creating their Session/admitting their request. Retries and restarts retain that snapshot, and already admitted requests retain their existing options. Updates to a schedule affect future occurrences, not already materialized triggers or running requests.

For legacy records, empty runtime fields and `follow_default` become `auto`; nonempty profiles remain `fixed` because older records do not distinguish explicit choices from creation-time snapshots. Historical completed requests and their model evidence are not rewritten.

### Cadence and lifetime

Recurring tasks support either:

- `schedule.type = cron`: a five-field cron expression plus IANA timezone
- `schedule.type = interval`: `everySeconds`, with a current minimum of 10 seconds

Restart and delay handling remains `latest_once`: a delayed interval does not replay every missed check. It evaluates the latest due occurrence once and records the missed count.

Lifetime is independent of cadence:

- `continuous`: keep checking until paused or cancelled
- `bounded`: stop at the first configured bound: `maxExecutions`, `maxChecks`, or `endsAt`

`maxExecutions` counts only occurrences durably admitted into the normal Agent Run path. A script check that returns no, a gate error, or a skipped overlap does not consume it. The scheduler also reserves at most the remaining finite capacity while admission is pending, then reconciles the Schedule to terminal `completed` from durable Trigger records.

### Admission gate

`gate.mode = direct` materializes a normal Trigger whenever the cadence is due. `gate.mode = script` first runs a snapshotted Bash, Python, or Node script. The script must print exactly one of:

```text
yes
no
```

or one JSON object:

```json
{"trigger":true,"reason":"revision changed","dedupeKey":"revision-42"}
```

Errors, timeout, non-zero exit, excess output, and malformed output all fail closed: no Agent Run is admitted. `dedupeKey` prevents repeated matches for the same observed state from producing another Trigger. `cooldownSeconds` can suppress checks between recent matches. Gate source is persisted as the immutable creation snapshot and its SHA-256 is exposed in the read model; source text is not returned by Task Center APIs.

Gate scripts are trusted local automation, not a sandbox. They run as the RemoteLab service user, with a reduced environment and a 30-second maximum timeout. Do not embed secrets in script source; use an explicitly provisioned local credential mechanism when required.

### Results and alerts

Execution, result delivery, and alert policy are separate fields:

- `resultDelivery.mode = remotelab` keeps the result in RemoteLab. For fixed Sessions this explicitly suppresses inheritance of an existing external conversation.
- `resultDelivery.mode = source_conversation` snapshots the selected Session's connected source through the existing conversation/source-delivery contract.
- `alerts.mode = remotelab | none` stores an alert policy independently from result delivery. Task health and durable errors remain inspectable in Task Center either way. This first implementation does not yet run a proactive or external alert fan-out worker, so it does not claim alert delivery receipts.

`notification` remains a compatibility alias for `resultDelivery` in requests and responses.

The execution Session remains the durable work record in both cases. Connector delivery is only a projection of the result.

## HTTP API

All routes require authentication and are available to every authenticated Person.

### List and inspect

- `GET /api/automation-tasks`
- `GET /api/automation-tasks/:trg_or_sch_id`

The response joins Schedule/Trigger records with current Run state. A Trigger marked `delivered` means its request was durably admitted; the execution's `running`, `completed`, `failed`, or `cancelled` state comes from the Run and is kept separate.

### Create

`POST /api/automation-tasks`

One-time example:

```json
{
  "kind": "one_time",
  "title": "Review later",
  "prompt": "Re-open the evidence and decide the next step.",
  "scheduledAt": "2026-09-20T01:00:00.000Z",
  "target": {
    "mode": "fixed_session",
    "sessionId": "..."
  },
  "notification": {
    "mode": "remotelab"
  }
}
```

Recurring direct cron example:

```json
{
  "kind": "recurring",
  "title": "Weekday review",
  "prompt": "Review the project and choose the next action.",
  "schedule": { "type": "cron", "cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai" },
  "lifetime": { "mode": "continuous" },
  "gate": { "mode": "direct" },
  "target": { "mode": "new_session", "sessionId": "..." },
  "resultDelivery": { "mode": "remotelab" },
  "alerts": { "mode": "remotelab", "on": ["gate_error", "execution_failure"] }
}
```

High-frequency finite gated example:

```json
{
  "kind": "recurring",
  "title": "Change monitor",
  "prompt": "Inspect and report the state that changed.",
  "schedule": { "type": "interval", "everySeconds": 30 },
  "lifetime": { "mode": "bounded", "maxExecutions": 5 },
  "gate": {
    "mode": "script",
    "runtime": "bash",
    "source": "./local-check-command --json",
    "timeoutSeconds": 5,
    "cooldownSeconds": 60
  },
  "target": { "mode": "fixed_session", "sessionId": "..." },
  "resultDelivery": { "mode": "remotelab" }
}
```

`target.mode = new_session` uses the selected `sessionId` as the explicit source Session. Top-level `cron`, `timezone`, and `notification` remain accepted for compatibility.

### Lifecycle actions

- `POST /api/automation-tasks/:id/pause`
- `POST /api/automation-tasks/:id/resume`
- `POST /api/automation-tasks/:id/cancel`

The API returns the refreshed task plus any occurrence-cancellation counts.

## State and stop semantics

Task-level states are intentionally small:

- recurring: `active | paused | completed | cancelled`
- one-time before admission: `scheduled | paused | failed | cancelled`
- admitted one-time execution: the underlying Run state, such as `accepted | running | completed | failed | cancelled`

Lifecycle behavior:

| Action | Future schedule admission | Materialized but unadmitted occurrences | Already admitted Run | Reversible |
| --- | --- | --- | --- | --- |
| Pause | blocked | cancelled | continues | yes |
| Resume | enabled from `paused` | not recreated; next valid occurrence is recomputed | unchanged | n/a |
| Cancel | blocked permanently in Task Center | cancelled | continues | no |

`completed` is an automatic, terminal state for bounded tasks. Like cancellation, it does not terminate an occurrence already admitted into a Run.

Pause/cancel and Trigger admission are serialized through the Trigger mutation queue. Whichever operation wins that boundary is authoritative: if stop wins, the request is not admitted; if admission wins, the resulting Run is allowed to finish. The Task Center UI intentionally does not expose `includeActive` Run termination.

This distinction is visible in the interface copy. `paused` or `cancelled` is never presented as proof that an already running process has stopped.

## Compatibility and limits

- Existing `/api/triggers`, `/api/schedules`, and CLI commands continue to work.
- Existing `PATCH enabled:false` behavior remains a terminal cancellation for compatibility; Task Center uses the explicit `status: paused` path when pausing.
- Cancelling preserves the durable task record for audit. The v1 UI does not delete tasks.
- Editing routing in Task Center and arbitrary external alert-target authoring are deferred. Create a replacement task when execution or delivery routing must materially change.
- Task Center only inventories RemoteLab Trigger/Schedule producers. An unrelated systemd timer or standalone watcher is not silently claimed as managed.
- Recurring policy is `latest_once`, with one open occurrence by default; v1 does not add a workflow DAG or business-specific rule engine.
- Agent-facing creation is available through the existing authenticated Task API and the converged `remotelab schedule` CLI. The CLI supports `--every`, `--times`, `--max-checks`, `--until`, and `--gate-file`; it does not expose raw persistence operations to the Agent.

## Implementation map

- Projection and lifecycle facade: `chat/automation-tasks.mjs`
- Existing producers: `chat/triggers.mjs`, `chat/recurring-schedules.mjs`
- Fixed/new Session contract: `lib/scheduled-session.mjs`
- Authenticated routes: `chat/router-control-routes.mjs`
- UI: `static/chat/task-center.js`, `static/chat/task-center.css`, `templates/chat.html`

## Stable automation home (explicit opt-in)

Handoff: “Create this non-evaluation automation with independent execution and a
stable home forked from its source. Record the actual creator, original creation
time, objective, authorization/output boundaries and failure recovery rules.
Preserve the task ID and delivery targets. Check task → home → task and history
links. Adopt later definition changes only after the authorized human confirms.”

A home is an independent task-context fork with `internalRole: automation_home`
and `forkContextMode: task_brief`, collected under
Automations. It is a fixed reading/discussion entry, not the worker queue. Existing
per-occurrence/calendar-day execution stays intact. Linked workers disappear from
the collection list but remain directly accessible through the home history.
The home header links to the exact task using `?tab=tasks&monitor=automations&task=ID`,
each execution, and the original discussion under a secondary reference disclosure.
The primary task link reads “Open automation session”; the home return link names
the Automations page. Task detail, timeline and flow views
link back to the home. Stopped/deleted tasks retain their home and definitions.

- `POST /api/automation-tasks/:id/home` idempotently establishes a home for a task
  already explicitly marked `sessionTemplate.sessionCollection: automations`.
  It accepts an optional `brief` with concrete maintenance/recovery instructions.
  Only the explicit task prompt and maintenance brief are injected. Parent transcript,
  model context/usage, resume state, agreements and connector binding are not copied.
  Source lineage remains recorded; ordinary conversation forks still copy history.
  The new transcript begins with a short handoff receipt, not old discussion.
  To migrate an older full-history home, send `replaceSessionId` matching its
  current binding. The operation retains definitions, runs and lifecycle events,
  rebinds only that task’s independent workers and archives the old home without
  deleting its history. Repeating a completed migration returns the same new home.
  No model or business execution is started by this operation.
- `GET /api/automation-tasks/:id/home` reads definitions, change events, live native
  execution projections and retained trigger snapshots, without queuing a model.
- New unified task creation accepts `automationHome: true` and optional `homeBrief`,
  only with `target.mode: new_session`. Raw Schedule/Trigger creation opts in with
  the collection marker. Existing/evaluation tasks are never globally opted in.
- If task creation succeeds but its source cannot yet be forked, creation returns
  201 with `homeError`; retry only the home endpoint, not task creation.

`automation-homes/<taskId>.json` under the instance config directory keeps the
binding, immutable definition revisions, authenticated API-actor attribution,
change/stop events and per-trigger input snapshots. Client-provided discussion
references are explicitly **reported, unverified** provenance, not authority.
The creator recorded by the original task is not necessarily the human proposer;
unknown historical authors and versions are not reconstructed from guesses. Corrupt
home records fail visibly rather than being replaced; independent task records use
separate mutation queues.

At first admission each selected worker receives a bounded home/task/version
reference in addition to its original prompt. Its input definition is retained;
retry uses that association, and future schedule edits do not rewrite it. Source
conversation history is not appended to each run. Failure/dedup instructions are
model guidance; the original business receipt remains the authority for writes
and delivery. The home uses native Trigger/Run state; model completion is not
business acceptance. Historical rows without captured versions say so.

HTTP task/schedule/trigger edits record definition revisions and lifecycle events.
Natural completion is recorded when observed with an explicitly labelled
observation timestamp. Both the current task state and active executions remain
visible: pausing/cancelling future triggers does not assert active runs stopped.
Shared instance authentication still applies; this feature does not add a new
per-task authorization system or automatically route every conversational opinion
into a task edit. Humans can discuss elsewhere, confirm a concrete adjustment,
and have it applied to the same task with the source/reason recorded.

## Conditional experience review

[Dreaming](dreaming-automation.md) reuses this same Schedule, idle-event wake, script
gate and execution-hook path. It incrementally reviews explicitly configured
project material, retains source-backed candidates and later validation, and is
shown as a peer task in the memory flow. Its instance-local activation does not
resume old bounded trials or block daily report publication.

## Routine monitoring reads

The monitoring observer uses a separate current-health projection from the same
Schedule, Trigger and Run/Request records. It does not build this page’s complete
execution history, package lineage or ownership enrichment on every check. The
Task Center still retains those details and full history. See [Operations overview](monitoring.md#routine-task-health-reads) for collection scope and failure semantics.


### History versus running Session

For opted-in automations, expanded timeline and flow rows expose two distinct
entries: **View execution history** opens the retained trigger timeline directly;
**View run Session** opens an active execution when one is present in the current
projection, otherwise the most recent retained execution Session. Before any
execution Session exists the latter is disabled. Neither action starts work.
The history page retains a separate **Task home** link for instructions and
changes; that home is not labeled as an actual execution.

A short transition line explains trigger → execution record → run Session →
recorded result. Latest-run timestamps use the same task timezone as the schedule,
even when the browser language or timezone differs. Reuse comes from the projected target: calendar-day tasks reuse
one Session within the configured timezone's day and create another on the next
day; fixed targets keep the configured Session. Other tasks execute independently
of their source discussion, with actual Session associations recorded per run
(including any connector-bound reuse). The home history marks multiple records
sharing a Session. Flow controls follow the flow description language, avoiding
mixed-language buttons within a Chinese task card. Runtime configuration and
evaluation collection membership are unchanged.

自动任务页在任务数据旁提供默认折叠的“何时提醒、怎么处理”：展开可看失败提醒条件、补救边界、原执行会话及结果出口。说明复用监管快照，不增加执行器；页面刷新保留展开选择。磁盘、账号、API、服务和用量说明分别放在各自数据旁，不再在基础资源顶部排列说明卡片。

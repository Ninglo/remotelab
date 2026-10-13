# Operations overview

Monitor Overview (`?tab=tasks&monitor=overview`) presents Session, shared resources, and API in that order. The default view shows current summary metrics and named anomalies; details expand on demand. Resources contain only disks, account allowance, and Token consumption. Historical charts use recorded samples, never invented daily totals. Automations, settings, project tasks and their controls retain their existing separate views.

## Inspection scope and cost labels

The overview's “检查范围与开销” panel distinguishes the independent periodic
observer, on-demand Session/usage queries and incident-driven alerts/recovery.
It explains local script work, model Tokens and recorded Feishu API calls
separately. Background Tokens include other background operations and are not a
monitoring-only bill; CPU/memory/local-read costs have no continuous aggregate yet.
The panel does not extrapolate an old benchmark into current costs.

Observer registration comes from the existing `resource-alerts` entry in
`automation-background.json`. Cadence is verified from its timer in the configured
service observations (same systemctl call, no extra polling). Only a verified
minute-only calendar receives “每分钟”; other/unknown schedules remain unverified.
A missing registration or unavailable timer never appears as an enabled minute
observer. Last completed observation comes from the alert ledger, separately from
page query generation time; a minute observer with a record older than three
periods gets a stale-record note. Merely viewing the panel starts no monitor,
model job, external API probe or new timer. Existing refresh/cache behavior stays.

## Capacity and seven-day charts

Disk rings show the observed percentage of capacity used, alongside the existing disk table. Account quota meters retain each independent allowance window; unknown quotas have no filled meter. Neither graphic is task completion or a combined account allowance.

Session has two always-visible seven-day lines: distinct Sessions with usage records (including background work), and average reported context Tokens per foreground Run. Token consumption has its own seven-day line in Resources, including foreground/background usage. These fixed charts cover seven UTC calendar dates including today, independently of the selected 1/7/30-day rolling summary window; today is partial. Context means use the latest recorded value per Run, not per-call input or prompt-injection bytes. Each chart exposes exact daily values and sample counts in a table. Missing days/contexts remain gaps, while a recorded zero remains zero.

The ledger deduplicates by Run and attributes each retained snapshot to its ledger timestamp (Run finalized/completed time, or recording time when unavailable). These are observed records, not a historical Session inventory, live usage completeness guarantee, or allocation of a multi-day Run's individual calls. Late records can revise a day. Session counts deduplicate within each day, not across days. Context coverage shows reporting foreground Runs over all recorded foreground Runs; tokens and Sessions show recorded Run counts.

`queryUsageLedger({ includeDailyTrend: true })` extends the existing file scan only as far as the first of those seven dates, aggregates `dailyTrend` from all matching records before top-N truncation, and keeps the selected-window totals and ranked lists unchanged. Overview returns this projection with its existing 15-second coalesced cache. Charts share the existing request, need no extra Run/manifest reads, model calls, quota RPCs, timers, notification or remediation actions. Frontend SVGs and meters add no chart library. Collection gaps remain explicitly visible.

## Session changes and automatic diagnosis

Session metric changes are neutral statistical clues, separate from the actual
running/idle state. The row disclosure holds ratios, evidence and diagnosis
history; opening/closing it survives data refresh. A longer task or larger
cumulative input alone is not a fault and does not start a diagnosis.

Opt in with `sessionDiagnostics.enabled: true` in `monitoring.json`. The existing
minute observer runs the bounded local analysis at most once per five minutes;
opening the page never starts it. No new timer or model call is created.
`node scripts/session-diagnose.mjs --dry-run` previews candidates without state
writes, sends or recovery admission.

Initial admission compares the same Session/model/Harness: three newest distinct
foreground Runs against 10–20 prior samples from the last seven days. Preparation
(including queue time) or launch must reach both 15 seconds and three times the
baseline median in all three Runs within 30 minutes. Three Sessions with a latest
qualifying sample within ten minutes also trigger a shared stage investigation.
Missing timestamps, background work, archived Sessions and duplicate Run IDs do
not qualify. Execution duration, context and cumulative input remain display-only
clues until measurements can separate normal work and waiting from failure.

The fixed diagnostic records stage, sample evidence, simultaneous service/disk/
account risks and links to existing recovery records. It distinguishes correlation
from a proven cause. It does not restart services, alter queues, modify prompts or
admit an additional model worker. Preparation substeps, active tool progress and
per-call input attribution remain gaps; unexplained cases say so explicitly.

One stage/model/Harness incident combines up to 20 affected Sessions; one new
analysis is admitted per observation. Unchanged evidence never reruns; changed
evidence has a 30-minute cooldown. The original incident stays open without new
traffic. Recovery requires three newer successful Runs below 80% of the original
threshold for each recorded member; natural recovery is not labelled a repair.
Retain at most 100 incidents, pruning resolved entries first; a full unresolved
store admits no additional incidents. Sampling is bounded to 1,000 recorded Runs
and 64 MiB per collection without reading prompt manifests. Coverage limits are
reported rather than treated as healthy samples.

Private trial delivery is configured separately:

```json
{
  "sessionDiagnostics": {
    "enabled": true,
    "notification": {
      "enabled": true,
      "profile": "approved-bot-profile",
      "configDir": "/path/to/existing/lark-config",
      "feishuAppId": "cli_approved_app",
      "openId": "ou_approved_recipient",
      "overviewUrl": "https://instance.example/?tab=tasks&monitor=overview"
    }
  }
}
```

Resolve the recipient from the same Bot's verified source identity. Group IDs are
rejected and the general monitoring group is never a fallback. A paused general
alert route remains paused. Cards contain stage/count and diagnostic conclusions,
not conversation titles or message contents. Each incident gets one private card;
changed conclusions and recovery edit it after verifying the original Bot and
chat. A recipient/profile change never redirects an old card. One notification
operation is allowed per observation. Write intent is durable before external
I/O; uncertain sends or edits require receipt inspection, not automatic replay.
The authenticated page shows delivery uncertainty in the affected row. The first
version reports completed fixed analysis and waits for new evidence; it never
claims a model is working or displays a nonfunctional approval button.

## Routine task health reads

The overview and independent minute observer use `readAutomationHealth`, not the
full automation browser projection. They keep all task identities, current
schedule/gate state and latest execution, including paused/cancelled tasks needed
for recovery attribution and unknown admissions. Recurring tasks resolve only
the latest occurrence (same stable timestamp ordering as the browser). One-time
tasks retain their existing Run/Request receipt fallback. No age cutoff silently
removes a task or substitutes a success for missing evidence.

Each collection shares pending Run/receipt lookups by Run ID, limits resolution
to 16 concurrent workers, and omits ownership/Session enrichment, prompts,
package lineage and full-history statistics. The cache ends with that collection;
late state corrections and recovery are read again next time. Source errors still
produce coverage gaps. Task-browser history, alert/recovery policy, timer cadence,
nightly review, evaluation reports and message context are unchanged. API log
scanning and historical recovery-log verbosity are separate remaining costs.

## Activate on an instance

Give the instance's coding agent this prompt, with the instance URL and approved sources and alert recipient:

> Enable Monitoring for this instance. Inspect its configuration directory, service user, account observer and report workflow. Connect only the supplied fleet state, disks and owned services in monitoring.json. Keep credentials and quota RPCs outside page requests. Merge routine observations into our existing daily report, preserving its source, comments, permissions and delivery. If urgent alerts are authorized, provision one independent no-model observer using scripts/monitoring-alerts.mjs, establish the known-incident baseline, and verify its service, timer and durable delivery state. Do not create another routine group report or separately maintained dashboard.

Existing connected accounts need no additional sign-in. Missing sources remain visible as gaps. New account authorization and external recipients must come from the operator; the feature does not infer either.

Optional instance-local `CONFIG_DIR/monitoring.json`:

```json
{
  "fleetStateFile": "/path/to/fleet/var/adapter-state.json",
  "autoRequestStateFile": "/path/to/fleet/var/auto-nudge-state.json",
  "disks": [
    { "path": "/", "label": "System disk", "system": true },
    { "path": "/data", "label": "Data disk" }
  ],
  "services": [
    { "unit": "owned-app.service", "scope": "system", "label": "Workbench" },
    { "unit": "owned-observer.service", "scope": "user", "label": "Account observer" }
  ],
  "criticalAutomationIds": ["sch_important_job"],
  "alertDelivery": {
    "profile": "approved-bot-profile",
    "configDir": "/path/to/lark-config",
    "chatId": "oc_approved_group",
    "ignoreUnits": ["own-observer.service", "own-observer.timer"],
    "overviewUrl": "https://instance.example/?tab=tasks&monitor=overview"
  }
}
```

Connect only explicit owned units, not unrelated users' services. Scope is `system` or `user`; only fixed service/timer names are accepted. Without configuration the overview still shows the local ledger, cached runtime accounts, native automations and root disk, without claiming fleet or independent-service coverage.

## Observation contract

### Responsibilities

Monitoring owns fixed-resource and execution health: account allowance, usage,
disk capacity, configured services, API dependencies and whether enabled
automations actually execute. Project review owns the interpretation of project
discussions and the creation/update of project Todos. The existing daily report
combines project changes, existing Todo changes and a monitoring snapshot; it is
a publication view, not another Todo generator. A project-review schedule shown
on Automations is supervised as a running job, not as project content.

On this instance the four project-group Todo scans remain independent jobs;
their group notifications were removed and useful changes feed the existing
reports. Consolidating publication does not establish that source reading is
shared or duplicate scans eliminated. Preserve the original scan cursors,
authorization, task list and private-review route when integrating those inputs.

Before classifying an automation failure, inspect its current lifecycle and
enabled flag. Paused, cancelled, finished or disabled tasks are not new runtime
faults and cannot authorize automatic resumption. A skipped condition is not a
failed execution: for example, an enabled scheduler with `consumer_disabled`
is checking a deliberately disabled business consumer. The schedule's switch,
business switch, Run outcome and result delivery have distinct meanings.

`GET /api/monitoring/overview?days=1|7|30` uses existing authentication and shared-instance rights. Partial failures preserve the remaining observations. Same-window requests coalesce for 15 seconds. The page refreshes when opened, explicitly refreshed, its period changes or it returns to visibility. There is no model call or periodic browser poll.

- Consumption comes from the instance ledger, with foreground/background work, cached tokens, daily trend and models. The rolling window is explicitly dated. Interface-reported costs and token-price estimates are separate; estimates are not subscription bills.
- Cached runtime and optional schema-v2 fleet observations are deduplicated by provider identity. Only ready samples within ten minutes qualify. Conflicting, stale, expired or missing observations stay unknown; a fresh source can replace a paused one. Any exhausted window makes an account unavailable, even if weekly allowance is full. Email labels are masked; credentials and raw source errors are not returned.
- Storage includes bytes and inodes. Root warns below 15 GiB or at 85% use and is critical below 8 GiB or at 92%. Percentage thresholds also apply to other disks and inodes. Paths sharing a filesystem are marked, never added together.
- Execution health includes recurring tasks, current one-time work and recent failed one-time work, plus configured independent services/timers. A successful inactive oneshot is healthy; a never-run oneshot is unknown. Execution success does not prove delivery. Existing task controls and Session records remain authoritative.
- Fixed allowance-check requests retain their receipts and are not project output. Available capacity suggests choosing useful existing work; it is neither evidence of waste nor permission to start arbitrary work.

## Reports and urgent alerts

### Feishu API dependency

Enable `feishuApi.enabled` in the same `monitoring.json` to observe the existing
`feishu-api-logs/` ledger. Supply `apps: [{appId, label}]` and optionally
`callsPer5m` (default 100). This uses the existing minute observer, Overview
and daily-report source; it creates no probe, model task or additional timer.
Each app shows observed calls/failures in a rolling 24-hour window, recent
traffic, latency and the busiest sanitized endpoints. The first observation
date is retained: a window with only a few hours of logs is not a full-day
measurement. Direct CLI requests, other instances and billing eligibility
remain explicit gaps. Reads are bounded to 31 days, 512 files and 32 MiB;
truncation or malformed logs cannot establish healthy coverage.

Component and hourly breakdowns distinguish chat/comments, progress cards and
display reminders. Upgraded successful GETs compare request and data digests
made with a random process-local HMAC key; no resource IDs, query values,
responses, authentication data or payload hashes for writes are logged.
Twenty identical successful reads in five minutes flag possible polling waste
for the report. This is a design-review clue, not proof that a business request
was redundant, and comparison across processes or old logs is not inferred.
An operator-confirmed `tenantQuotaLimit` can retain the monthly ceiling without
inventing the used count. Remaining allowance and early budget warnings still
require the independent fresh administrator measurement below.

Monthly rejection `99991403` is an immediate critical incident, latched in
`feishu-api-health.json`. Token success, idle traffic, log retention and
restarts cannot clear it. After an administrator restores quota, independently
verify a previously affected interface, then record `quotaRestoredAt` and
`quotaRestorationEvidence` in the same configuration. A later rejection
blocks it again. Rate spikes (100 calls in five minutes by default), at least
five failures with a 20% failure share, or at least five calls taking five
seconds with a 20% slow share use the existing confirmation count. The
threshold is an initial operational setting, not a measured billing budget.

True tenant quota is separate. An optional `tenantQuota` contains `used`,
`limit`, `observedAt`, `source: "feishu_admin"` and an evidence reference from
the administrator's Billing / My Quota page. Only readings within 24 hours
qualify; 80% is a report warning and 90% triggers the unified critical route.
Local call counts never substitute for tenant billing. Without a fresh
administrator measurement the remaining allowance is unknown. Feishu's
[official quota notice](https://open.feishu.cn/document/platform-notices/platform-updates-/custom-app-api-call-limit)
also describes its native 90% and 100% notifications to administrators and
developers. Check these in the existing authorized administrator workflow;
this instance does not claim to have read or configured that console.

When the provider has rejected monthly quota, the observer persists new
notification intent as `blocked_dependency` without trying to send through
that same provider or changing Bot. Overview and the report expose blocked
and uncertain alert batches. Existing uncertain sends still need readback;
no automatic replay is permitted. Local observation continues even while
Feishu delivery is unavailable. This is visible in Web, not a claim that an
independent phone/email notification was delivered.

### Explicit service pauses and historical repairs

A configured service may carry `maintenance: {reason, source}` citing the
actual operator pause. Only an inactive service is then shown as paused;
failed, missing and starting states retain their normal meaning. This avoids
new repair admission for intentionally stopped components without deleting
their state. Remove the maintenance annotation after the original operator
scope permits resumption, and verify the real service and business result.

Recovery rows include `currentResourceStatus` from the fresh disk/service
measurement or current automation lifecycle. Healthy, intentionally paused,
cancelled and finished objects leave the Overview's current-problem area;
records remain under collapsed history and in the JSON/ledger. The daily source
shows current repairs and a historical count, rather than repeating old errors.
A later successful Run clears an older failure from current execution health;
it does not retroactively prove an old repair's product or delivery acceptance.
Missing task sources remain unknown and cannot establish recovery.

`scripts/monitoring-report.mjs --output <prefix> --base-url <instance> --days 1` writes local JSON and a compact Markdown section. It publishes and sends nothing. The established daily workflow reads this source, incorporates actual maintenance and gaps, commits its Markdown and reuses its publisher and group delivery. No separate routine message or Base is needed.

When a visual snapshot is authorized, enable the optional browser capability in the same instance configuration:

```json
{
  "snapshot": {
    "playwrightModule": "/path/to/installed/playwright/index.mjs",
    "browserExecutable": "/path/to/chromium",
    "profile": "approved-daily-bot",
    "cliConfigDir": "/path/to/lark-config",
    "overviewUrl": "https://instance.example/?tab=tasks&monitor=overview"
  }
}
```

Use `scripts/monitoring-snapshot.mjs --output <prefix> --base-url <instance> --days 1 --upload` before the existing daily reply. It captures only the top issues and account cards from the shipped authenticated UI, at twice the display resolution. The PNG and source JSON share one observation. The service token stays in-process and is forwarded only to the selected instance origin. Optional `libraryPath` and `noSandbox` support a host's existing browser installation; no new runtime dependency is imposed on the workbench.

`--upload` uploads as the explicitly configured Bot and writes a Markdown image-key block plus a receipt; it does not send. Include that block in the existing daily summary. The Feishu converter embeds a standalone `![label](img_key)` as a native image in that same post. It does not fetch remote URLs or local paths, and fenced examples stay literal. Keep the full editable table in the original report. Capture or upload failures must be reported as a snapshot gap and retain the ordinary daily text, not reuse an older image as today's observation.

An optional independent `scripts/monitoring-alerts.mjs` observer needs no HTTP server or model. Run it under one user service/timer with an explicit instance environment. It batches newly actionable disk/service incidents and important native task failures persisting for three observations into shared, updateable Feishu cards. Normal account exhaustion stays in the account table; actionable local backup/switching failures use the continuity route below. Normal, restored and lower-priority states go into the report.

### One incident, one message

An unresolved incident keeps its original message ID. Starting recovery, switching models, changing a plan, reaching a worse disk risk stage or completing verification edits that message rather than sending another one. Minor disk-byte fluctuations do not trigger edits. Batch updates preserve the other subjects in the original message, including their recovery results. Only explicit healthy evidence followed by a new failure starts a new incident and message.

Cards show current risk, actions actually reported, their outcome, the specific next decision, and a link to the original recovery Session. Critical risk and pending human decisions are red; the observation time is secondary text. A running attempt cannot display an older attempt's summary as work it has just completed. Normal account exhaustion remains silent; a local lack of qualified backups or a disabled/failing switch is a continuity risk, not a request to fix normal consumption.

Set `alertDelivery.enabled` to `false` to mute both sends and message edits while keeping the existing observer, snapshot collection and authorized recovery running. `recovery.enabled` remains a separate control. Do not stop the combined timer just to silence notifications. Unmuting reuses existing message IDs; use the existing baseline mode to acknowledge known unmessaged incidents when appropriate. A later real escalation or a new concrete confirmation plan can notify a baselined incident once.

New messages use shared cards (`update_multi: true`); existing rich-text notifications are edited in place without changing their IDs. Edits use Feishu's original-message APIs and their platform limits. An unavailable/recalled/expired message, a changed recipient, an interrupted edit or uncertain acknowledgement is retained as `needs_review`; none permits creating a replacement message automatically. Keep recalled receipts as audit, explicitly reconcile them before resuming, and never clear the ledger to retry a send. Existing card updates: https://open.feishu.cn/document/server-docs/im-v1/message-card/patch ; legacy message edits: https://open.feishu.cn/document/server-docs/im-v1/message/update .

Keep the observer's own service and timer visible in Overview, but list them in `alertDelivery.ignoreUnits`: it cannot reliably supervise its own absence, and an explicit maintenance pause must not notify as a new outage. Their health remains inspectable from the application and daily report.

To consolidate account and resource notifications, set `alertDelivery.accountAlerts` to `{ "enabled": true, "sources": ["approved-adapter-id"] }` and `alertDelivery.confirmationObservations` to `3`. The same observer then batches local account-continuity risks, service failures and resource incidents in one message and one durable delivery ledger. Account readings use the existing identity deduplication across sources; one unavailable adapter does not report a loss when another source has a fresh valid reading. Account-continuity incidents require at least three observations. Services use the configured confirmation count (1–10, default 1); disk emergencies remain immediate. A baseline acknowledges existing account and service incidents even before they reach the confirmation count. Unknown readings never rearm an exhausted-account incident. Turn off the account dashboard's separate notification recipient before enabling this route, retain its collection and history, and verify that the old observer/timer is stopped on the retired host. Keep routine observations in the existing report.

During migration, `--baseline` records already-known critical incidents without repeating a group notification. Recovery rearms a recurrence; unreadable sources cannot establish recovery. The observer persists sending intent before delivery, then saves the shared verified message receipt. Interrupted or uncertain delivery becomes `needs_review` and requires readback before retrying. Preserve state across restarts. This observer does not replace task result delivery.

Before resuming after a task-source change, verify that all configured important native task IDs still resolve. Missing IDs are coverage gaps, not recovered incidents. A missing item, an unavailable read or an unfinished retry cannot rearm an already reported failure; an explicit healthy observation or stopped task is required. Names and page groups do not change incident identity. Important tasks still require three failed observations before a new alert.

Use `scripts/monitoring-alerts.mjs --dry-run` against the target instance environment to preview eligible notifications without sending or changing durable observer state. Once the current problems have been reviewed, run `--baseline` with the timer stopped, then enable the existing timer and verify its natural execution. The baseline also acknowledges existing important-task failures before they reach three observations, while preserving previous sending receipts. Known problems remain visible in Overview and the report; a later verified recovery allows a new failure to alert again.

## Recovery after a failure

When the operator authorizes recovery, extend the same observer instead of adding another timer. Observation, incident notification and repair have separate durable records. Reporting or baselining a problem does not resolve it. The Harness still diagnoses the error, chooses permitted work and verifies business results; this broker supplies incident identity, bounds, admission and receipt reconciliation.

Service recovery inherits `alertDelivery.confirmationObservations`, so a brief restart cannot start a repair before the configured number of distinct failed snapshots. Counts survive observer restarts and reset after an explicit healthy observation. An unknown measurement cannot authorize a new service repair. Disk warning investigations and emergencies remain immediate, and already admitted work continues normal receipt reconciliation.

Add an explicit instance-local configuration:

```json
{
  "recovery": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:INSTANCE_PORT",
    "coordinatorSessionId": "EXISTING_AUTHORIZED_OPERATIONS_SESSION",
    "automationIds": ["*"],
    "maxAttempts": 2,
    "maxConcurrent": 1,
    "models": ["gpt-6-sol", "gpt-5.6-sol"],
    "workflowPaths": {"disk:/": "/path/to/current/authorized/disk/WORKFLOW.md"}
  }
}
```

The default automation scope is native task failures with an actual failed Run. Use a list of task IDs to narrow it; `*` covers all such tasks. Paused, cancelled, completed, superseded or archived work is not restarted. Configured critical disk/service incidents use the existing coordinator Session; a busy coordinator is deferred. Account observation remains with its own observer. A gate failure without an admitted Run remains an alert/coverage issue and does not authorize bypassing the gate.

`monitoring-recovery.json` retains each failure and its attempts through observer restarts. A current manual continuation is observed before any new work; after it ends, a bounded verification turn checks existing results. New recovery work resumes the original task Session and its original delivery route. It keeps successful inputs, comment anchors, task scope and business-write receipts, patches the actual Session model before admission, then reads back the Run model. It restores the prior preference after the attempt, preserving an intervening user change. Lost admission acknowledgements are read back and reconciled using one native request ID. They never authorize replaying an uncertain business write or message.

Each repair writes a keyed acceptance receipt under `monitoring-recovery-receipts/`. Provider completion alone leaves the incident pending verification. Task evidence and acceptance are required; disk/service recovery also requires a fresh independent healthy measurement. Conversation delivery requires the original final source-delivery receipt, not an opening message; uncertain delivery is observed for up to ten minutes without resending, then remains blocked. Permission, ownership, external dependencies or exhausted attempts retain a concrete reason rather than silently disappearing. Current phases and results are visible in the existing Overview and daily report.

Use `--dry-run` to inspect pending recovery without saving state, admitting work or sending. Enable on the intended instance only, check current in-flight/manual work, then observe the existing timer's first real receipt. The observer can still discover and report outages when HTTP/model access is unavailable; AI repair waits for a usable native admission path. One observer process owns this ledger; do not launch a second concurrent observer against it.

## Verification

Recovery, delayed publication and acceptance replies do not inherit a scheduled report's all-member mention. The recovery prompt explicitly overrides that scheduled rule; use a full-group mention only when the user requests it for this recovery.

A confirmation receipt requires concrete steps, target, impact, rollback and verification, plus evidence. A flat target object containing identifiers is normalized into readable text without approving the plan. Malformed confirmation receipts remain in verification, preserving real completed actions, and can be corrected in place without another model run. The former exact “missing confirmation plan” formatting block is also re-read for compatibility. Other business or authorization blocks remain blocked.

Final delivery acceptance reads the original durable Request aggregate, including archived Requests; absence from the active outbox is not a delivery failure.

`npm run test:monitoring` covers account freshness/deduplication, partial reads, shared filesystems, incident/recovery behavior, bounded model changes, lost admission acknowledgement, manual recovery adoption, independent acceptance and delivery reconciliation, report boundaries, UI defaults and authenticated HTTP access. Complete normal CI before main delivery, then verify real desktop/mobile views, unchanged automation controls, source coverage and timer execution on the target instance. Saved schedules or passing tests do not establish that a future report reached its group.


## Automation responsibilities and shared inputs

Operator handoff: “Classify this instance's automation by its actual purpose, verify native and business switches, and combine repeated project inspection inputs before publishing. Preserve original source permissions, task cursors, write locks, delivery routes and paused projects. Verify configuration separately from the next real execution.”

Recurring schedules accept optional `purpose`: `operations`, `projects`, `research`, `execution`, `memory`, `improvement`, or `other`. These describe operations and monitoring, project progress, news/research materials, business execution, collaboration memory, and feedback/improvement. Purpose is persisted and projected into the existing automation view; editing it does not alter cadence or delivery. Unclassified legacy titles retain an explicit fallback. Long instructions are not classification inputs.

A fresh business condition distinguishes disabled execution, waiting for a useful condition, and a report held after uncertain delivery or exhausted retries. Native schedule state, exact execution history and delivery evidence remain independent. A stale or failed condition read does not assert that business execution is disabled.

`automation-background.json` in the instance config directory can register display-only descriptors under `mechanisms`. Each has `id`, `title`, `purpose`, `trigger`, `note` and a `source`. Supported sources are an exact `systemd` unit, an `environment` flag, a `json_flag`, a read-only `sqlite_scheduler` flag, or an `embedded` mechanism. `/api/automation-tasks` returns these as `backgroundMechanisms`, separately from task records and execution counts. Reading descriptors starts no job, sends no message and makes no provider request. Missing or failed source reads remain unknown; configured mechanisms do not claim completed execution.

For a shared project inspection, `scripts/project-inspection-plan.mjs` takes the current project runtime, original Todo registry, review root and original scheduled timestamp. Its read-only plan merges the earliest source/Todo cursor with a 48-hour overlap and both known-thread indexes. Paused projects and unauthorized targets stay excluded; missing baselines require full initial reading. The morning phase assesses the original Todo targets before publication; the afternoon phase reuses their latest result. Real collection, understanding, task writes and successful cursor advancement remain the Harness's original workflow, not the planner's side effect. Keep actual task writes under the existing lock and reread relevant state to handle concurrent writers.

`scripts/research-candidate-handoff.mjs` exports deduplicated public original links from a source-candidate snapshot. It preserves capture editions, review status and the original source hash, excludes private references/internal links/credentials, and performs no collection or dataset admission. The existing dataset workflow consumes this input first, reuses evidence and probes only missing discovery coverage and its distinct license/payload/catalog requirements. Export time cannot make old material fresh, and a captured link does not prove original reading or dataset eligibility.

The next natural source read, task readback, report publication and delivery each need their own evidence after consolidation. A passing planner test or a saved schedule is not that acceptance.


## Read-only Session monitoring

`/?tab=tasks&monitor=overview` is the native authenticated monitoring view.
The former `static/monitoring-live/` entry redirects here and contains no instance
records. Monitoring panels use the existing login and only GET queries. Session ownership comes from the canonical external conversation binding
and `initiatedByIdentityId`, joined to People; personal sidebar folders are not
source chats and later participants do not become Session initiators. Unknown
ownership stays explicit. Shared accounts, storage and services remain instance
resources; this page reuses Overview's observations, attention and thresholds.

`GET /api/monitoring/sessions?days=1|7|30` returns narrow ownership and measurement
projections plus the existing deduplicated usage summary. It uses a 60-second
per-window single-flight cache and reuses unchanged projected files by file
version. It never invokes a Run reconciler, notification or recovery operation.
Stage measurements read only the most recent 1,000 ledger Run references and their
Request/Run metadata, in batches of eight, with a 64 MiB cold-read budget and a
2 MiB per-record limit. Coverage reports sample counts, limits, missing records,
errors and generation time. Parsed request text, deliveries' bodies and runtime
secrets never enter the response or projection cache. This does not backfill all
history or instrument each model call. Full Session usage aggregates and bounded
stage samples have separate coverage.

Each stage has its own paired sample count: accepted→prepared includes queuing,
prepared→started covers launch, started→completed includes explicit waits, and
settled→all final content parts delivered covers final transport. Requests
steered into an existing Run do not manufacture additional Run samples. Foreground
context is the mean of each Run's latest reported context; per-Run accumulated
input is separately named. Neither is the mean of every model invocation.

Page-only deviations compare the same Session, model and Harness: recent three
foreground samples against the preceding up to twenty (minimum ten). A ratio of
two or more is a neutral change clue, with minimum absolute increases of one second
(execution: one minute) or 10,000 tokens. Zero baselines and insufficient samples
are not classified. Cohorts are limited to the selected window. The comparison
is a review clue, can reflect different task complexity and does not assess task
quality. The page never invokes alert delivery, recovery, benchmarks or feedback
collection. Feishu API logs currently lack a reliable Session association; only
instance API totals are shown, never apportioned to people or groups.


### Native Monitor integration (2026-10-12)

Monitor defaults to Overview from the normal homepage (`/?tab=tasks`);
explicit `monitor=automations|usage|feedback` links preserve those destinations.
Clicking Monitor while the homepage is loading keeps that workspace selected
when the initial Session list arrives.
The Session heading includes a closed-by-default “上下文如何注入” explanation of
the [general context rules](connector-turn-context.md#monitoring-explanation-2026-10-12).
It preserves the reader's open/closed choice during refresh and makes no extra
requests or model calls. It does not claim to audit each Session's full prompt.

The Overview shows three compact panels in order: Session, shared resources, and API.
Each presents totals and observation/exception status first. Session totals are
followed by up to three named metric changes with a compact diagnosis status,
plus three group/initiator summaries. Ratios, recent values, baseline and diagnosis
evidence are disclosed beside the corresponding Session rather than repeated in
the default row. Without exceptions, up to
three running/waiting Session names are visible. Full Session metric tables and API endpoints start collapsed. Resources start directly with disk capacity, account quotas and period Token usage.
Each metric has a closed-by-default “何时提醒、怎么处理” disclosure beside its data.
The text states when a notification is sent, what the system does, when human help
is needed, and where results are reported. API guidance sits with the API summary;
service guidance sits with the service table; automation guidance and delivery
locations sit with the automation list. Collection guidance sits with check scope.
There is no separate policy card grid or global destination table. Open/closed
choices survive data refreshes. Each disclosure retains that kind's recovery
records, concrete plans and links. Threshold copy follows the active notification
policy, and a configured execution Session does not claim that a repair has run.
Disk and account tables stay visible;
account reset details and Token breakdowns open on demand. There is no additional
resource overview counter, service/task table, notification
pipeline status or capacity advice in this panel. Disk and account state appear
in their rows; source gaps appear beside the affected section. Runtime collectors,
alert/recovery configuration and records are unchanged. Existing automation and
operational tools remain separate from this resource display.
Session exception cards compare recent values with their baseline using labelled
bars; metrics keep units and textual values, rather than relying on colour alone. Clicking a Session
exception selects its titled detail view without putting an opaque ID in search.
Affected table metrics are marked, with sample comparisons beside the Session name. Expansions and
owner filters reuse fetched data and do not start another query. Manual refresh
preserves the user's fold state.

The Session summary shows the current unarchived count, period usage averaged
over Sessions with a ledger usage record (including archived Sessions active in
that period), and average RemoteLab context injection per measured foreground Run.
Usage with no record is unknown, not zero; a zero-valued recorded usage is valid.
Injection is the UTF-8 byte length of the existing manifest's `modelContext`,
weighted by valid Run sample counts. It excludes native Harness history and tool
output; it is not the latest model context token count, nor cumulative input.
Only projected sizes are retained. Reading manifests shares the existing file-size,
total-read and sample caps; missing injections and partial coverage are explicit.
The panel labels units and denominators, with exact scope under statistics details.
API totals always cover the observer's own 24-hour / five-minute windows and are
labelled separately from the Session selector. No data is presented as all-clear.

Switch group/initiator mode to change the visible ownership summaries and Session
owner labels; switching clears the previous owner, Session and search selection.
Expand Sessions for runtime state, period tokens,
phase means, latest-context means, injection means, P95 and sample counts.
Inside a Session, “查看按需背景查询记录” fetches explicit work/memory/people lookups
only when clicked. It shows starts, successful/partial returns, failures, unmatched
starts, elapsed time, result bytes and exact-query repeat counts for the selected
window. This reuses the usage-event ledger; no model analysis or chat transcript
scan runs when opening the panel. Query bodies are not copied into monitoring.
Collection start, partial scan and unavailable records remain explicit; zero
observed lookups cannot establish missed reading or task quality. See the
[lookup coverage and endpoint](connector-turn-context.md#按需查询记录).
Existing cohort-based deviations now also include injection bytes (10,000-byte
minimum increase). They remain page-only investigation clues. Shared-resource
and API thresholds and all alert/recovery configuration are unchanged.

The native view uses `/api/monitoring/sessions?days=1&compact=1`, with title, state,
window usage and measured fields only. Group/person labels are dictionary encoded,
zero-sample metric objects are omitted, and the page no longer requests the full
Session/sidebar projection. State reads use the runtime's accepted queue and the
persisted current Run/question without reconciliation. Statistics retain the
60-second cache; state has its own observation time. The UI renders only the first
50 matching Sessions and three owner groups, with explicit expansion. Queries
coalesce in the browser, and each panel has a 15-second deadline and its own error
state. A failed request never produces a zero-anomaly summary. This is bounded
on-demand observation, not new background scanning or model analysis.

The former independent monitoring page is now a small entry linking to this native
view, so there is one maintained monitoring interface. Existing saved links remain
usable; the change does not publish instance data to the unauthenticated entry.

The Automations tab also explains system monitoring as a source → processing → write → notification flow. It references the existing background mechanism states and opens this overview for live readings; it does not add a collector or a notification channel. See [Automation flows](task-center-v1.md#compact-flow-explanations).


## 用量归属与旧账校正

Codex 按 Run 起止时间读取用量时，只使用该时间段内的增量。时间段没有用量记录、边界无效或缺少起点时，返回未知，不使用整个原生会话的累计 token 兜底。没有指定时间段的上下文大小查询保留原行为；这里不改变提示词、消息读取量或 UI。

已确认错误的旧账保留原 JSONL。维护者先用 `node scripts/repair-codex-usage-attribution.mjs --run run_ID` 定向复核，再加 `--apply` 追加校正记录。脚本只处理明确指定、来源为旧 Codex fallback 的已取消 Run，并完整扫描原生日志确认运行时间内没有用量记录。它不按数值大小或取消状态批量删账。校正记录包含原账哈希、原因、日志哈希和时间范围，同一错误 Run 跨日期文件存在多个旧版本时逐个保存哈希并校正，确保历史时间窗口也适用。原始事件不改写；`recordUsageCorrection` 的 restore 动作可以撤回校正。

读取账本时，只有当前记录的 Run、Session 和内容哈希都匹配，校正才生效。未知用量从 token、费用和均值样本中排除，不当作零消耗；有效的取消任务仍保留。之后同一 Run 出现新的有效记录时，旧校正不覆盖新证据。API 的 `quality.excludedRuns` 与紧凑 Monitor API 的 `usageQuality` 提供缺口和原因。现有界面沿用同一个统计源，60 秒缓存到期或服务重启后刷新；本次不调整页面布局。

## Action risk and account continuity (2026-10-12)

Classify business risk separately from the risk of the proposed action. Normal
subscription consumption and an exhausted individual account remain visible in
the account table but do not create an incident or ask a person to replenish it.
The local runtime pool is the authority for usable backups: fleet observations
must never authorize using another instance's credentials. Overview exposes
`accountContinuity`, including the automatic-switch policy, fresh local backups
above 10%, the current balance and the last background switch receipt.
At 20% without a qualified local backup, request a concrete choice (wait for the
reset or authorize/login another account). At 10% with a backup, background
selection changes subsequent requests; a persistent failure to do so is an
incident. Unknown current quota is an observation problem, never exhaustion.
Three observations confirm a continuity notification. Running requests retain
their authorization and are never automatically replayed by rotation.
If the current account is confirmed exhausted and no backup exceeds 10%, the
selector uses the highest fresh positive local balance. The reserve requirement
must not strand subsequent requests on an exhausted account. Low positive
accounts do not bounce between one another.

Disk warnings now enter the existing recovery broker at the warning threshold,
before a critical outage. A repair Harness first investigates the actual source
and existing work, executes authorized low-risk, recoverable steps and verifies
the result. Medium/high-risk operations wait for human confirmation in the
original handling Session. The durable receipt uses `awaiting_confirmation`
and a `plan` with `risk`, `summary`, `target`, `impact`, `rollback` and
`verification`, plus actual evidence. The observer never treats that state as
permission to execute. Human-authorized execution updates the same receipt;
independent recovery verification still applies.

A blocked disk investigation can reopen within the existing attempt limit when
risk materially worsens or the explicitly configured `recovery.policyVersion`
changes. The previous block and every attempt remain recorded. Warning,
critical, below 20 GiB/97%, and below 5 GiB/99.5% (inodes 97%/99%) are distinct
escalation stages. A worsening stage or a new concrete confirmation plan sends
one new notification. Repeated identical observations stay silent; uncertain
sends still require readback. A waiting confirmation never auto-reopens as a
repair. `workflowPaths` must cover each managed filesystem, including data disks;
root-to-data migration is not a remedy when the data disk is itself full.

Alert messages include the business risk, existing low-risk handling or the
specific plan requiring confirmation. They do not equate urgency with permission
to delete unique data, interrupt work, buy capacity or use another account.
Known-unsent batches whose incidents retired or were subsequently delivered are
marked superseded, preserving history without keeping them as current failures.

Feishu quota rejection remains latched across restarts and log retention. A
later real successful call of the same app, HTTP method and sanitized affected
business endpoint (observed within 15 minutes) is now sufficient evidence that
that interface works again. It clears the operational latch and records the
restoration evidence; auth/token success, another app/endpoint and an estimated
monthly balance cannot do so. A new rejection relatches it. Explicit operator
restoration remains supported. Incomplete logging stays visible even with this
positive recovery evidence; it no longer prevents the proven transport from
resuming known-unsent current notifications. This does not infer the tenant's
remaining billing quota or automatically replay uncertain deliveries.

A restriction on another API (for example calendar) must not disable an
independently proven message transport. A successful message send/reply of the
same app, newer than its rejection and within 15 minutes, permits the observer
to deliver current alerts. The affected API's rejection and the unknown tenant
balance remain recorded; its warning is not described as a proven total
messaging outage. No extra probe or test group message is sent. The verified receipt survives quiet periods and log rotation. A newer quota
rejection invalidates it and requires fresh positive sending evidence before
the dependency block can be lifted again.
The dispatch gate uses that same durable evidence and does not impose an
independent expiry that could resurrect the old restriction.

Opted-in automation tasks now link to a [stable home Session](task-center-v1.md#stable-automation-home-explicit-opt-in). The primary link opens the dedicated task-context Session; the original discussion is a secondary reference. Its header reads native execution state directly and distinguishes future-trigger cancellation from active runs. Monitoring and evaluation configuration remain separate; a home is not a new supervisor.


### 群提醒的正文长度

群里的同一事件卡片只保留当前风险、简短处理结果和下一步三行，关键风险和待确认状态标红。处理回执只摘取首句并限制长度；完整方案、对象、影响、恢复办法和验收证据保留在原补救会话及监管详情中，通过卡片链接查看，确认前不执行。低于预警线的 inode 读数不占用卡片正文。更新仍沿用原消息，不因版式变化另发提醒。


### 谁处理、如何介入

卡片下一步区分“我在处理／无需操作”“需要你批准”和“需要你补充信息”。补救回执可用 `humanAction: {type: "approval" | "input", summary: "具体最小动作"}` 标明人的动作；该字段只说明需求，不构成批准。资料、登录或外部操作未齐备时应为 input，不能把仍缺前提的方案显示成只待批准。新一轮执行清除旧的人的动作，执行中不展示上一轮待答事项。

卡片提供对应按钮：查看处理进展、进入会话补充信息、查看方案并回复批准。按钮打开原处理会话，由人看完完整方案后发文字确认或补充资料；点击跳转本身不批准、不启动执行。现有告警卡没有接入一键批准的回调，不能将导航按钮标为“批准并执行”。

首次预警就一次性发送包含风险、处理结果、人的具体动作及按钮的完整卡片，不先发预警文本再补发交互卡。后续沿同一 messageId 更新。用户要求只改代码、暂不改卡或发新消息时，将 `alertDelivery.enabled` 关闭；已有观察与补救继续运行，但新消息与原消息更新都保持关闭，不能因发布完成自动恢复。


## 各指标的处置与固定脚本

对常见报警，可要求维护 Agent：“先运行固定只读检查，说明实际故障和已做的动作；能安全补救的自行完成，需要我介入时明确是批准方案还是提供资料。保持现有消息暂停设置。”

规则由 `lib/monitoring-policy.mjs` 提供给原监管总览和补救提示，卡片根据真实执行回执显示处理状态。规则说明不代表已经执行；只有补救确已准入才显示正在处理。确认方案和资料请求仍在同一张预警卡中，点击查看不是批准。暂无执行回执时不声称正在修复。

| 指标 | 预警与自动处理 | 需要人介入的边界 |
| --- | --- | --- |
| 服务 | 只处理配置范围内真实失败，按配置连续观测确认；计划停用、启动中和成功结束的 oneshot 不报警。原固定会话查服务、退出结果及依赖 | 可能打断业务的重启先给出对象、影响及恢复办法；不能用旧维护记录覆盖新决定 |
| API | 高调用量或重复读取只作本地优化线索。5分钟至少5次失败／慢请求且占比至少20%，连续观测后预警；读取已有日志，不为检查额度额外调用供应商 | 实际受限时请管理员核实受影响接口、真实额度和重置时间；购买、改业务频率、停用或换应用先给方案 |
| 月额度 | 仅接受24小时内管理员实测；80%预警、90%严重，连续观测确认。正常消耗本身不要求人修复 | 先分析调用来源；未形成具体方案前不放“批准”入口 |
| 自动化 | 启用任务失败沿原会话检查产物及回执，只补失败步骤，遵守次数上限；已停用或条件未命中不重启 | 缺资料、登录或外部操作时说明具体帮助；未知发送结果先核实，不直接重发 |
| 账号 | 复用现有账号观察器，提前准备备用；自动切换开启时按10%预留线切换后续请求 | 无可用备用或需要开启切换时由人选择；不自动购买、借用账号 |
| 采集与送达 | 缺失、过期、冲突保留为未知；不以另一轮告警修复告警，不自动重发不确定消息 | 查明确需重新登录、授权或恢复入口后再请人介入 |
| 用量与活跃度 | 消耗多、运行长是分析线索，结合产物、进度及真实错误判断 | 不据此自动终止任务、换模型或改预算 |

固定入口：

- `node scripts/monitoring-diagnose.mjs`：复用本实例有界采集器，输出磁盘、服务、任务、API来源、采集缺口和补救回执。可用 `--kind service --id example.service` 等筛选。只读，不启动补救、不切号、不发送、不重启、不删除；无需新会话或定时器。先用此结果定位，再决定具体动作。
- `scripts/codex-account-observe.mjs`：已有后台账号观察及预留切换执行器，沿现有实例启动参数运行；不新建第二个切换器。
- `scripts/monitoring-alerts.mjs`：已有分钟观察器，复用有界补救与独立验收。`--dry-run` 用于验证而不写入或准入。通知暂停不影响已启用的补救，但同时禁止发送和修改卡片。

这些固定入口不提供通用的“清理全部缓存”或“重启全部失败服务”。具体磁盘清理仍沿对象的已授权工作流，重启与业务重放须核对实际影响。API检查目前是固定诊断，不是自动停流或购买额度的执行器。


### 验证阶段的通知门槛（实例按需启用）

`alertDelivery.noisePolicy: {"mode":"risk_only"}` 提高首次通知门槛，但保留触发后的补救动作、过程和成功／失败结果，均更新同一张卡；不用静默补救隐藏链路。尚未启用此选项的实例沿用原通知规则。采集、较低门槛的风险标记和补救照常运行。

| 指标 | 验证阶段首次通知门槛 |
| --- | --- |
| 磁盘 | 一般预警只留监管页；严重状态连续2个样本才通知。可用不足20 GiB、容量或inode达到97%时立即保留安全提醒 |
| 服务 | 连续5个独立样本确认真实失败；启动中、计划停用仍排除 |
| 重要自动化 | 连续3个独立样本确认失败，不因已启动补救而隐藏通知 |
| 账号 | 无备用、切换未开启或切换持续未完成，且剩余不高于10%，连续3个样本才通知；20%只准备备用；未知额度不报耗尽 |
| API | 5分钟至少10次失败且失败比例至少50%，连续3个样本才通知；只有慢请求、高流量或月额度比例不推送 |
| 额度拒绝 | 15分钟内有新拒绝、尚无随后消息成功证据；历史拒绝保留待核验，不反复推送 |
| 人工介入 | 有证据的具体确认方案或资料请求可以立即提示；点击查看不是批准 |

重复读取同一快照不累计确认次数，较低风险样本不能提前凑齐较高门槛的次数；未知样本打断连续确认，但不算恢复、不重开事件。补救成功仍更新原卡，便于验证触发与处置是否准确。

`alertDelivery.enabled:false` 仍同时禁止发送和修改卡片。配置风险门槛并不授权恢复推送。


各项监管数据旁的“何时提醒、怎么处理”可展开查看统一告警接收群、磁盘／服务固定会话、各自动化实际执行会话及结果出口。账号切换显示后台执行器，API诊断显示固定脚本，不虚构独立群或会话。自动化回报按照实际任务发送配置及执行会话绑定展示；仅有飞书会话绑定、但任务配置为仅RemoteLab时，不声称会发送到群。群名只读取已保存的来源记录；缺名称或未取得会话时明确显示未核实，不为页面刷新额外调用飞书，也不改变任何路由。


公共运行问题的执行会话不需要绑定群：磁盘、服务、账号和API的补救摘要沿 `alertDelivery.chatId` 更新原预警卡。页面分别展示执行入口、补救摘要位置及业务任务结果位置；缺少 Session 绑定不等于缺少回报。业务自动化的原群／话题不变，也不因此额外发第二条消息。

任务没有外部 `resultDelivery` 只说明平台不自动转发其 final，不能断言其固定脚本不投递。核对原任务和脚本配置后，可在实例 `automationReportLocations[taskId]` 保存 `label`、`evidence`、`verifiedAt`，用于展示流程内投递位置；这不是新路由，不替代脚本配置。未核验则明确显示“流程内投递待核实”。明确禁止公共群转发的个人或静默任务列入 `alertDelivery.ignoreAutomationIds`，即使失败或需要人工帮助，也不由统一告警出口外发；原补救及原流程的回报不受影响。不得仅凭缺少绑定就覆盖私聊、禁发或仅本地的决定。

累计 Session token 总数由 chat/session-token-totals.mjs 共享 60 秒缓存；监控 HTTP 入口和飞书已关联话题读取同一账本结果，累计用量与当前上下文占用仍分别显示。

Session 的按需查询详情同时提供[规则与压缩记录](connector-turn-context.md#规则与压缩记录)，区分原生接收、压缩完成和恢复内容生成／失败。该记录不能证明模型理解或遵守规则，也不覆盖原生系统指令、AGENTS.md 和 Skill。

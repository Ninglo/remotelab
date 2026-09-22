# Task Center v1

Task Center is the authenticated control surface for RemoteLab's durable automated tasks. It is a top-level application workspace, separate from the ordinary Session transcript. The first version is deliberately a projection and control facade over the existing trigger and recurring-schedule stores; it does not add another scheduler, systemd producer, or workflow engine.

## Product boundary

RemoteLab owns generic automation mechanics:

- when automated work should be admitted
- which Session receives the instruction
- whether each occurrence gets an independent Session
- where the resulting reply may be delivered
- durable admission, retries, status, and safe lifecycle controls

The execution Session still interprets the instruction and decides the concrete work. Task Center does not know evaluation, GPU, report, inbox, or other domain semantics.

Settings remains the place for instance configuration. RemoteLab uses one persistent, ChatGPT-style sidebar: New Session and Tasks sit above the Session list, while Settings sits below it. Selecting a Session, Task Center, or Settings swaps the main workspace inside the same application document; there is no second application rail and no template-management destination. Task Center and Settings share the same flat, readable main-canvas geometry and never insert management cards into a Session transcript. The sidebar shows the product brand only in the global header, keeps origin filtering next to the Session list, and does not spend primary space on build metadata. The URL query remains shareable/restorable UI state rather than a separate page load.

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

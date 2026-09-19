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

The public projection contains:

```json
{
  "id": "sch_...",
  "kind": "recurring",
  "title": "Weekday review",
  "prompt": "Review the project and choose the next action.",
  "state": "active",
  "schedule": {
    "type": "cron",
    "cron": "0 9 * * 1-5",
    "timezone": "Asia/Shanghai"
  },
  "target": {
    "mode": "new_session",
    "sourceSessionId": "..."
  },
  "notification": {
    "mode": "remotelab"
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

Execution and notification are separate fields:

- `notification.mode = remotelab` keeps the result in RemoteLab. For fixed Sessions this explicitly suppresses inheritance of an existing external conversation.
- `notification.mode = source_conversation` snapshots the selected Session's connected source through the existing conversation/source-delivery contract.

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

Recurring tasks replace `scheduledAt` with `cron` and `timezone`. `target.mode = new_session` uses the selected `sessionId` as the explicit source Session.

### Lifecycle actions

- `POST /api/automation-tasks/:id/pause`
- `POST /api/automation-tasks/:id/resume`
- `POST /api/automation-tasks/:id/cancel`

The API returns the refreshed task plus any occurrence-cancellation counts.

## State and stop semantics

Task-level states are intentionally small:

- recurring: `active | paused | cancelled`
- one-time before admission: `scheduled | paused | failed | cancelled`
- admitted one-time execution: the underlying Run state, such as `accepted | running | completed | failed | cancelled`

Lifecycle behavior:

| Action | Future schedule admission | Materialized but unadmitted occurrences | Already admitted Run | Reversible |
| --- | --- | --- | --- | --- |
| Pause | blocked | cancelled | continues | yes |
| Resume | enabled from `paused` | not recreated; next valid occurrence is recomputed | unchanged | n/a |
| Cancel | blocked permanently in Task Center | cancelled | continues | no |

Pause/cancel and Trigger admission are serialized through the Trigger mutation queue. Whichever operation wins that boundary is authoritative: if stop wins, the request is not admitted; if admission wins, the resulting Run is allowed to finish. The Task Center UI intentionally does not expose `includeActive` Run termination.

This distinction is visible in the interface copy. `paused` or `cancelled` is never presented as proof that an already running process has stopped.

## Compatibility and limits

- Existing `/api/triggers`, `/api/schedules`, and CLI commands continue to work.
- Existing `PATCH enabled:false` behavior remains a terminal cancellation for compatibility; Task Center uses the explicit `status: paused` path when pausing.
- Cancelling preserves the durable task record for audit. The v1 UI does not delete tasks.
- Editing task definitions and arbitrary external notification-target authoring are deferred. Create a replacement task when routing or cadence must materially change.
- Task Center only inventories RemoteLab Trigger/Schedule producers. An unrelated systemd timer or standalone watcher is not silently claimed as managed.
- The existing recurring policy remains `latest_once` with a bounded open-occurrence backlog; v1 does not add a workflow DAG or business-specific rule engine.

## Implementation map

- Projection and lifecycle facade: `chat/automation-tasks.mjs`
- Existing producers: `chat/triggers.mjs`, `chat/recurring-schedules.mjs`
- Fixed/new Session contract: `lib/scheduled-session.mjs`
- Authenticated routes: `chat/router-control-routes.mjs`
- UI: `static/chat/task-center.js`, `static/chat/task-center.css`, `templates/chat.html`

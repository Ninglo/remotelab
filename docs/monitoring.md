# Operations overview

Operations (运行中心) helps people avoid interruptions and choose useful work for available resources. The existing `?tab=tasks` workspace now has Overview and Automations; Automations is the default. Overview (`?tab=tasks&monitor=overview`) starts with urgent issues, then account allowance cards with percentages, meters, resets and observation times. Storage, consumption and execution details follow. Exhausted accounts foreground their depleted window; unknown readings have no invented meter. Allowances across different plans are never added together. Settings keeps its current controls. Project tasks and daily reports stay in their existing local Markdown and publication workflows.

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

`GET /api/monitoring/overview?days=1|7|30` uses existing authentication and shared-instance rights. Partial failures preserve the remaining observations. Same-window requests coalesce for 15 seconds. The page refreshes when opened, explicitly refreshed, its period changes or it returns to visibility. There is no model call or periodic browser poll.

- Consumption comes from the instance ledger, with foreground/background work, cached tokens, daily trend and models. The rolling window is explicitly dated. Interface-reported costs and token-price estimates are separate; estimates are not subscription bills.
- Cached runtime and optional schema-v2 fleet observations are deduplicated by provider identity. Only ready samples within ten minutes qualify. Conflicting, stale, expired or missing observations stay unknown; a fresh source can replace a paused one. Any exhausted window makes an account unavailable, even if weekly allowance is full. Email labels are masked; credentials and raw source errors are not returned.
- Storage includes bytes and inodes. Root warns below 15 GiB or at 85% use and is critical below 8 GiB or at 92%. Percentage thresholds also apply to other disks and inodes. Paths sharing a filesystem are marked, never added together.
- Execution health includes recurring tasks, current one-time work and recent failed one-time work, plus configured independent services/timers. A successful inactive oneshot is healthy; a never-run oneshot is unknown. Execution success does not prove delivery. Existing task controls and Session records remain authoritative.
- Fixed allowance-check requests retain their receipts and are not project output. Available capacity suggests choosing useful existing work; it is neither evidence of waste nor permission to start arbitrary work.

## Reports and urgent alerts

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

An optional independent `scripts/monitoring-alerts.mjs` observer needs no HTTP server or model. Run it under one user service/timer with an explicit instance environment. It batches new critical disk/service incidents and important native task failures persisting for three observations. Account exhaustion and account-observation loss remain with the account observer. Normal, restored and lower-priority states go into the report.

Keep the observer's own service and timer visible in Overview, but list them in `alertDelivery.ignoreUnits`: it cannot reliably supervise its own absence, and an explicit maintenance pause must not notify as a new outage. Their health remains inspectable from the application and daily report.

During migration, `--baseline` records already-known critical incidents without repeating a group notification. Recovery rearms a recurrence; unreadable sources cannot establish recovery. The observer persists sending intent before delivery, then saves the shared verified message receipt. Interrupted or uncertain delivery becomes `needs_review` and requires readback before retrying. Preserve state across restarts. This observer does not replace task result delivery.

Before resuming after a task-source change, verify that all configured important native task IDs still resolve. Missing IDs are coverage gaps, not recovered incidents. A missing item, an unavailable read or an unfinished retry cannot rearm an already reported failure; an explicit healthy observation or stopped task is required. Names and page groups do not change incident identity. Important tasks still require three failed observations before a new alert.

Use `scripts/monitoring-alerts.mjs --dry-run` against the target instance environment to preview eligible notifications without sending or changing durable observer state. Once the current problems have been reviewed, run `--baseline` with the timer stopped, then enable the existing timer and verify its natural execution. The baseline also acknowledges existing important-task failures before they reach three observations, while preserving previous sending receipts. Known problems remain visible in Overview and the report; a later verified recovery allows a new failure to alert again.

## Recovery after a failure

When the operator authorizes recovery, extend the same observer instead of adding another timer. Observation, incident notification and repair have separate durable records. Reporting or baselining a problem does not resolve it. The Harness still diagnoses the error, chooses permitted work and verifies business results; this broker supplies incident identity, bounds, admission and receipt reconciliation.

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

Final delivery acceptance reads the original durable Request aggregate, including archived Requests; absence from the active outbox is not a delivery failure.

`npm run test:monitoring` covers account freshness/deduplication, partial reads, shared filesystems, incident/recovery behavior, bounded model changes, lost admission acknowledgement, manual recovery adoption, independent acceptance and delivery reconciliation, report boundaries, UI defaults and authenticated HTTP access. Complete normal CI before main delivery, then verify real desktop/mobile views, unchanged automation controls, source coverage and timer execution on the target instance. Saved schedules or passing tests do not establish that a future report reached its group.

# Agent monitor export boundary

Operator prompt: “Connect the existing Test metrics to the host site's Agent module. Keep calculations and publishing on RemoteLab. Give the host a versioned snapshot and a pinned contract; preserve its navigation, identity system and other features. Verify data equality, account access, stale-data behavior and the existing Test UI before switching the publisher.”

Resolve the source CLI, consumer module directory, destination file or existing Kubernetes context/namespace/source-manager deployment, and service-manager identity from the authorized instance. No new credentials, framework, monitoring server, or model call is needed. The scripts use Node built-ins and do not restart the RemoteLab server.

## Ownership

- Existing RemoteLab monitoring APIs own all metric calculations. `publish.mjs` calls those APIs, allowlists the result, and produces account status totals on the RL host.
- `contract.mjs` and `contract.d.mts` define the transport boundary. They have no website, renderer or runtime imports. `export-contract.mjs` installs pinned copies plus SHA-256 provenance into a consumer. Consumers do not import a live RL checkout and do not auto-update when RL changes.
- The consumer reads the snapshot, validates its schema, filters private account rows using its own identity, and renders the existing Test UI. `viewAgentSnapshot` only applies permissions and age flags; it does not aggregate metrics or accounts.
- UI assets remain an explicitly vendored Test renderer in the consumer. UI updates require a reviewed asset update; changing metric implementation alone does not require redeploying the website when the contract is stable.

## Contract v1

JSON: `schema: 1`, `source`, `publishedAt`, `dashboard`, `accounts`, `accountSummary`.

`dashboard` contains source-computed values, seven-day trends, sample counts, stage timings, coverage and semantics. Timezone is Asia/Shanghai, business day starts at 05:00; durations are milliseconds and ratios are percentages. Missing values remain null. Source `generatedAt` timestamps never become publish timestamps. Account summary contains `available`, `exhausted`, `unknown` totals. Account labels/quotas remain in the private `accounts` portion; consumers must filter it server-side.

Account summary is additive to v1: an older payload without it remains readable with summary null. Consumers must not reconstruct it from private rows. Invalid or unsupported versions fail closed; keep the last valid published file. Additive fields may be ignored by old readers. Renaming fields, changing units/meaning or removing fields requires a new schema version and coordinated reader migration.

The contract allows no session/run IDs, raw messages, source paths or credentials. It is an explicit allowlist, not a mirror of full monitoring responses. Aggregate publication does not authorize publishing the full RL dashboard API.

## Execution

- `node integrations/agent-monitor/publish.mjs --cli /absolute/rl/cli.js --source RemoteLab --output /private/snapshot.json` exports locally without a Hub checkout.
- `--publish` atomically replaces `latest.json` using an already authorized Kubernetes source-manager deployment. Required deployment-local environment: `AGENT_MONITOR_DESTINATION` (absolute mounted directory), `AGENT_MONITOR_KUBE_CONTEXT`, `AGENT_MONITOR_NAMESPACE`, `AGENT_MONITOR_DEPLOYMENT`. No target is hardcoded in shared source. Existing `--input` accepts a prevalidated snapshot for transport-only use.
- `node integrations/agent-monitor/export-contract.mjs /absolute/consumer/module` exports the two contract files and `contract-source.json`; review and commit the consumer diff. This is a release action, not a build dependency.

Use the existing deterministic publisher timer, switch its working directory/entry to this RL module and supply target settings through a private service environment file. Validate a real local export first, then run the unit once and read back the destination. A failed source read or publish preserves the previous snapshot. The consumer marks source data older than five minutes stale. No AI schedule is involved.

Validation: `node scripts/run-with-clean-instance-env.mjs node tests/test-agent-monitor-export.mjs`. The consumer must also validate its public/admin responses and visual interactions against a real snapshot before deployment.

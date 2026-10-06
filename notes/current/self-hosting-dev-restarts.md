# Self-Hosting Dev Restart Strategy

> Transport/runtimes are now HTTP-first with detached runners. This note stays focused on honest restart behavior for the single shipped chat plane.

> **Scope: compatible state formats and service configuration.** Before loading newer code, check the [Request state upgrade notice](../../docs/request-state-upgrade.md). The 2026-09-07 legacy conversion is a maintenance operation; it is not covered by ordinary restart recovery. Verify the actual process-manager policy preserves runners, and retain a maintenance entry point outside the service being stopped.

## Brutal truth

If the same `chat-server` process is both:

1. the thing carrying your live browser tab, and
2. the thing you are restarting,

then **transport continuity is still impossible by definition**.

What changed is the important part underneath that transport break:

- the browser no longer depends on live event streaming for correctness
- active runs can keep going in detached sidecars
- the control plane can restart, re-scan durable run output, and converge back to the same state

So the honest promise is now stronger than before, but still bounded:

- **No promise:** zero-disruption live socket continuity
- **Actual promise:** restart-safe control-plane recovery with durable HTTP state and detached active runs

## Current reusable workflow

### 1. Treat restart as transport interruption, not run loss

When the control plane shuts down during an active run:

- the browser loses its current socket / page continuity
- the detached runner keeps writing `status.json`, `spool.jsonl`, and `result.json`
- after reconnect, HTTP reads rebuild session and run state from durable files

### 2. Operational sequence

Before reporting a restart permission blocker, use the instance-scoped
`remotelab service-access check --json` and the
[service access workflow](../../docs/platform-skills/service-access.md).
It checks the registered sudo and loopback SSH alternatives without
restarting anything. A missing sudo entry alone is not evidence that every
authorized management route is unavailable. Fresh and resumed Harness
contexts carry the lookup entry; current capability evidence takes priority
over older blocked reports.

1. Work and code from `7690`
2. Restart `7690` when needed
3. Re-open / reconnect the chat UI
4. Validate the change through HTTP/state recovery, not socket continuity
5. Validate the recovered state through fresh HTTP reads rather than any client-local fallback

### 3. Keep standard instances on one source

Owner and standard guest instances on a host use the same mainline checkout. Instance config, memory, workspaces, credentials and deployment policies remain separate. A user-specific source copy is no longer needed once its changes are in main; a deliberate product fork has its own deployment lifecycle.

On Linux, `remotelab restart chat` snapshots the active guest set and validates the Owner and every active guest against the invoking checkout before restarting any service. A source mismatch stops the operation; correct the service source and its effective `REMOTELAB_PROJECT_ROOT` first. Disabled or otherwise inactive guests stay stopped. Restart errors return failure to the caller.

After a source update, read `/api/build-info` on every active standard instance and require the same clean `serviceCommit`. Restart separately managed Connectors from the same source too; detached guest Connectors can retain their old process until explicitly restarted. Keep stopped instances configured for the common source so their next authorized start uses the same version.

## What the current architecture solves

- repeatable single-plane restart workflow
- HTTP-canonical recovery after refresh/reconnect
- detached active runs surviving control-plane restarts
- optional WS invalidation hints instead of mandatory event streaming

## What is still intentionally out of scope

- zero-downtime browser transport continuity
- WebSocket replacement / transport redesign
- database migration beyond local filesystem storage

## Recommendation

Prioritize in this order:

1. Keep `7690` as the primary coding/operator plane
2. Validate restart behavior through HTTP state recovery, not stream continuity
3. Use ad-hoc manual instances only when a task explicitly benefits from them
4. Defer transport swaps and DB changes until they are separately justified

## Deferred cleanup TODO

- Keep the temporary legacy-upgrade cleanup in `setup.sh` for now so users who have not updated yet still get old `auth-proxy` / `ttyd` artifacts removed automatically.
- Revisit removing that cleanup after roughly 2–4 weeks, once the terminal-fallback removal has had time to propagate.

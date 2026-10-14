# Codex Session account allocation

Ask the instance's agent: “Enable balanced allocation for new Codex Sessions.
First verify an isolated RemoteLab instance can distribute concurrent Sessions,
resume on the same account and survive a control-plane restart. Preserve
existing conversations and running tasks, then enable it on this instance.”

The setting is under Settings → Connections → Codex: **Balance new Sessions
across accounts; keep subsequent turns on the same account**. It is off by
default for existing installations. The authenticated account-policy endpoint
accepts `POST /api/codex-auth/accounts/policy` with `{ "balanceSessions": true }`;
omitting `autoSwitch` preserves the independent reserve-switch setting.

## Behavior

- The first model execution for a new Session (including its input-label helper) chooses the eligible account with the
  fewest executing or starting Sessions. Ties go to the least recently assigned account.
  Allocation is equal-weight; plan names do not imply concurrency ratios.
- The account pool, credentials and load counts are local to this instance.
  Duplicate known subscription identities count as one account and share
  cooldown/exhaustion eligibility; another login is not additional capacity. Logged-out,
  confirmed exhausted or cooling accounts do not receive new Sessions. Quota
  freshness only breaks equal-load, equal-assignment ties; otherwise repeatedly
  refreshed busy accounts would attract all work. Unknown is not exhaustion.
  Selection reads cached observations without a foreground provider request.
- Selection, durable Session binding and startup registration use one metadata
  lock. A crash releases the short allocation lock and stale liveness records;
  completed and cancelled runs release their registration. A Session’s helper
  and primary run count once together. A finished input helper keeps a startup
  reservation until the primary starts; abandoned reservations expire after
  60 seconds, so the short preparation gap cannot attract more assignments. Execution stays
  concurrent: the metadata lock never surrounds inference.
- Enabling the setting preserves existing Sessions' most recently observed
  account from retained run status. Subsequent turns keep that account and the
  existing native thread. Session-associated naming/state and detached helper
  calls use the same binding, so background work cannot concentrate on the old
  default while every user turn is pushed elsewhere. Changing the default, adding accounts, reaching the
  reserve threshold or disabling balancing does not move bound Sessions.
  Forked Sessions are separate allocations; no running turn is transferred.
- A bound account that is logged out, exhausted, cooling, removed or known to
  have changed identity produces an explicit failure without launching on
  another account. Restore its authorization/quota and retry in that Session.
  There is no automatic task replay or cross-account failover.
- A terminal provider error containing HTTP 429 or “too many requests” records
  a 60-second local cooldown from the observed error time. It is distinct from
  subscription exhaustion, and fresh quota samples do not clear it. The generic
  Harness error currently does not expose Retry-After. This conservative fixed
  fallback may be replaced when structured retry information is available.
- If every account is unavailable, admission fails clearly without starting a
  model call. This first version does not add a global concurrency cap, waiting
  queue or automatic retry. Account distribution reduces concentration; it
  cannot guarantee removal of provider-wide or shared-network rate limits.

The existing reserve switch still selects the default for unbound execution.
Its default-account history is not evidence that a bound Session has moved.
`GET /api/runs/:runId` reports the actual `codexAccount` and assignment reason.
Bindings are private durable records under `codex-accounts/session-bindings/`;
credentials are not copied into them. Model, reasoning, tools and transcript
settings are not changed by allocation. Account model access still has to be
verified against the selected model.

## Validation and rollout

`tests/test-codex-session-routing.mjs` covers parallel allocation, independent
identities, existing-session preservation, restart, policy disable, cancellation,
cooldown, exhaustion and changed identity. `tests/test-http-codex-session-routing.mjs`
starts a real isolated loopback RemoteLab control plane with three synthetic
Codex App Servers. It starts six concurrent Sessions, restarts the control plane
while all six are executing, verifies same-account/thread follow-ups, and injects
429 to verify no replay or account switch. It uses separate state and credentials
and starts no real connector or scheduled work.

Run them through `scripts/run-with-clean-instance-env.mjs`. The isolated HTTP
test validates the full routing and recovery path; it does not measure a real
subscription's limits or prove model access. Use read-only, isolated native CLI
checks for real account/model compatibility before rollout where needed.

Deploy the verified source through the existing service manager, then enable
the policy and read it back. Keep active providers alive. Roll back allocation
by setting `balanceSessions` to false: new unbound Sessions use the selected
default, while existing bindings stay intact. A full source rollback also needs
the previous account policy and binding semantics reviewed; do not delete
bindings or credentials as a rollback shortcut.

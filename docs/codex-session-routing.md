# Codex Session account allocation

Ask the instance's agent: “Enable balanced allocation for new Codex Sessions.
First verify an isolated RemoteLab instance can distribute concurrent Sessions,
resume the saved conversation across account failures and survive a control-plane restart. Preserve
existing conversations and running tasks, then enable it on this instance.”

The setting is under Settings → Connections → Codex: **Balance new Sessions
across accounts; prefer the same account for healthy turns**. It is off by
default for existing installations. The authenticated account-policy endpoint
accepts `POST /api/codex-auth/accounts/policy` with `{ "balanceSessions": true }`;
omitting `autoSwitch` preserves the independent automatic-switch setting. Enable
`autoSwitch` to migrate unavailable bindings and continue failed quota/rate-limited
turns on another saved subscription; balancing alone does not enable failover.

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
- Enabling balancing records existing Sessions' most recently observed account
  as an affinity preference. Healthy subsequent turns and helpers retain that
  account and native thread. Changing the default or disabling balancing does
  not by itself move a healthy bound Session. Forked Sessions are separate allocations.
- With automatic switching enabled, an exhausted, cooling, removed, signed-out
  or changed-identity binding selects another eligible saved subscription. The
  replacement binding is durable. Unknown quota alone never moves a healthy
  Session. Fresh remaining quota at or below 10% may migrate before the next turn when no execution owns that Session and a fresh backup has more than 10%. Positive low balances remain usable if no such backup exists.
- If a provider stops with confirmed subscription exhaustion or HTTP 429, the
  same Run automatically acquires a different eligible subscription and resumes
  its saved native thread with a continuation instruction. The model, reasoning
  settings and tools stay unchanged. Completed actions remain in the thread;
  continuation asks the Harness to check uncertain results before retrying them.
  This is context continuation, not an exactly-once guarantee for external tools.
  No fresh-thread replay is allowed after output/tools when a saved thread is
  unavailable. Generic authentication/network errors do not trigger retries.
- Each account identity is attempted at most once per Run, including aliases.
  If the pool is unavailable, the Run ends with the failure and a recorded
  failover stop reason. With automatic switching disabled, unavailable bound
  Sessions fail explicitly until their authorization recovers or switching is enabled.
- A terminal provider error containing HTTP 429 or “too many requests” records
  a 60-second local cooldown from the observed error time. It is distinct from
  subscription exhaustion, and fresh quota samples do not clear it. The generic
  Harness error currently does not expose Retry-After. This conservative fixed
  fallback may be replaced when structured retry information is available.
- If every account is unavailable, admission fails clearly without starting a
  model call. This first version does not add a global concurrency cap, waiting
  queue or timed retry after the pool is exhausted. Account distribution reduces concentration; it
  cannot guarantee removal of provider-wide or shared-network rate limits.

The background reserve switch still selects the default for unbound execution.
`GET /api/runs/:runId` reports the actual `codexAccount`, assignment reason and
`codexFailover.attempts` for within-run migration. Quota observations in the spool
retain the account that produced each observation, so a late projection cannot
mark the replacement exhausted for the previous account’s failure.
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
429 to verify automatic migration within the same Run and native thread.
`tests/test-codex-account-failover.mjs` verifies both batch/native saved-thread
continuation, completed-action preservation, quota attribution, pool exhaustion
and the disabled-policy boundary. It uses separate state and credentials
and starts no real connector or scheduled work.

Run them through `scripts/run-with-clean-instance-env.mjs`. The isolated HTTP
test validates the full routing and recovery path; it does not measure a real
subscription's limits or prove model access. Use read-only, isolated native CLI
checks for real account/model compatibility before rollout where needed.

Deploy the verified source through the existing service manager, then enable
the policy and read it back. Keep active providers alive. Roll back allocation
by setting `balanceSessions` to false: new unbound Sessions use the selected
default, while healthy existing bindings stay intact. Disable `autoSwitch`
separately to stop automatic migration. A full source rollback also needs
the previous account policy and binding semantics reviewed; do not delete
bindings or credentials as a rollback shortcut.

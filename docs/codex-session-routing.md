# Codex personal binding and shared account allocation

Users bind their own account from **My Codex** in the sidebar (also the first
Settings section). Direct link: `/?tab=settings#settings-personal-codex`.
Choose **Bind my account**, copy the device code, authorize on the official
OpenAI page and return. Status updates automatically while this page is open.
No password or credential-file upload is required. The user may need to enable
device-code authorization in ChatGPT's Security settings, or obtain workspace
administrator enablement. [OpenAI device authorization](https://developers.openai.com/codex/auth#device-code-authorization).

The authenticated RemoteLab Person owns the binding. Browser and connector
identities linked to that same Person use it; names and email similarity do not
link identities. One personal account is supported per Person. Public account
binding remains under **Settings → Connections → Shared Codex accounts** and
requires administrator access.

## Personal routing policy

| Condition | Execution account |
| --- | --- |
| No personal binding | Existing shared allocation |
| Bound and usable, including low positive or unknown quota | That Person's account |
| Confirmed subscription exhaustion from fresh quota or the provider error | Shared pool; deterministic conversation notice |
| Authentication failure, incomplete reauthorization or rate limiting alone | Report the failure; no automatic use of shared quota |
| Personal quota recovers | Next request prefers the personal account |
| Explicit unbind | New requests use the shared pool |

Personal accounts are excluded from every shared candidate path, default
selection, Session-affinity migration, schedule preferences and background helper
allocation. System classification and other unattributed helper calls continue
using the shared pool. Existing shared account settings remain independent.
This feature covers Codex runtimes; Pi's separately authorized OpenAI provider is
unchanged.

The current fallback policy is `shared_on_exhaustion`. This is a temporary
product choice, not a personal spend cap: a long task can consume shared quota
after the user's subscription is exhausted. The notice identifies the switch;
it does not ask for approval. Future policy work should decide whether users can
disable fallback, whether shared consumption needs a budget, and who receives
that usage attribution. No budget or future permission gate is implied today.

## Implementation and ownership

- Existing records without `scope` remain shared. Personal records add
  `scope: personal`, `ownerPersonId`, `personalEnabled` and `boundAt` to the
  existing instance account store; each gets a separate credential home. Metadata
  updates use the existing lock. Shared selection rejects unknown ownership.
- The server validates the request's authenticated identity against its Person
  and freezes `codexAccountPolicy` at admission. Submitted owner/account fields
  are not authority. Personal ownership takes precedence over any prior shared
  Session binding and does not rewrite that binding.
- Native inputs may join a personal execution only with the same Person and
  personal binding. Other inputs remain queued for an execution using their own
  policy. A saved thread can continue after a quota failure; the original task
  is not replayed on a fresh conversation.
- Successful provider authorization is inspected before activation. Hashed
  OpenAI subject and workspace identity prevent the same login entering both
  personal and shared scopes, or two different Persons' bindings. A rejected
  duplicate cannot disable the original accepted account. Login replacement
  temporarily removes the target from assignment; active tasks prevent
  reauthorization and unbinding.
- Login jobs, device codes, cancellation and expiry are per Person. Completed
  bindings survive restart. Graceful server shutdown cancels pending device
  logins and releases their leases; users restart unfinished authorization.
  A crash during authorization may leave the provider login alive until it
  exits/expires; it cannot activate an unverified personal binding.
- The runner carries explicit exhaustion evidence to immediate failover rather
  than waiting for asynchronous quota-cache projection. Run state records
  `codexAccount.scope` and `personalCodexFallback`. The controller appends a
  system notice to Web history and enqueues it through the existing durable
  source outbox, keyed by Run; repeated observation or restart cannot create a
  second logical delivery.
- Ownership and allocation are enforced by this instance's server. Credentials
  remain on its trusted runtime host; this is not an OS sandbox or a
  cross-instance reservation registry. Do not register a personal credential in
  another instance's shared pool.

Personal endpoints require the user's own RemoteLab login, including for admins;
service tokens cannot perform these operations. They accept no owner, filesystem
path or credential material:

| Endpoint | Request |
| --- | --- |
| `GET /api/personal-codex/status` | Own status; `?refresh=1` refreshes quota |
| `POST /api/personal-codex/device-login` | `{ "restart": true }` |
| `POST /api/personal-codex/cancel-login` | `{}` |
| `POST /api/personal-codex/logout` | `{}` |

Responses contain `codexAuth` with status, own account/usage, active device code
and expiry, and the fallback policy. They are private/no-store. Shared APIs
remain admin-only and omit personal account metadata.

Implementation difficulty is moderate: native device authorization, credential
homes, quota observation and saved-thread continuation already exist. The
substantive changes are ownership at admission and allocation, login races,
deterministic fallback notification, and a discoverable mobile UI.

## Validation and rollback

`tests/test-personal-codex.mjs` covers ownership, duplicates, low/unknown quota,
rate limiting, exhaustion, independent login jobs, steering and notice deduplication.
`tests/test-http-personal-codex.mjs` runs a real isolated server with synthetic
provider authorization/inference, verifies two users, admin/service boundaries,
continuation, restart and recovery. Set `PERSONAL_CODEX_TEST_PLAYWRIGHT` and
`PERSONAL_CODEX_TEST_CHROME` to installed browser tooling for desktop/mobile UI
acceptance. These tests do not consume real subscriptions or send group messages.
The first real binding still requires its holder's OpenAI browser authorization.

Deploy the ownership-aware allocator before accepting personal credentials.
Rolling back UI or fallback behavior must retain ownership filtering. An older
allocator that treats every record as shared is unsafe once personal records
exist; never relabel a personal account as shared to make rollback work. Unbinding
removes its active authorization and routing preference, not its private scope.

## Shared pool

Ask the instance's agent: “Enable balanced allocation for new Codex Sessions.
First verify an isolated RemoteLab instance can distribute concurrent Sessions,
resume the saved conversation across account failures and survive a control-plane restart. Preserve
existing conversations and running tasks, then enable it on this instance.”

The setting is under Settings → Connections → Shared Codex accounts: **Balance new Sessions
across accounts; prefer the same account for healthy turns**. It is off by
default for existing installations. The authenticated account-policy endpoint
accepts `POST /api/codex-auth/accounts/policy` with `{ "balanceSessions": true }`;
omitting `autoSwitch` preserves the independent automatic-switch setting. Enable
`autoSwitch` to migrate unavailable bindings and continue failed quota/rate-limited
turns on another saved subscription; balancing alone does not enable failover.

## Behavior

- Operators can restrict this instance's pool with `routingAccountIds` on the same
  policy endpoint: an array of saved account IDs enables only those accounts;
  `null` restores all saved shared accounts and `[]` pauses shared admissions. Omission
  preserves the current restriction. Credentials and observations remain intact.
  The restriction applies to default selection, Session affinity, failover,
  schedule preferences and background helpers, including helpers without a
  Session ID. Existing executions finish under their original authorization;
  with `autoSwitch` enabled, their next execution migrates to an enabled account.
  The account list exposes both the restriction and each account's `routingEnabled`.
  An explicit selection of a paused account fails without resuming it.


- An operator may temporarily reserve a saved account for selected schedules via
  `CodexAccounts.mutate`: `automationRouting: { accountId, scheduleIds, maxConcurrentRuns }`.
  Only executions with an explicitly listed `manifest.scheduleId` prefer that account.
  Selection and liveness registration share the metadata lock and enforce the chosen
  temporary concurrency budget, including other live executions on the same subscription.
  Ordinary turns, unlisted schedules and default switching leave the reserved account
  out of their candidates. If it is busy, unavailable, cooling down, exhausted or already
  excluded by failover, the selected schedule uses the existing remaining-account policy.
  The preference never rewrites a human Session binding or interrupts a live execution.
  The account list exposes `automationRouting`; removing it restores normal allocation.

- Unbound background helpers also use balanced allocation when enabled; their
  liveness counts toward load without creating an empty Session binding.
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
  failover stop reason. The user-facing failure identifies unavailable pool capacity,
  and cancellation during account selection remains cancellation. With automatic switching disabled, unavailable bound
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

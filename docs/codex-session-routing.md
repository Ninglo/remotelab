# Codex personal binding and shared account allocation

Users with binding access bind their own account from **My Codex** in the sidebar
or from **Settings → Accounts → Codex**. Direct link: `/?tab=settings#settings-personal-codex`.
Choose **Bind my account**, copy the device code, authorize on the official
OpenAI page and return. Status updates automatically while this page is open.
No password or credential-file upload is required. The user may need to enable
device-code authorization in ChatGPT's Security settings, or obtain workspace
administrator enablement. [OpenAI device authorization](https://developers.openai.com/codex/auth#device-code-authorization).

To grant selected people access, use **Manage sharing** under your Codex binding in [Accounts](model-source-sharing.md).
Shared Codex accounts still use the separate administrator-managed pool.

The authenticated RemoteLab Person owns the binding. Browser and connector
identities linked to that same Person use it; names and email similarity do not
link identities. One personal account is supported per Person. Public account
binding is under **Settings → Accounts → Codex → Public** and
requires administrator access.

Personal binding is enabled per instance. Set
`REMOTELAB_PERSONAL_CODEX_PERSON_IDS` on the chat service, then restart it:

- `*` opens binding to all authenticated People, including newly registered members.
- A comma-separated list of verified Person IDs limits access to those people.
- An unset or empty value opens it to nobody.

Service identities, the system Person and anonymous visitors cannot bind an
account in any mode. Administrator status does not bypass a selective list.
Actual participant IDs and rollout choices belong in instance configuration.
Bootstrap and `/api/auth/me` expose only the caller's
`features.personalCodexBinding` boolean. The sidebar, Settings directory and
section remain hidden without that capability, including direct links; all
`/api/personal-codex/*` operations reject callers without binding access with 403.
Shared account administration remains unchanged.
The frontend bootstrap preserves both this capability and the server's
administrator flag, so an unenrolled administrator still sees shared controls.

This switch controls access to binding settings, not existing execution:
removing someone's binding access does not unbind their account, interrupt
tasks or change ownership/routing. Keep an existing owner enrolled while they
need to manage a binding; unbind deliberately before retiring it. To withdraw
the binding UI, clear the setting and restart; restoring it restores access.

## Personal routing policy

| Condition | Execution account |
| --- | --- |
| No personal binding, authorized group binding | An eligible group account, isolated from the public pool |
| No personal binding or group grant | Existing shared allocation |
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

## Pi with OpenAI

New requests using the Pi Harness and the `openai-codex` provider take a lease
from the same Codex account pool as the Codex Harness. Account ownership,
personal quota fallback, shared priority and concurrency are governed by the
same policy. Other Pi providers keep their own credentials.

The detached runner gives Pi only the selected account's current access token
in a private runtime directory. Codex refreshes its own stored login when
needed. Pi uses the native conversation directory across runs and the built-in
OpenAI provider configuration, with extension discovery and project provider
overrides disabled for pooled credentials. The runner removes its temporary
credential on exit. A quota failure updates the pool. Pi can switch accounts
within a run before it has emitted an answer, used tools, or received a
follow-up. When work may have happened, the next request can continue the saved
Pi conversation using a new lease.

## Codex tool bridge

Every native Codex App Server run receives a session-scoped stdio MCP server named `remotelab`. The server starts from the trusted RemoteLab checkout and inherits the runner's `REMOTELAB_SESSION_ID`, service authentication and local-helper base URL; the model never receives a service token or a second session identifier.

The bridge publishes only the existing local-helper contract:

- `remotelab_local_bridge_status`
- `remotelab_local_bridge_list`
- `remotelab_local_bridge_find`
- `remotelab_local_bridge_stat`
- `remotelab_local_bridge_read_text`
- `remotelab_local_bridge_stage`
- `remotelab_local_bridge_pack`

Reads are bounded and paths are sent as root aliases plus relative paths. `stage` and `pack` are explicit Session-attachment writes. Pairing/bootstrap operations and arbitrary device commands are not exposed to the model. A robot action adapter can be added only when the local helper publishes a stable, allowlisted command schema; the bridge does not turn an arbitrary JSON command into hardware control.

The bridge is injected through Codex config overrides in `chat/native/codex.mjs`, so saved-thread continuation and personal-account failover use the same tool surface. Personal quota selection remains the existing `codexAccountPolicy` path described above; this bridge does not change account ownership or fallback.

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
continuation, restart, recovery and instance-wide enrollment. Set
`PERSONAL_CODEX_TEST_PLAYWRIGHT` and `PERSONAL_CODEX_TEST_CHROME` to installed
browser tooling for desktop/mobile UI
acceptance. These tests do not consume real subscriptions or send group messages.
The first real binding still requires its holder's OpenAI browser authorization.

Deploy the ownership-aware allocator before accepting personal credentials.
Rolling back UI or fallback behavior must retain ownership filtering. An older
allocator that treats every record as shared is unsafe once personal records
exist; never relabel a personal account as shared to make rollback work. Unbinding
removes its active authorization and routing preference, not its private scope.

## Shared pool

Ask the instance's agent: “Configure each shared Codex account's concurrency
limit and priority, verify overflow and waiting in isolation, then deploy while
preserving running work. Use the requested account values; do not tune limits
automatically.”

Settings → Accounts → Codex → Public has **Enable use**, **Temporarily
disable**, and **Remove** controls. New accounts default to enabled. Disabling
preserves credentials and running executions; subsequent requests use the remaining
eligible pool, even when automatic retry is off. Removing hides an entry and
excludes it from new work without deleting authorization or history.

Only administrators manage shared accounts. Routing writes use
`POST /api/codex-auth/accounts/routing` with `{ "accountId": "<saved ID>", "enabled": false }`.
Removal uses `/api/codex-auth/accounts/remove`. Per-account mutations run under the
metadata lock, so stale browsers cannot overwrite another account's setting.
Personal bindings retain their independent ownership and fallback policy.

Each row also has **Concurrency limit** (positive integer; blank means unlimited)
and **Priority** (non-negative integer; lower goes first), plus a Save button.
The defaults are unlimited and priority 10. The same routing endpoint accepts
`{ "accountId": "<saved ID>", "maxConcurrent": 3, "priority": 1 }`; JSON `null`
means unlimited. Omitted fields retain their values. Settings are saved under
the metadata lock and applied to every known login alias of that subscription.
An alias cannot multiply capacity. Enabling/disabling remains a per-entry control.

The list shows current execution occupancy, effective limit, exclusion reason,
distinct assignable subscriptions and the shared waiting count. A new configuration
applies to subsequent allocation without restarting. Lowering a limit below current
occupancy lets existing executions finish and admits no more until space is available.
These controls govern this instance's independent executions, including background
helpers, not the provider's internal requests, native subagents or other instances.
No account's manual limit is automatically raised or lowered after a rate-limit error.

### One allocation path

- `disabledAccountIds` stores explicit exclusions. Legacy `routingAccountIds`
  remains an API compatibility projection; omitted fields preserve choices and
  new accounts still default to enabled.
- New turns, background helpers and scheduled work all use the same allocator:
  eligibility and spare capacity, then lowest priority number, then same-account
  continuation within that priority, then fewest active executions and rotation.
  `balanceSessions: false`, the selected default and legacy `automationRouting`
  no longer select a separate admission path or reserve accounts.
- Each new execution considers priority again, including a recurring automation
  whose Session previously used a lower-priority account. Native threads continue
  across authorization changes. Active executions are not moved. Disabled,
  removed, signed-out, cooling, exhausted, changed-identity or full bindings are
  skipped. Low positive or unknown quota is still eligible. Occupancy measures
  independent active executions, not tokens or historical conversations.
- Duplicate known subscription identities count once, including their live load,
  failure exclusions and cooldown. Personal accounts never join shared candidates.
- Selection, binding and liveness registration share one short metadata lock;
  inference remains concurrent and does not hold that lock. An independent helper
  and its main run each occupy a slot; completed helpers hold none. Steering an
  existing execution does not allocate another slot. No foreground quota RPC is added.
- Quota observations and the legacy background default indicator remain compatible
  with older readers; that default does not override balanced admission.

### Failures and account identification

`autoSwitch` controls retry **within a failed Run**, not admission or disabling.
When enabled, confirmed exhaustion, 429 and recognized capacity errors may continue
on another eligible subscription using the saved native thread. Each identity is
tried at most once. Completed tool effects are preserved; without a saved thread,
work that already produced effects is never replayed from scratch. Authentication
and network failures do not trigger blind account retries.

If otherwise eligible accounts are full or cooling, the original execution waits
without starting a model request. Its visible status says it is waiting for an
account and the normal stop action cancels it. Release and account-file changes
wake waiters through filesystem notifications; a bounded two-second liveness check
recovers dead-runner slots and observes cancellation. Waiting expires after ten
minutes by default (`REMOTELAB_CODEX_CAPACITY_WAIT_MS` changes this wait budget;
callers may supply a shorter `waitTimeoutMs`). No metadata lock is held while waiting.
This is not an execution timeout. Wait records are removed on acquisition, failure
or cancellation; expired/dead-owner records are reclaimed on observation.

A missing or unreadable owner file with an existing slot directory still reserves
one place. Other eligible accounts and capacity that is independently known to
be free remain available. Failed reads do not shorten the wait budget. If they
still prevent admission at the normal deadline, the task reports that occupancy
could not be confirmed, rather than treating the account as full.

Each newly allocated slot has its own directory key; normal release does not
read the mutable owner file. A keyed detached run with trustworthy launch records
can be recovered after its process group and any recorded tool process have
stopped. An unreadable legacy slot, or one without enough evidence to verify exit,
is kept until release or operator verification. Directory age alone does not
reclaim a slot. The owner file retains its existing write pattern and format.

If no temporary candidate remains, `CODEX_NO_AVAILABLE_ACCOUNT` reports counts
of disabled / credential-error, signed-out, exhausted and already-attempted entries.
Permanently unavailable pools fail clearly rather than waiting for a login or refill.

The runner records `codexAccountFailure` with account ID, display label, model,
time and kind (`capacity`, `rate_limited`, `quota_exhausted`). Terminal errors include
that account's label and ID, including when failover runs out of candidates.
`codexFailover.attempts` retains the sequence of actual replacements. No tokens or
credential paths enter these diagnostics.

The administrator account list shows the most recent classified failure, model,
time and account ID beside the existing disable control. It exposes `lastFailure`,
`cooldownUntil` and `blockedUntil`. A capacity/429 observation uses the existing
60-second cooldown; this is temporary failure evidence, not an administrator disable
or proof of an account-specific cause. Provider-wide capacity limits can affect all
accounts. Historical failure information remains visible after recovery.

### Validation and deployment

`test-codex-allocation-limits.mjs` covers concurrent limits, priority overflow,
unlimited fallback, duplicate identities, helper occupancy, wait/release,
configuration wakeup, cancellation, deadlines, shrinking, restart and crash recovery.
`test-codex-run-slots.mjs` covers partial/corrupt owner reads, unaffected capacity,
release with a corrupt file, the distinct wait deadline, and child-process recovery.
`test-codex-session-routing.mjs` covers concurrent equal allocation, aliases,
personal isolation, disabled bindings with retry off, all-disabled diagnostics,
quota recovery, helper allocation, cancellation and restart. The scheduled test
verifies that old reservation settings cannot exclude or reactivate an account.
`test-codex-account-failover.mjs` exercises batch/native continuation, capacity
attribution, finite exhaustion and no replay after effects. Background quota tests
hold persistence while an admitted native turn completes; allocator registration
itself correctly waits for the metadata lock.

Use the standard shared-source deployment and verify `/api/build-info` after
restarting active services. Preserve running authorizations, disabled exceptions,
personal scope, histories and Session bindings. Older allocators reintroduce the
legacy policy gates; `balanceSessions: false` is no longer a rollback switch.

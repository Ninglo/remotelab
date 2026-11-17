# Codex account and quota status

Settings → Codex login now shows the current account's display name (when supplied), email and plan. API-key sign-in is labelled explicitly. Quota loads independently so a slow usage endpoint does not delay identity or the login controls. Identity reads have a 12-second deadline; remote quota reads allow up to 45 seconds (live transport can exceed 25 seconds). Each supplied quota bucket shows remaining percentage, its actual window duration and reset time, plus the observation time. Unknown windows do not become zero; elapsed reset times request a refresh rather than implying a renewed balance.

The only Codex RPCs are `initialize`, `initialized`, `account/read` with `refreshToken: false`, and `account/rateLimits/read`. No thread, turn, prompt, model, AI session, scraping, or usage estimation is involved. Protocol reference: https://learn.chatgpt.com/docs/app-server#auth-endpoints . Codex remains the authentication and token-refresh authority; RemoteLab never refreshes grants itself.

`lib/codex-account-status.mjs` implements a bounded stdio exchange with the installed CLI and the same resolved Codex home as the instance. It returns an allowlist of public fields. A local ID-token name is display-only and only joins a matching RPC email. Tokens and raw provider errors are never returned. A credential revision prevents combining a query with a login changed while it was in flight; the UI also discards earlier request generations and mismatched account revisions. Missing names remain missing.

The existing authenticated `/api/codex-auth/status` adds `account` and an opaque `accountRevision`. `/api/codex-auth/rate-limits` returns `codexUsage` independently. Both are private/no-store HTTP responses. Usage has a process-local 60-second cache bound to the resolved home and credential revision, concurrent requests share one query, and explicit Check status requests bypass the cache. Keyring-backed accounts without a local revision are not cached. Logout invalidates cached usage. Missing/failed usage is visible and retryable; API-key or other non-ChatGPT auth reports that subscription limits are unsupported.

Validation: `test-codex-account-status.mjs` exercises safe projections, multiple buckets, missing fields, exhausted windows, changed accounts, mismatched local names, errors, timeouts, cache invalidation, single-flight reads, logout and owner authorization. `test-codex-account-settings-ui.mjs` executes the UI in a VM to verify literal identity text, both languages, quota formatting and stale-request rejection. Existing device-login/logout and account-switch tests remain in the merge-safety suite. Installed-CLI checks use only the read-only methods above.

## Saved accounts and background default selection

Settings → Connections → Codex lists saved accounts with **开启使用 / 暂时禁用 / 移出** controls. New accounts default to enabled; `disabledAccountIds` stores exceptions. A legacy allowlist migrates against existing entries, so it cannot silently exclude future additions. Adding an account starts an independent device login and keeps existing accounts signed in. Completion is handled when the login process exits, without requiring the browser to keep polling; ownership inspection does not wait for quota. Reauthorizing an explicitly disabled account preserves that choice and releases the login lease, including on failed inspection. The list shows credential issues and emails to distinguish identical display names. A healthy running turn retains its selected account; automatic switching can resume a failed quota/rate-limited turn on another saved authorization. Removal hides the entry and excludes new assignments without deleting its authorization or interrupting a run. Explicit logout remains a separate compatibility API, refused while that authorization is in use. API endpoints include `GET /api/codex-auth/accounts`, `POST /api/codex-auth/accounts/routing`, `POST /api/codex-auth/accounts/remove`, and the existing policy, selection and reauthorization endpoints. No endpoint accepts credential material or filesystem paths.

The instance-local `config/codex-accounts/accounts.json` stores the list and policy. The original Codex home is the default slot. New account homes hold separate, continuously refreshed credentials while sharing local conversation files and instructions. New records also set `sqliteHome` to that existing conversation home; login, identity/quota checks, foreground runs, failover and background helpers pass it through Codex's `CODEX_SQLITE_HOME`. This prevents each authorization from rebuilding the same history index and timing out before identity becomes readable. Existing accounts retain their own SQLite state unless explicitly repaired, preserving their runtime state. The installed CLI supports this environment setting; the official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents the corresponding `sqlite_home` runtime-state directory. Switching never copies or restores credentials. Automatic switching defaults off until enabled for that instance; individual accounts default on.

Regression coverage: `test-codex-account-lifecycle.mjs` checks legacy migration, new-account defaults even after disabling every current account, browser-independent login completion, disabled reauthorization, lease recovery, and removal while a run remains active. `test-codex-routing-controls.mjs` checks administrator-only HTTP operations, desktop/mobile controls, persisted disable/remove, and ordinary-member isolation.

Foreground requests use one shared allocator for new Sessions, helpers and scheduled work.
Healthy Session continuations retain their account. Disabled or unavailable bindings
are reassigned independently of automatic retry; low positive quota is still usable.
The selected default and legacy scheduling reservations no longer control admission.
See [Codex shared allocation](../../docs/codex-session-routing.md#shared-pool) for
current selection, diagnostics, compatibility and deployment behavior.

One lightweight monitor samples accounts in the background every 30 seconds and
reuses recent samples. Active accounts use an existing native App Server; idle
accounts use the read-only status exchange. Quota projection is asynchronous and
cannot delay completion of an admitted turn. The legacy default/reserve indicator
is retained for compatibility, but does not override the allocator.

Quota exhaustion, rate limiting and capacity failures retain their account ID,
model, category and observation time. The administrator list displays the most
recent failure beside the enable/disable controls. Raw credentials and provider
error bodies are not added to that list. Failure observations remain historical
when cooldown expires; a capacity error does not permanently disable an account.

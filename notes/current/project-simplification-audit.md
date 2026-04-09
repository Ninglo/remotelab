# Project Simplification Audit

> Status: current audit snapshot for reducing conceptual and compatibility bloat in RemoteLab.
> Scope: repo-wide simplification, not one isolated legacy artifact.
> Last updated: 2026-04-09

---

## What Was Confirmed

- RemoteLab complexity is no longer concentrated in one obvious legacy route or one old feature.
- The remaining bloat is structural: product objects, bootstrap flows, share/access models, and legacy field readers overlap in the same runtime.
- The codebase already prefers `sourceId` / `sourceName` and `templateId` / `templateName` in many main-path reads, but older `app` / `visitor` / principal-era fields still survive in compatibility readers and test fixtures.

---

## Cleanup Already Landed

- Shared principal normalization now lives in `chat/session-source-resolution.mjs`, with routers and session-manager reusing the same helper path.
- Shared auth/session agent resolution now also lives in `chat/session-source-resolution.mjs`, reducing duplicated `agentId` / `templateId` / scoped-agent fallback code.
- The legacy Video Cut product embedding was removed from the repo. It no longer survives as a built-in/legacy app migration path.
- Welcome starter behavior is now keyed by `starterPreset: welcome` instead of normal session-management logic depending on `templateId: app_welcome`.
- `Welcome`, `Basic Chat`, and `Create Agent` no longer survive as built-in `/api/agents` product objects; the remaining starter flows now materialize directly from starter presets or bootstrap definitions.
- Stored session metadata now hard-deletes legacy app-era fields (`appId`, `appName`, `templateAppId`, `templateAppName`) during normalization instead of migrating or preserving them.
- Starter-app copy/prompt payloads have started moving out of `chat/apps.mjs` into dedicated starter-content modules, so app registry and starter behavior are no longer fused into one file.
- Frontend/session hydration fixtures are being moved back onto canonical `sourceId` / `sourceName` session shapes, and old app-field migration coverage is being removed instead of preserved.
- The contraction note was updated so its implementation-status section matches current code more closely.

---

## Main Redundancy Clusters

### 1. Starter presets still need a clean product boundary

Primary files:

- `chat/apps.mjs`
- `chat/starter-session-content.mjs`
- `chat/session-starter-preset.mjs`
- `chat/bootstrap-sessions.mjs`
- `chat/router-session-main-routes.mjs`
- `tests/test-apps-builtins.mjs`
- `tests/test-http-session-templates.mjs`

What remains:

- The owner-facing starter app objects are gone from `/api/agents`; only `chat` and `email` remain as built-in non-template scopes.
- `Create Agent` now opens as a direct starter-preset session instead of depending on hidden built-in agent lookup in settings UI.
- Welcome bootstrap still uses dedicated starter content and preset wiring, but that coupling is now localized to bootstrap/session creation rather than owner-visible app/template state.

Why it matters:

- The runtime no longer needs starter flows to masquerade as durable agent inventory, but starter behavior is still implemented as special-case preset content rather than one fully generalized product concept.

Recommended cut:

1. Keep starter-specific behavior confined to preset/bootstrap files and out of owner-visible agent listing.
2. Continue moving remaining special-case starter/session retirement logic out of generic session management.
3. Avoid reintroducing hidden built-in template ids for onboarding/builder flows.

### 2. Interactive share and contraction notes still pull in different directions

Primary files:

- `chat/router-public-routes.mjs`
- `chat/router.mjs`
- `notes/current/session-first-product-contraction.md`
- `notes/current/interactive-agent-share-architecture.md`
- `tests/test-chat-static-assets.mjs`

What remains:

- `/agent/:shareToken` is an active interactive share surface.
- `/app/:shareToken` has been removed; only `/agent/:shareToken` remains as the interactive public share surface.
- The contraction note still wants interactive visitor entry removed in principle, while the interactive-agent-share note explicitly reopens this area.

Why it matters:

- Share/access simplification cannot finish until one note becomes the dominant truth for current implementation.

Recommended cut:

1. Treat `interactive-agent-share-architecture.md` as authoritative for current code.
2. Update other notes/tests/docs to stop implying that interactive share is already removed.
3. Continue deleting share/access concepts only when they still exist in the runtime, not because old notes still mention them.

### 3. Dual-era session and auth fields still survive in fallback readers

Primary files:

- `chat/session-manager.mjs`
- `chat/router.mjs`
- `chat/router-public-routes.mjs`
- `chat/session-meta-store.mjs`
- `tests/test-session-app-scope.mjs`
- `tests/test-session-http-sidebar-refresh.mjs`
- `tests/test-session-http-ref-hydration.mjs`

What remains:

- Session metadata normalization now simply deletes `appId`, `appName`, `templateAppId`, and `templateAppName` from stored session records.
- Auth/session visibility still needs narrowed cleanup around visitor-era fields, but legacy auth-session `appId` fallback is gone.
- Visitor-scoped flows still depend on `visitorId` even after principal normalization.

Why it matters:

- The repo pays complexity cost on every read path, not just on migrations.

Recommended cut:

1. Finish sweeping tests so canonical fixtures use current fields only.
2. Narrow visitor-era ownership fields once the remaining shared-session paths are isolated.
3. Remove or rewrite stale notes that still describe deleted app-era concepts as active.

### 4. Docs and tests still overstate completed simplification

Primary files:

- `notes/current/session-first-product-contraction.md`
- `notes/current/core-domain-refactor-todo.md`
- `notes/current/core-domain-implementation-mapping.md`
- session/share/bootstrap tests under `tests/`

What remains:

- Some notes describe concepts as already removed when live code/tests show they still survive in narrowed form.
- Some tests still use old field names as ordinary fixtures rather than explicitly labeling them as legacy fixtures.

Why it matters:

- This creates false confidence and makes future cleanup sessions choose the wrong “safe” deletion target.

Recommended cut:

1. Keep the contraction note honest about current implementation.
2. Sweep tests so canonical fixtures use current fields by default and legacy fixtures are explicitly marked as migration coverage.

---

## Recommended Execution Order

1. Starter-app subtraction
2. Share-model note reconciliation
3. Frontend/test fixture canonicalization
4. Final removal of leftover reader fallbacks once migration coverage proves they are no longer needed

---

## Guardrails

- Avoid mixing starter-app subtraction with share-model behavior changes in one patch.
- Do storage cleanup before deleting read fallbacks.
- Keep end-to-end session/share tests around each slice; do not rely only on grep-based confidence.

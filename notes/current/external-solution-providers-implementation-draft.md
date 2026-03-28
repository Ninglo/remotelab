# External Solution Providers — Implementation Draft

Status: current implementation draft as of 2026-03-28

Companions:

- `notes/current/external-solution-providers.md`
- `notes/current/knowledge-layers-and-connectors.md`
- `notes/current/product-mainline.md`
- `notes/current/user-feedback-log.md`

## Why this note exists

- The product already has the right architectural stance: external solution providers are fallback adapters, not the domain layer.
- The next risk is implementation drift: a temporary provider such as `evomap` could leak its auth model, taxonomy, or response shape into the planner, memory, or shared knowledge path.
- This note defines the smallest implementation shape that keeps the first external provider useful but replaceable.

## Core rule

- Route `local domain first, external provider second`.
- Normalize all external results into one provider-agnostic evidence bundle before synthesis.
- Keep external output attributable and temporary.
- Default to `no automatic writeback` into shared domain knowledge, private user memory, or canonical product notes.

## Provider-agnostic evidence schema

Bundle-level fields:

- `bundleId` — local identifier for this retrieval result
- `route` — fixed value such as `external_fallback`
- `providerId` — provider identity such as `evomap`
- `providerVersion` — optional provider version when available
- `querySummary` — concise restatement of the task or information request
- `domainHints` — normalized domain tags such as `hotel`, `operations`, or `revenue`
- `locale` — language or geography hints used in retrieval
- `retrievedAt` — timestamp for provenance
- `latencyMs` — end-to-end provider latency
- `coverage` — normalized coverage signal such as `low`, `medium`, or `high`
- `confidence` — normalized confidence signal for the returned evidence, not a truth guarantee
- `freshness` — normalized freshness bucket such as `current`, `recent`, `stale`, or `unknown`
- `applicableScenarios` — situations where the bundle is likely useful
- `limitations` — known caveats, scope boundaries, or missing context
- `evidenceItems` — normalized evidence list
- `workflowSkeletons` — optional process or analysis outlines suggested by the provider
- `gaps` — explicit missing pieces, uncertainty, or unresolved conflicts
- `writebackPolicy` — fixed default such as `manual_review_only`

Evidence-item fields:

- `itemId` — local item identifier within the bundle
- `title` — short evidence title
- `snippet` — normalized summary or extracted text
- `sourceLabel` — human-readable source name
- `sourceRef` — source URL, document ID, or provider reference when available
- `provenanceType` — source class such as `provider_summary`, `doc_excerpt`, or `workflow_hint`
- `confidence` — normalized per-item confidence
- `freshness` — normalized per-item freshness
- `applicableScenarios` — specific scenarios where the item applies
- `limitations` — item-level caveats or assumptions
- `conflictFlags` — optional indicators that the item conflicts with other evidence

Field semantics:

- `confidence` expresses support strength and provider certainty, not objective truth.
- `freshness` exists because domain advice can age unevenly; stale-but-useful material should stay visible but downgraded.
- `applicableScenarios` keeps the synthesis layer from over-generalizing domain advice.
- `limitations` is required because fallback provider output is often directionally helpful but incomplete.

## Writeback and promotion rule

- External bundles are temporary execution evidence, not durable knowledge by default.
- Raw provider output may be cached for short-term reuse, but only in disposable, provider-tagged storage.
- Promotion requires a separate review step that extracts a redacted abstraction from the external evidence.
- The promoted abstraction should not depend on provider-specific terminology, IDs, or credentials.
- Private user details from the live task should not be promoted together with the abstraction.

## Router contract

Router input:

- task summary or question
- domain hints
- desired output shape
- locale and language
- policy constraints
- latency budget
- local retrieval summary

Router output:

- synthesis source choice: `local_only`, `local_plus_external`, or `external_only_fallback`
- normalized evidence bundle when an external provider is used
- route status and error category when external retrieval fails or is skipped

## Router decision flow

1. Run local domain retrieval first.
2. Score the local result on coverage, confidence, and actionability.
3. If local coverage is strong enough, stop and answer from local evidence.
4. If local coverage is weak and policy allows, call one external provider.
5. Normalize provider output into the evidence bundle.
6. Synthesize the answer with provenance preserved.
7. Keep writeback disabled unless a separate review path explicitly promotes a redacted abstraction.

## Router trigger conditions

Trigger external fallback when one or more of these are true:

- local retrieval returns no meaningful domain evidence
- local coverage is `low`
- local evidence lacks a usable workflow skeleton or baseline process
- the task clearly targets an unfamiliar domain such as a new industry vertical
- the user is asking for baseline domain context rather than only personal/project context
- the agent detects that answering from local material would likely hallucinate domain specifics

Do not trigger external fallback when one or more of these are true:

- local evidence already meets the task with acceptable confidence
- policy or privacy rules block external query transmission
- network access is unavailable or disabled
- the provider is not configured or is in a known failed state
- the task is primarily about private user context that should not leave the local environment

## Timeouts, retries, and degradation

- Local retrieval soft target: about `1.5s`; hard stop: about `3s`
- External provider soft target: about `6s`; hard stop: about `12s`
- Total route budget for the MVP: about `15s`
- Retry at most once, and only for retryable categories such as `timeout`, `transport_failed`, or `rate_limited`
- Do not retry `auth_missing`, `invalid_request`, or `invalid_response`
- Use jittered backoff for the single retry so the router does not immediately hammer the provider

Degradation rules:

- If local retrieval is weak and external fallback times out, return the best local answer with an explicit gap marker rather than pretending domain certainty.
- If the provider returns partial evidence, surface it with `low` or `medium` coverage rather than dropping it silently.
- If both local and external routes are weak, the system may return generic reasoning, but it must avoid claiming domain-specific best practices as verified facts.

## `evomap` adapter boundary

Adapter input:

- normalized task summary
- normalized domain hints
- desired output shape
- locale and language
- policy constraints that affect the query
- latency budget

Adapter responsibilities:

- translate the normalized input into the `evomap` request shape
- handle provider-specific auth and request formatting
- parse the provider response
- normalize the response into the shared evidence bundle
- map provider-specific failures into shared router error categories

Adapter output:

- one normalized evidence bundle on success
- one shared error category plus brief diagnostic metadata on failure

Auth isolation:

- Store `evomap` credentials in local config or environment, not in repo notes, user memory, or shared domain material.
- The router should know only whether `evomap` is enabled, configured, and currently healthy enough to try.
- Provider secrets, quota state, and raw headers stay inside the adapter or its local config surface.

Error mapping:

- missing or invalid credential -> `auth_missing`
- provider timeout -> `timeout`
- network transport failure -> `transport_failed`
- provider quota or throttle -> `rate_limited`
- invalid caller payload -> `invalid_request`
- malformed provider payload -> `invalid_response`
- provider outage or 5xx -> `provider_unavailable`

## Smallest useful `evomap` integration

- one adapter module for `evomap`
- one provider registration entry that exposes only the normalized contract
- one local config surface for enablement and credentials
- one disposable cache namespace tagged with `providerId`
- one smoke-test path that verifies auth and basic response normalization
- zero automatic promotion into shared knowledge or user memory

## Provider replacement boundary

Changing providers later should require edits only in these places:

- provider adapter module
- provider registration or routing config
- provider-specific local credentials/config
- provider-specific fixtures or smoke tests

These layers should stay unchanged when swapping providers:

- local domain storage shape
- private user memory shape
- planner/router contract
- normalized evidence schema
- synthesis logic other than optional capability flags
- promotion and review workflow
- user-facing product language about domain fallback

Provider details must not leak into these layers:

- shared knowledge notes
- user memory or personal profile structures
- planner prompts that should reason over normalized evidence only
- canonical workflow tags or taxonomy
- durable product docs except where a temporary experiment is explicitly called out

## Smallest next implementation slice

- define the normalized evidence bundle in one shared module or note-backed contract
- add one `local-first / external-second` router decision point
- add one `evomap` adapter behind that contract
- log provider outcomes using shared error categories only
- expose provenance in the synthesis layer
- leave writeback disabled until there is an explicit review path

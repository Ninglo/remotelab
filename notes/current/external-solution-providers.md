# External Solution Providers

Status: current working note as of 2026-03-28

Companions:

- `notes/current/knowledge-layers-and-connectors.md`
- `notes/current/external-solution-providers-implementation-draft.md`
- `notes/current/product-mainline.md`
- `notes/current/user-feedback-log.md`

## Why this note exists

- Some user tasks need baseline domain context even when RemoteLab does not yet have a strong local domain pack.
- The product needs a fallback search / solution channel without turning whichever provider is convenient today into long-term product truth.
- Current example: a hackathon may require `evomap`, but that should still look like a temporary provider choice rather than a permanent architectural dependency.

## Positioning

- An external solution provider is a fallback retrieval adapter, not the shared `domain layer` itself.
- It lives on the capability side, but its output contributes temporary evidence for the current task.
- Its output is not canonical truth and should not automatically write into shared knowledge, user memory, or product docs.

## Routing rule

1. Check the local domain layer first.
2. If local coverage is weak and policy allows, query one or more external providers.
3. Normalize the result into one provider-agnostic evidence bundle.
4. Synthesize the answer with source/provenance visible to the agent and, when appropriate, to the user.
5. Promote only redacted abstractions through a separate review path.

## Minimum provider contract

Adapter input:

- task or question
- domain hints such as `hotel`, `operations`, or `revenue analysis`
- desired output shape
- locale and language
- depth or latency budget
- policy constraints

Normalized output:

- `providerId`
- `providerVersion` when known
- query summary
- coverage/confidence signal
- domain tags
- evidence items with title, snippet, and source reference
- suggested workflow skeletons when available
- explicit gaps, uncertainty, or conflict flags

## Isolation rules

- Keep provider-specific APIs, auth, prompt templates, retries, and parsers inside the adapter boundary.
- Keep the planner/router speaking only the normalized contract.
- Keep provider credentials, toggles, and quotas outside shared knowledge notes.
- Keep provider-specific taxonomies or schemas from leaking into the core product model unless they survive a later abstraction pass.
- Allow caching if useful, but keep cache disposable and provider-tagged.

## `evomap` stance

- `evomap` is acceptable as a near-term experimental provider or hackathon requirement.
- Wrap it exactly like any future provider: one adapter, one config surface, one normalized output contract.
- Do not make shared memory, domain storage, or planner behavior depend on `evomap`-specific concepts.
- A future swap should mostly mean changing routing config or adding another adapter, not rewriting the knowledge architecture.

## Smallest useful MVP

- one router decision: `local domain first, external fallback second`
- one normalized evidence schema
- one `evomap` adapter behind that schema
- one explicit provenance field on returned evidence
- no automatic promotion into domain knowledge or user memory
- one place to flip or replace the provider later

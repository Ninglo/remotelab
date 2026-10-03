# Memory Activation Architecture

Verified against the production call paths on 2026-10-03. The shared human/Agent
explanation is [Memory and organizational collaboration](../../docs/memory-architecture/README.md),
with [interactive diagrams](../../docs/memory-architecture/index.html).
Its organization-governance proposal is not an enabled runtime feature.

## Storage and activation are separate

A file's presence does not prove its contents entered the current Harness context.
Keep substantial memory on disk and activate only relevant material:

- Fresh provider threads receive memory paths and a capability directory from
  chat/system-prompt.mjs, which checks existence rather than loading memory bodies.
- Resumed threads reuse native context; startup pointers are not reinjected on
  every message. Updating files does not remove previously retained native context.
- Fresh threads with usable prior Session history can receive bounded continuation
  from normalized history or existing continuation records. Hidden provider state
  cannot be fully reconstructed.
- Source/runtime instructions, Session instructions, source snapshots, explicit
  agreements and local-bridge state are projected for the applicable turn.
- workSummary is queryable Session metadata. The normal turn hook deliberately
  does not replay classifier summaries as fresh execution evidence. Execution
  router and related-Session import helpers have no production caller in this
  audited baseline; helper existence does not establish an active input path.

Harness-native instructions, repository AGENTS.md, provider memory and Skills
have their own activation. manager_context records RemoteLab-owned delivered
slots, not every source the Harness sees. See [connector Context](../../docs/connector-turn-context.md).

## Available regions

| Region | Purpose | Activation |
| --- | --- | --- |
| bootstrap.md | Small machine/instance navigation | Fresh-provider pointer; body when useful |
| user projects.md, skills.md | Domain and method routing | Task-relevant retrieval |
| preferences.md, reference/ | Local preferences, environment and domain background | Matching scope; current-source checks |
| tasks/ and project documents | Work, decisions and recovery evidence | Relevant task only |
| repo memory/system.md | Stable cross-deployment platform lessons | Relevant platform question or curation |
| candidate queues | Unverified extraction candidates | Explicit governance and curation |
| Session history and resume IDs | Work continuity | Native resume or bounded reconstruction |
| instance project ledger and daily reports | Cross-source understanding and dated views | Configured project review or relevant task |
| archives and original sources | History and attribution | Traceback when needed |

The local user tier is machine/instance-scoped by default. It is not one namespace
per authenticated Person. personViews organizes shared Sessions for individuals;
it does not establish preference ownership or Session access control.
Person.preferences already stores some product settings, including input mode
and voice shortcuts. Normalized defaults do not establish explicit user agreement;
collaboration preferences still need attributed sources and applicability.

## Actual automatic writeback

Normal nontrivial turns can trigger a background memory review independently of
Session classification. Internal operations and group-feed Sessions are skipped.
The reviewer gets bounded user/assistant text, not the complete execution evidence.
It appends short entries with exact-line deduplication; provenance, semantic
supersession and acceptance require further governance.

memory-writeback-targets.mjs builds the actual catalogue: defaults include up to
24 discovered task Markdown files, stable local targets and user/system fallbacks.
writeback-targets.json disables named defaults and can replace fallback paths.
Disabling old task IDs does not disable newly discovered tasks. Both fallback
IDs remain enabled in the default catalogue. The default user path is
model-context/auto-user-memory.md; configuration may redirect it to reference/inbox.md.
The system candidate queue is memory/auto-system-memory.md before curation.

A prose rule saying "inbox only" does not establish the effective boundary. Inspect
the catalogue in the target instance environment. Candidate eligibility does not
establish factual acceptance.

## Governance direction (guide v2; not enabled)

Keep the pointer-first skeleton: project index -> project entry -> one project
memory plus topic/source pointers. A discussion chat, work chat and related
personal Sessions are inputs to one logical project, not separate consensus
ledgers. Topic agreements stay local; promote a project-wide agreement only with
clear scope and the relevant role's recognition. Source, time, execution state,
verification, version and recognition are attributes of an entry, not extra
document hierarchies. Reports and organization/Person views are derived from the
same project entries; corrections return to the original entry/version.

Initially retain the instance-local `project-knowledge/projects.md` ledger and
its project sections. The proposed config-directory `project-registry.json`
holds stable project IDs, source bindings, Session associations and roles; the
existing memory index and connector configuration become projections of it.
This registry is a design choice, not an existing production file or new
interactive product object. Per-Person sidebar groups are not authoritative
project associations. An ambiguous association remains pending; mixed Sessions
associate individual entries with the appropriate projects.

Personal collaboration preferences and company facts are parallel, task-relevant
background, not another level above project consensus. Proposed
`reference/people/<personId>.md` and `reference/company.md` locations are not
created or enabled by this documentation change. Existing Person product
settings retain their current purpose. AGENTS.md holds applicable stable
operation rules and pointers; Skills/WORKFLOW hold reusable methods. Project
status, personal tastes and office locations remain in their own maintenance
locations. Native Harness loading rules still determine instruction activation.

Start with all registered projects in an isolated collection/test-report area,
consuming existing source outputs rather than adding a second group consumer.
Runtime-enforced write isolation, version-aware correction, role recognition and
coverage accounting must be implemented and tested before integration. Formal
writes, individual delivery, Skills promotion and business actions activate
separately. This task only updates the guide and its static publication.

Keep ordinary task interpretation and planning with the Harness. Do not make an
all-project prompt bundle or second semantic gate mandatory on every turn. See
[the thin control-plane boundary](thin-control-plane-architecture.md).

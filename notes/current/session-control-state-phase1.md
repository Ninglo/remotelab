# Session Control State Phase 1

## Why this note exists

`notes/current/model-sovereign-control-architecture.md` defines the target ownership model.

This note records the projection baseline and the later thin-control-plane migration that made the current work summary provider-neutral across Harnesses.

## Current carrier → target object mapping

| Concern | Current carrier(s) | Current file(s) | Phase 1 target object |
|---|---|---|---|
| Active agreements | `session.activeAgreements` in session meta | `chat/session-meta-store.mjs`, `chat/session-manager.mjs`, `chat/session-agreements.mjs` | `managerState.activeAgreements` |
| Provider-neutral current work summary | `session.workSummary` in session meta | `chat/session-meta-store.mjs`, `chat/session-manager.mjs`, `chat/session-work-summary.mjs` | `workState.summary` |
| Workflow classification / review posture | `workflowState`, `workflowPriority`, `entryMode`, `lastReviewedAt` in session meta | `chat/session-meta-store.mjs`, `chat/session-manager.mjs`, `chat/session-entry-mode.mjs`, `chat/session-workflow-state.mjs` | `workState.workflow` |
| Continuation head after compaction | `context.json` via `getContextHead` / `setContextHead` | `chat/history.mjs`, `chat/session-manager.mjs` | `workState.continuation.head` |
| Prepared continuation for fork/resume | `fork-context.json` via `getForkContext` / `setForkContext` and `getOrPrepareForkContext(...)` | `chat/history.mjs`, `chat/session-manager.mjs` | `workState.continuation.prepared` |
| Prompt-time memory activation | `scopeRouter` + `relatedSessions` from execution-memory prompt selection | `chat/session-label-context.mjs`, `chat/session-manager.mjs` | `managerState.memoryActivation.scopeRouter` / `managerState.memoryActivation.relatedSessions` |
| Turn search policy | ad hoc string composition inside prompt assembly | `chat/session-manager.mjs` | `managerState.memoryActivation.searchPolicy` |

## Phase 1 landing

The first code landing adds `chat/session-control-state.mjs` as a backend projection layer.

It does three things:

1. normalize the existing manager-facing carriers into `managerState`
2. normalize the existing work/continuation carriers into `workState`
3. give prompt assembly and session enrichment one shared object vocabulary

Current implementation status:

- `chat/session-manager.mjs` now builds manager-turn prompt blocks from `managerState` / `workState` instead of reaching directly into scattered raw fields
- continuation prompt assembly now reads from `workState.continuation` instead of stitching `contextHead`, `forkContext`, and tool index separately
- enriched session objects now expose `managerState` and `workState` as derived fields while keeping the legacy flat fields for compatibility
- `chat/session-meta-store.mjs` strips derived `managerState` / `workState` fields before persistence so the projection layer does not become a second storage source

## What this solves now

- there is now one explicit backend vocabulary for manager/work-state projection
- prompt construction has a clearer choke point for agreements, provider-neutral work summary, continuation, and memory activation inputs
- session reads no longer have to infer the conceptual object model from multiple unrelated field names
- derived state is explicitly kept out of durable session meta

## What still remains mixed

- storage is still physically layered: `activeAgreements`, `workSummary`, workflow fields, `context.json`, and `fork-context.json` are projected together but not stored as one monolithic object
- memory activation is still prompt-time selection, not yet a first-class durable activation record
- the former global manager turn policy has been removed; explicit `activeAgreements` remain session-scoped state
- run state and delivery state are still modeled elsewhere and are not yet folded into the same control-state graph
- prompt rendering still lives in `chat/session-manager.mjs`; Phase 2 should move more of that rendering into an explicit projection boundary

## Recommended next cut after this landing

The next safe cut is to make `workState` itself the canonical home for “what is happening now” across:

- provider-neutral work summary
- accepted decisions
- blockers / needs from user
- next step
- continuation outputs from compaction and fork preparation

Only after that should the system promote more transcript-derived material automatically.

# Evidence-backed Todo judgments and personal views

Use the existing inspection workflow to collect authorized sources once, have the Harness interpret each request and its latest outcome, then validate its evidence and render personal views. Source discovery, action extraction, responsibility, task registration and display are separate decisions. A broad source does not automatically authorize a task for every participant. Expanded sources cannot create a task for an unlisted person just because a listed requester is related.

The implementation is in `scripts/project-inspection-plan.mjs`, `project-todo-collect.mjs` and `project-todo-judge.mjs`. Task writes, locking, deduplication, readback, source retries and notification permissions remain with the original workflow. These scripts never create tasks, send messages or advance cursors.

## Source plan and collection

Without `registry.personTodoExpansion`, the planner preserves existing scope. An authorized instance may configure:

```json
{
  "personTodoExpansion": {
    "enabled": true,
    "personIds": ["person-example"],
    "stateDirectory": "/instance/todo/state/people-sources",
    "initialStart": "2026-10-12T00:00:00+08:00"
  }
}
```

The morning plan includes `todoSources` for active focused and overview groups on the registry's route. Paused/excluded groups stay excluded. The original target state files are reused; additional sources use the same state format in the configured directory. Initial coverage starts at the explicit baseline; subsequent reads overlap the success cursor by 48 hours and revisit known threads/retries. Existing backlog is still checked against its original task evidence. The afternoon phase does not add another Todo run.

`personIds` on an additional source restricts new registration to work related to those verified people; it never reassigns another person's work. Original project targets keep their existing registration authority. `sources` remains the focused project-analysis list; overview content does not acquire general project-analysis authority through Todo processing.

After the focused collector has saved its indexes, run:

```sh
node scripts/project-todo-collect.mjs --plan round/inspection-plan.json --indexes round --profile configured-profile
node scripts/project-overview-collect.mjs --plan round/inspection-plan.json --indexes round --output round/overview --profile configured-profile
```

The first command reuses focused indexes and fully paginates additional roots and discovered/known threads. The second reuses those full reads for overview coverage instead of fetching the same group again. Preserve collection failures and attachment gaps; a saved index alone does not prove complete focused collection.

### Starting with new activity instead of historical backlog

After explicit authorization to stop backlog review, set `personTodoExpansion.newActivitySince` to the cutover timestamp and set `initialStart` to the same boundary. This changes the configured people's Todo scope, not their existing Task records or the project review scope. Do not synthesize a successful scan cursor. Additional sources expose `todoWindowStart` so older context collected for project review does not require personal backlog judgments.

The plan carries `personTodoNewActivitySince`. The assessor excludes historical actions from these people's views and new registration unless the action cites a human message at or after that timestamp and before the scheduled endpoint. A fresh bot summary alone cannot reactivate an old action. `skippedHistorical` identifies excluded actions; the writer must also skip their maintenance, closure and reminders. Other people's original project maintenance authority is unchanged. A new human message must actually request or continue that action; unrelated messages must not be included just to pass the boundary. Existing Task records remain available for deduplication.

## Semantic decisions

First assess existing tasks; then identify independent new requests against that state. The Harness reads actual messages and makes semantic decisions. Do not generate decisions using keyword templates, a fixed list of selected IDs, a desired task count, or summaries that have lost the original speakers.

For quoted, forwarded or substantially repeated passages, compare the original author and surrounding discussion. Separate who sent the message, who originally spoke, who requested the work, who accepted responsibility and who must act next. Mentioning a project or forwarding a plan is not accepting its work. The validator detects long passages copied across speakers and requires an explicit attribution review; this is a retrieval hint, not an automatic authorship decision. When attribution is still unknown, keep a concrete candidate with `unresolved` attribution rather than silently dropping it or assigning it to the requester.

Every relevant message receives an action decision or a specific `no_action` explanation. Several messages can support one action; one message can contain several independent actions. Preserve accepted directions and conditional arrangements, not only sentences containing an explicit promise. An Agent acknowledgement is not completion; a suggested future improvement is not automatically an accepted obligation. Current delegation and waiting status remain visible without becoming new personal actions.

Write `judgments.json` with `schemaVersion: 2` and `actions`. Each action has:

- `id`, `sourceMessageIds`, `disposition`, `reason`. Dispositions retain the original coverage vocabulary: `create`, `clarify`, `update`, `covered`, `in_progress`, `resolved`, `no_action`, `needs_evidence`.
- Except for `no_action`: `title`, `status` (`open`, `complete`, `paused`, `cancelled`, `unknown`), `statusEvidence` citing the latest result or condition, and `relatedPersonIds` based on actual request/responsibility evidence.
- `attribution`: `mode` (`direct`, `quoted`, `forwarded`, `unresolved`), `speakerId` matching the cited original message sender, and `evidence`. An unresolved attribution needs `reason`. A direct attribution with cross-speaker copy candidates needs `reviewedMessageIds` and a concrete `reason` resolving them.
- `owner`: `actor` and `evidence`; `next`: `actor`, `text`, `availability` (`ready`, `blocked`, `conditional`, `unknown`) and `evidence`. Non-ready actions include a concrete `condition`. Actors have `kind` (`person`, `agent`, `unknown`); person actors carry their verified Person `id`.
- Evidence is `{ "messageId": "source-id", "quote": "exact excerpt" }`. Cite actual original wording; do not rewrite evidence to match the desired decision. Supplemental document/meeting evidence can be supplied as records with `message_id`, `content`, and original `sender`; preserve their actual source identity.
- Optional `scheduledDate` requires `timingEvidence`. Do not invent a deadline. A personal carryover does not need a date to remain visible.

For example, a delegated repair has the Agent as both owner and next actor; the requester is in `relatedPersonIds`. If the next step is an explicitly requested human review, name that person and cite that request. If review only becomes useful after a device arrives or a trial yields a usable result, record the condition and verify whether it has occurred.

## Validation and output

```sh
node scripts/project-todo-judge.mjs --plan round/inspection-plan.json --indexes round --judgments round/judgments.json --evidence round/supplemental-evidence.json --output round/todo-assessment.json
```

`--evidence` is optional. The command requires the same-round `todo-collection.json` receipt, rejects missing/failed/stale source collection, reuses `check-todo-coverage.mjs` (including nested thread replies), compares source message IDs to decisions, checks that quotes exist and cited speakers match, and projects valid semantic decisions into:

- `personal`: an available next action for the person, including undated carryover;
- `delegated`: an available next action belonging to an Agent or another person;
- `waiting`: a blocked, conditional or not-yet-verified next step;
- `needsReview`: attribution/state/next actor remains unresolved;
- `archived`: completed, paused or cancelled items, kept out of current action lists.

`registration` reports whether a proposed new task falls in the original or configured person scope. It does not authorize execution or replace original task registration checks. Never treat a view row as a task-write receipt. Invalid rows remain in `invalid`; missing message judgments remain in `coverage`. Exit 2 means incomplete validation. Fix the affected evidence or record the unresolved condition without advancing that source's success cursor; independent valid work can continue under its original authority.

The output verifies references, consistency and coverage, not semantic truth or recall by itself. Replays must use frozen original messages and task state, inspect false assignments and omissions, and preserve the corrected reasoning. Do not assert a fixed number of expected Todos as the acceptance criterion. Keep full source and per-action evidence in private run artifacts, not public repository fixtures.

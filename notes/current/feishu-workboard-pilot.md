# Person-scoped workboard baseline

Status: accepted contract, 2026-10-01. Activation remains an explicit Person
opt-in. The worker and state file retain their `pilot` names for compatibility;
those names do not imply automatic expiry or permission to enable more people.

## Operator handoff

> Keep the opted-in workboard on its accepted baseline: one task keeps one
> card, every verified deliverable updates it immediately, and the final result
> is delivered separately. Check the current Person/Bot scope, durable worker
> settings and card receipts. Run `npm run test:workboard` in an isolated test
> environment before changing this path. Preserve incomplete outcomes and the
> original task identity when work resumes. Do not replay historical messages
> or broaden opt-in scope as part of maintenance.

Supply the instance, selected Person, Bot route and existing opt-in/state paths
in one handoff. The AI reads the actual IDs and service settings locally; shared
source must not contain private IDs or credentials.

## Activation and scope

This opt-in is for one Person's own RemoteLab chat Sessions, one exact Feishu
Bot private chat, and that Person's own messages in groups reached by the same
Bot. Configure `~/.config/remotelab/workboard-opt-ins.json` with a `people`
array. Each entry has `personId`, `identityIds`, optional
`feishuPrivateChats` entries containing `sourceRouteId` and `chatId`, and
optional `feishuGroupSenders` entries containing `sourceRouteId` and the
Person's Feishu `openId`. The instance-local file holds real IDs; shared
source does not. Private chat turns check the original Session initiator.
Group turns check the resolved Person, connector-authenticated source message,
exact sender open ID, Bot route, group chat and delivery target on every turn.
The shared group timeline itself is excluded; substantial ambient work runs in
its separate thread Session. Other members' messages cannot start a checklist
even in a Session that previously held this Person's workboard. Removing the
Person entry stops future checklist decisions; old checklists remain in history.

Jev makes a compact yes/no decision only for a new delegated, multi-stage task.
Uncertain yes, timeout, or unavailable Jev adds no checklist. The decision
request is capped at 4,000 characters and does not generate checklist text.
When a user supplied a `目标：` line and 2–5 `[ ] 标题 — 完成条件` lines, code reuses
them directly. Otherwise the same Harness Run derives the short checklist
before investigation; there is no second planner or model call. Jev never gates
updates to an existing task. A local Session continuation can update an existing
opted-in Feishu task by its explicit ID; it cannot create a new Feishu task or
grant another Feishu sender access to that task.

## Accepted behavior

Session history is the source of truth for both the web transcript and Feishu.
The Harness owns planning and semantic acceptance. The snapshot API validates
references, and the worker checks publication state deterministically. Neither
decides whether the work satisfies the user's goal.

- Publish the initial 2–5 deliverables immediately, with a goal and checkable
  acceptance conditions. Internal execution steps cannot replace them.
- Keep `taskId`, item IDs and conditions stable. Continuing the same task across
  Runs reuses the original card; a new task gets a new ID, even within one Run.
- After each deliverable passes acceptance, immediately submit the full next
  snapshot with `remotelab assistant-message --workboard-file <json-path>`.
  `done` requires actual verification event references. Withdrawing completion
  or changing scope requires a reason; changed completed criteria need fresh
  evidence. Plain checklist text is only the initial unchecked-list interface.
- Ordinary progress text, a final explanation and native Run termination do
  not prove task completion. Explicit outcomes are `running`, `partial`,
  `blocked`, `failed`, `cancelled` or `completed`. Unfinished outcomes carry a
  reason and still receive a normal final explanation. Runtime failure or
  cancellation supplies a fallback while preserving verified items; an ended
  Run without an explicit task outcome is shown as unconfirmed.
- Record work and delivery separately. Only all required deliverables verified
  means work completed; only confirmed receipts for all result parts mean
  delivered. A delivered blocker explanation is still a blocked task. A new
  revision cannot borrow an old revision's delivery receipts.
- Keep one card per task and send the final answer separately. Native Codex
  `final_answer` messages with ready assets may enter the outbox while the Run
  remains active. Provider identities are scoped to the Run and task, so
  steering, restart and terminal settlement cannot resend the same answer.
  Legacy adapters without explicit message phases still settle at Run end;
  unready assets defer publication. Preserve automatic-delivery preferences on
  local continuations; separately authorized outbox results use explicit task
  and revision tags.

The canonical snapshot and receipt contract is in
[External Message Protocol](../../docs/external-message-protocol.md#8-reading-normalized-events).

The Feishu worker mirrors the exact private Session and the opted-in Person's
group work Sessions to one v2 message card per task, then patches that card in
place. Group thread cards reply to the originating message in its thread;
main timeline cards remain in that group. The worker correlates group checklist
events with the same Run's verified inbound sender and ignores other members'
Runs. It uses the same
`目标` and per-item completion lines, adds a deterministic completed count,
and changes the header on completion. Normal source delivery sends the final
result as a separate message. The worker first reads Session state, then
listens for WebSocket invalidations. It fences an uncertain first send and
does not backfill a checklist after its final result. IM readback confirms
message identity, destination, card type, and update state; IM's card content
field is only a compatibility preview, so visual acceptance still needs a
real Feishu client check.

## Durable operation

The worker's private state stores `sessionId`, `chatId`, `senderOpenId`,
`sourceRouteId`, `botConfigPath`, `startedAfterSeq`, and `cards: []` with mode
`0600`. `groupEnabled: true` and `personId` enable the same Bot's group mirror;
`groupSessions` keeps per-Session card receipts. It reads matching Sessions on
startup and follows WebSocket invalidations. `expiresAt` is optional for a
bounded trial. A durable Person pilot keeps the dedicated service running
without `ExecStopPost --disable` or a `RuntimeMaxSec` cutoff. Stop that service
and remove the Person opt-in to stop new work; clear the exact private
Session's `workboardPilot` flag when retiring its mirror. Enabling another
Person or Bot route requires a separate opt-in and readback. Do not send an
unsolicited test card to a group; verify actual delivery when the opted-in
Person sends a real complex task there.

Protocol v2 persists each task's original card ID and acknowledged update
sequence. It replays every unseen checkpoint after restart; it does not collapse
several completed items into one final patch. A one-time migration floor fences
historical sends. Persist a known card ID before readback, acknowledge only after
verification, and safely retry patches. An uncertain creation stays fenced for
inspection instead of sending another card. Card failures do not block the
separate result channel, and result failures do not invalidate verified work.

For a durable Linux worker, verify service enablement, user lingering when using
a user service, restart-on-failure, `RuntimeMaxSec=infinity`, no stop hook that
disables opt-in, and no `expiresAt` in private state. Preserve these settings
when changing the source checkout. Other instances and opted-out people remain
outside this baseline's activation scope.

## Regression and evidence boundary

`npm run test:workboard` is the fixed isolated acceptance entry point and runs
inside the normal `npm test` / required CI check. Existing scenarios cover:

- activation boundaries and task context surviving a negative creation gate;
- evidence, revision conflicts, scope changes and withdrawing completion;
- commentary, blocked/partial outcomes, failure/cancellation, cross-Run resume
  and new-task separation;
- shared web/card state without internal-plan overwrites;
- HTTP and CLI snapshots, concurrent updates and exact retries;
- card patch failure, uncertain creation, restart replay and migration fences;
- native final delivery before Run end, ready assets, restart/terminal dedupe,
  task-bound multi-part receipts and reused provider IDs.

The 2026-09-30 live acceptance confirmed an original Feishu topic card updating
0/3 → 1/3 → 2/3 → 3/3, cross-Run continuation, restart recovery and a separate
final message with a delivery receipt. The implementation baseline is main
`75e64357`; instance-specific rollout commits and private receipt IDs belong in
the local acceptance record. Failure and native streaming/file scenarios also
have isolated integration coverage; this is not a claim that every provider or
Feishu client variant has been tested live. Future changes must retain the
contract, pass CI and verify a real opted-in task's original card and result
receipts before claiming live delivery.

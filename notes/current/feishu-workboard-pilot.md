# Workboard activation and durable delivery

Status: accepted contract, 2026-10-03. Activation is instance-local: explicit
Person opt-ins remain supported, and an operator can enable all registered and
future members of one instance. The `pilot` file names remain for compatibility;
activation on one instance never automatically activates another.

## Operator handoff

> Verify and enable task cards for all members of this one RemoteLab instance.
> Keep bounded small deliveries direct, preserve strong Harness judgment and
> every verified checkpoint, retain original card IDs, and keep final replies
> separate. Inspect current policy, Bot routes, workers and source commit; run
> `npm run test:workboard` in isolation. Use the managed rollout script to retire
> the old writer and migrate receipts before enabling the default. Verify the
> original live card, restart recovery and result delivery after deployment.
> Never backfill historical cards or send unsolicited test cards to groups.

Supply instance config directory, base URL, verified main source checkout,
active Bot config paths, any old pilot state/service, and any source-freeze
marker in one handoff. The agent resolves actual local IDs and credentials;
shared source contains none. The rollout script is
`scripts/configure-instance-workboards.mjs`; `--help` lists inputs, the default
prints a read-only plan, and `--apply` performs the already-authorized rollout.
It validates the selected Bots belong to the supplied instance, stops old
writers before copying receipts, installs enabled user services and saves
private backups. The caller verifies lingering, worker readiness and delivery;
`is-active` alone is not delivery acceptance. Preserve an existing migration
freeze marker with `--source-freeze-path` when applicable.

## Activation and scope

`workboard-opt-ins.json` in the instance config directory remains the activation
source. `defaultEnabled: true` resolves registered People and their current
identities on every future admission, including newly discovered members.
System work and the shared group timeline are excluded. Web turns use the
actual authenticated web identity, including Web continuation of a Session
originally created through Feishu or another connector. Web activation never
provides a Feishu send admission. Feishu turns require the authenticated
connector, resolved Person/identity, matching Bot realm and sender open ID,
source chat/type/tenant/message, and actual delivery destination. New private
chats and group task threads do not require manually adding every chat ID.
No user intent classification is added by this activation check.

Keep `excludedPersonIds` or a `people` entry with `enabled: false` for explicit
opt-outs. With the default off, the original `people` opt-in contract is
unchanged: `personId`, `identityIds`, exact `feishuPrivateChats` (`sourceRouteId`,
`chatId`) and `feishuGroupSenders` (`sourceRouteId`, `openId`). Group turns
follow their actual sender, not the Session's creator or last owner. Removing
an opt-in stops future card decisions; existing cards and evidence remain.
To return to the pilot scope, set `defaultEnabled: false` and retain the
original entries. Keep the route workers running for existing task updates;
do not restore an old receipt file over newer acknowledgements.

The executing Harness decides whether actual work needs a card. A single
bounded delivery defaults to direct execution and final reply. Routine
inspection, editing, testing and reporting are steps, not separate deliverables.
Actual scope, uncertainty or duration must make independent intermediate
outcomes useful before a card is created. A short-looking request can grow in
scope and then receive a card. Supplied 2–5-item goal/acceptance lists can be
reused directly. There is no separate classifier, hard Jev gate or second
planner. Simple-task suppression is a semantic Harness rule, not a guarantee
from keyword matching; evaluate real behaviour alongside token use.

## Accepted behavior

Session history is the source of truth for both the web transcript and Feishu.
The Harness owns planning and semantic acceptance. The snapshot API validates
references, and the worker checks publication state deterministically. Neither
decides whether the work satisfies the user's goal.

- Publish the initial 2–5 deliverables immediately, with a goal and checkable
  acceptance conditions. Internal execution steps cannot replace them.
- Feishu sends one task-specific model opening, with the new Session entry in
  that message. It no longer sends a separate model/effort/Harness creation
  notice. If no opening exists, the final reply carries the entry. Openings
  are labelled `开始处理`, native questions `待你回复`, and stopped-Run results
  `最终答复`; these labels do not assert task acceptance or completion.
- Keep `taskId`, item IDs and conditions stable. Continuing the same task across
  Runs reuses the original card; a new task gets a new ID, even within one Run.
  A text-created initial list already has an ID; JSON updates must reuse it.
  A second ID for identical deliverables in the same unfinished Run is rejected
  with the existing ID and next revision. Historical default-ID duplicates with
  unchanged goals and conditions are projected onto their first card position;
  different tasks and completed work remain separate. Raw history is preserved.
- After a task card exists, explicit `<progress>` messages update its
  **目前进展** area. The web card shows the latest update and expandable earlier
  updates; the Feishu worker patches the original message with the latest text.
  Each useful progress update also enters the Feishu message outbox, returning
  to the original conversation or topic as a new message. This global default
  lets concurrent tasks notify readers and retains the intermediate message
  history; per-Session strategy controls are deferred. Openings, native user
  questions and final results remain separate. Without a card, explicit progress
  uses one compact progress panel per Run, without acceptance items. Later
  progress patches that same position/message; Web retains expandable progress
  history. If the Harness subsequently creates a real task, its acceptance list
  upgrades the original progress position/message. The opening, questions and
  final answer remain separate. New Feishu progress starts at a durable route
  upgrade fence; old delivered chat messages are never replayed or recalled.
  When upgrading an unfinished Request from card-only publication, preserve
  its record and fence already-stored progress with `progressMessageAfterSeq`
  while the control-plane writer is stopped. This boundary is not a delivery
  receipt; new progress retains the normal durable message identities.
  Progress never changes deliverable
  acceptance or proves completion, and follows the card's sender/Run scope.
  Explicit completion, partial, blocked, failed or cancelled outcomes replace
  stale running text in the current progress area. Earlier progress remains in
  history; no inferred completion is taken from that text.
- A single bounded delivery (a project/title rename, one field change, small
  edit, direct export or focused answer) defaults to direct completion without a
  task card. Inspecting, editing, testing and reporting do not turn that one
  delivery into independent checklist items. The Harness decides from actual
  scope, uncertainty, duration and useful intermediate outcomes; no extra
  classifier or keyword gate makes this decision.
- After each deliverable passes acceptance, immediately submit its state change
  with `remotelab workboard update --task <id> --item <id> --status done
  --evidence <seq> --json`. The server serializes mutations, keeps criteria and
  IDs, assigns revisions, validates references and returns a compact receipt.
  An identical retry adds no revision. `--revision` is an optional optimistic
  precondition. Full snapshots via `assistant-message --workboard-file` remain
  supported for scope changes.
- `remotelab workboard show --task <id> --json` returns the selected full
  snapshot and a bounded recent evidence index; it avoids returning the whole
  Session history. Completed cards enter the turn context as a short task index,
  while unfinished cards retain their criteria. Original history and evidence
  remain available. The Harness still judges semantic acceptance.
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
  `final_answer` messages with ready assets wait until execution stops before
  Feishu publishes the result. Provider identities are scoped to the Run and task, so
  steering, restart and terminal settlement cannot resend the same answer.
  Legacy adapters without explicit message phases still settle at Run end;
  unready assets defer publication. Preserve automatic-delivery preferences on
  local continuations; separately authorized outbox results use explicit task
  and revision tags.
  Repeated completion events for the same provider item and Run replace its
  original reply position. Terminal recovery retains one answer and one file
  delivery, without appending attachment fallback names to an existing answer.

The canonical snapshot and receipt contract is in
[External Message Protocol](../../docs/external-message-protocol.md#8-reading-normalized-events).

One worker per Bot route mirrors all enabled private/group task Sessions of
that instance, with the same web projection and one original card per task.
Each new Feishu inbound turn durably records its admission Person/identity and
sender/route. The publisher validates it against the Session destination rather
than a mutable last-owner flag. A steered Run keeps the original task's reply
anchor. Local continuations can update an explicitly identified existing task;
they do not create a new unsolicited Feishu card.

## Durable operation

Route state uses `scope: "instance"`, `sourceRouteId`, `botConfigPath`, and a
`sessions` map of destination and card receipts. A migrated state retains known
legacy cards, pending uncertain creates, acknowledged sequences and migration
floors. Unknown historical cards lack the new admission receipt and cannot be
created. A known legacy sender is accepted only to maintain known cards.
The worker reads state before listening to WebSocket invalidations, reconnects
after controller restart, stays alive when the controller starts later at boot,
and serializes publication/state writes. An uncertain send in one Session
cannot stop the route's other cards. Cards in a
group thread reply to the originating message; private cards remain in their
original private chat. IM readback confirms destination, message ID, card type
and update state; its content is a compatibility preview, so visual acceptance
still requires a real Feishu client.

Old Person-scoped state remains supported: `sessionId`, `chatId`,
`senderOpenId`, `sourceRouteId`, `botConfigPath`, `startedAfterSeq`, optional
`groupEnabled`/`personId`, and card receipts. A replacement worker must preserve
these receipts before retiring the old writer. Do not run both route and
Person workers against the same conversations.

Protocol v2 persists each task's original card ID and acknowledged update
sequence. It replays every unseen checkpoint after restart; it does not collapse
several completed items into one final patch. A one-time migration floor fences
historical sends. Persist a known card ID before readback, acknowledge only after
verification, and safely retry patches. An uncertain creation stays fenced for
inspection instead of sending another card. Card failures do not block the
separate result channel, and result failures do not invalidate verified work.
An acknowledged content hash lets a renderer upgrade refresh an existing card
once even when its event sequence has not changed. Older snapshots remain
fenced; this patches the known message and never creates a historical test card.

For a durable Linux worker, verify service enablement, user lingering when using
a user service, restart-on-failure, `RuntimeMaxSec=infinity`, no stop hook that
disables opt-in, and no `expiresAt` in private state. Preserve these settings
when changing the source checkout. Other instances and explicitly opted-out people remain outside the selected
instance's activation scope.

## Regression and evidence boundary

`npm run test:workboard` is the fixed isolated acceptance entry point and runs
inside the normal `npm test` / required CI check. Existing scenarios cover:

- explicit and instance-default activation, future-member discovery, opt-outs,
  sender/destination validation and task context despite old negative Jev receipts;
- shared-topic member changes, immutable reply anchors, migration without
  historical sends, and managed service settings;
- evidence, revision conflicts, scope changes and withdrawing completion;
- commentary, blocked/partial outcomes, failure/cancellation, cross-Run resume
  and new-task separation;
- shared web/card state without internal-plan overwrites;
- in-card progress with separate openings/questions/results, duplicate
  text-to-JSON task IDs, historical projection, and stale progress responses;
- HTTP and CLI snapshots, concurrent updates and exact retries;
- card patch failure, uncertain creation, restart replay and migration fences;
- a real worker process with delayed controller startup and WebSocket reconnect,
  retaining its PID/state without contacting the Feishu provider;
- native final delivery after Run end, ready assets, restart/terminal dedupe,
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

## Work process in task cards

An instance can restore the 2026-10-07 group-message contract (main
`a103380f`) with `REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE=2026-10-07` on its
core, Feishu connectors and card workers. Group turns publish their useful
opening and explicit progress messages again; the original card offers
session-scoped messages/card/default controls. Unlisted group progress can
create a lightweight card and a later checklist upgrades the same message.
Questions and terminal results retain their separate delivery identities.
Private chats, Web display and instances without this setting keep the
current contract below. Existing Run/card disclosure records are retained.
Before enabling it, fence active group Requests at the current history head
while the core writer is stopped. Workers persist `groupProgressRestoredAt`
before processing history, preserving original card IDs and acknowledgements
without creating cards for old suppressed progress. Keep all coupled services
on the same verified commit. Remove the setting to return to the current
contract; do not restore old receipt files over newer acknowledgements.

Only a published acceptance checklist creates a Feishu card. Unlisted work keeps its ordinary final reply and its Web/history process, without a standalone progress card. Existing lightweight card receipts remain preserved; if their work later receives a real checklist, the known message upgrades in place. Later routine Feishu turns omit the opening; a new conversation retains its first reply with the accepted model, effort and Session link. Questions, exceptional notices and final results retain separate delivery.

The latest progress appears outside the detailed work process as a bounded preview. Details start collapsed. A callback button labeled 点击显示进展 or 点击折叠进展 shows or hides recent excerpts and the full-history link. Native fold controls reset when Feishu patches the whole card and do not report clicks, so they cannot satisfy manual priority here. The callback records the choice for that original card's durable anchor in Session metadata; updates, completion and cross-Run resumption preserve it. A new card starts collapsed. All readers see the last accepted click on the shared card. No personal habit is saved and no extra model call is made.

Callbacks validate the actual card receipt, destination, route, tenant and operator policy before the core accepts them. Retried callbacks are idempotent and cannot undo a newer click; each new show/hide intent wins in acceptance order. Display revision is independent from task acceptance and legacy per-Run command metadata. Ordinary progress invalidates and patches the original message once, without sending a new progress message. Source history, task acceptance, route/receipt checks and restart durability remain unchanged.

`tests/test-feishu-progress-disclosure.mjs` covers the outer preview, hidden and shown details, original message updates, last click priority, old retry deduplication, completion/resumption, independent cards, restart persistence, actor/tenant/message/anchor checks and summary projection. The legacy command tests retain their compatibility contracts. Provider delivery and actual Feishu client interaction remain separate from isolated regression results.

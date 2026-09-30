# Person-scoped workboard pilot

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

Jev makes a compact yes/no decision only for a delegated, multi-stage task.
Uncertain yes, timeout, or unavailable Jev adds no checklist. The decision
request is capped at 4,000 characters and does not generate checklist text.
When a user supplied a `目标：` line and 2–5 `[ ] 标题 — 完成条件` lines, code reuses
them directly. Otherwise the same Harness Run derives the short checklist;
there is no second model call. The Harness sends genuine completion updates
through `remotelab assistant-message --source workboard_checklist`. The
RemoteLab transcript coalesces those updates into one visible checklist and
keeps the final result separate. The Run's native state supplies its status.

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

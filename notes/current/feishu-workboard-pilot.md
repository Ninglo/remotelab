# Feishu private-chat workboard pilot

This pilot mirrors a single opted-in RemoteLab Session's `workboard_checklist`
events to one editable Feishu Bot text message per unfinished task. The normal
source-delivery path sends the final result separately. Short requests remain
subject to the existing Jev checklist gate. Thinking stays in RemoteLab; Feishu
text messages have no expandable Thinking view.

Activation requires one private state JSON file (mode `0600`) with `sessionId`,
`chatId`, `senderOpenId`, `sourceRouteId`, `botConfigPath`, `startedAfterSeq`,
`expiresAt`, and `cards: []`. Set `startedAfterSeq` to the current last raw event
sequence before enabling `workboardPilot` on that Session. This prevents old
checklists from being sent during activation. The worker validates the Session's
current Feishu conversation and each new user's sender Open ID before sending.

Run `node scripts/feishu-workboard-pilot.mjs <state-file>` under the same
instance account as the Feishu Connector. It reads state immediately, then
listens for that Session's WebSocket invalidations. It saves the outbound
message ID before readback, edits that ID on later revisions, and fences an
uncertain first send rather than risking a duplicate. The state file records
the latest delivered revision. A completed task observed for the first time
after its result is not backfilled out of order.

Stop the dedicated service to end the trial. Configure its `ExecStopPost` to
run the worker with `--disable <state-file>`; this clears `workboardPilot` on
the exact bound Session after any stop, including the `expiresAt` cutoff.
The cleanup checks the private chat binding before making that change. No
group or other private Session is watched or modified.

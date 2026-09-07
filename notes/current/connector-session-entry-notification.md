# Early connector session entry

The session URL is available as soon as the first input is accepted. Waiting for
the model to finish prevents the user from following that first task's progress.

For connectors using the shared durable outbox, admission now commits a separate
`session_entry` delivery with the first accepted user request. It is immediately
claimable by the normal sender, independently of model execution. No synthetic
assistant message is added to history. A normal completed or failed reply is
appended later with a different delivery ID; the early notification and its send
receipt remain intact.

The request store serializes first-user admission and reserves a persistent lookup
address. Concurrent messages, lost HTTP responses, archival and restart cannot
turn a later input into another entry notification. Existing sessions with user
history, internal operations, visitors and browser sessions are excluded. Existing
outbox lease/receipt rules still apply, including explicit handling of ambiguous
external sends rather than claiming end-to-end exactly-once delivery.

Feishu already uses this outbox, so its sender needs no feature-specific change.
Other adapters (including the current WeChat, WhatsApp and email paths) still send
their final replies outside it; they retain the prior first-reply link until they
adopt the shared delivery contract. A request carrying an early notification no
longer adds the old final-reply footer.

Validation: the publication scenario holds a fake model until explicitly released,
sends and acknowledges the entry while the result is still null, replays admission,
then verifies the final reply has no footer. Request-store scenarios verify
concurrent admission, durable receipts, stable part IDs and archive/restart.

Rollout depends on the pending request-state migration described in
`connector-request-recovery.md`; restarting a legacy production config directly
against this mainline is not a safe rollout.

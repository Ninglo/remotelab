# Feishu rejected attachment and reconnect recovery

## Reproduction

A completed result had its text delivered, then an MP4 attachment received Feishu HTTP 400 / code 230055: upload type and message type did not match. The connector discarded the structured rejection, persisted `unknown`, and blocked two remaining attachments and a later result in that topic. A connector restart correctly retained the outbox but could not resolve the incorrectly classified uncertainty.

Isolated RED evidence before each fix:

- `test-feishu-connector.mjs`: expected `media`, received `file` for an MP4 upload.
- `test-feishu-delivery-errors.mjs`: expected `delivery_failed`, received `unknown` after the explicit API rejection.
- Added lost-acknowledgement reproduction: expected `delivery_failed`, received `unknown` after the connector restarted and its sender lease expired.

## Correction and verification

MP4/media and Opus/audio pairs now match for chat sends and threaded replies. API rejection details are preserved without storing SDK request headers. Structured rejections release the topic; transient preparation failures and rate limits retry with existing bounds; uncertain message sends remain fenced.

Failure receipts now persist separately from success receipts before control-plane acknowledgement. The test restarts the connector with the same journal after a rejected send, simulates both an uncommitted acknowledgement and a committed acknowledgement with a lost HTTP response, and verifies that the later reply proceeds with no repeated send. Outbox tests check expired leases, stale failures, replay during a newer attempt, and replay after successful delivery.

Focused tests, full isolated `npm test`, the restart gate, syntax checks, diff checks and advisory file-size lint all passed. Source changes were self-reviewed against the delivery lease and receipt replay contracts; CI and live activation follow this local gate. Local detailed RED/GREEN logs and private incident snapshots are kept in ignored `test-results/feishu-delivery-recovery/`.

The live repair must resolve only the attachment whose rejection was verified, using the existing Delivery resolution API. It must retain the original delivered text receipt and let the connector claim the remaining parts normally; it does not rerun the model. Automated tests use fake external transports and do not establish live Feishu delivery by themselves.

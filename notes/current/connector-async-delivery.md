# Connector asynchronous admission and delivery

Status: implemented and hermetically validated, 2026-09-08. Canonical integration contract: [External Message Protocol](../../docs/external-message-protocol.md).

## Decision

Use the existing Feishu durable inbox → request → outbox → receipt architecture for WeChat and inbound Agent Mailbox. Retire WhatsApp Business and the local Voice Connector rather than migrating unused surfaces. Browser/mobile voice input and Shortcuts are independent and remain supported.

The AI runtime, not the connector's wall clock, determines when execution finishes. Individual HTTP operations retain finite deadlines. An observer stopping or a sender lease expiring cannot turn a healthy request into a failed AI task.

## Responsibilities

- Admission owns upstream deduplication and durable prepared submissions. Once RemoteLab accepts a request, admission returns and the next message can be submitted, even if AI is still busy.
- The request store commits each result with its reply destinations. This responsibility is request-scoped, not conditional on the session becoming idle.
- Delivery workers claim available records independently of admission. Credentials stay in instance bindings; outbox records contain the necessary destination references.
- A sender journals evidence before acknowledging RemoteLab. Replaying acknowledgements must not repeat upstream sends. A lost sending lease or ambiguous network response remains `unknown` until evidence or operator resolution is available.
- IM attachment parts retain their own delivery progress. Email text and attachments belong to one outbound message.
- New email intake has one final-delivery owner: the request outbox, not both an outbox and a legacy completion target. Explicit automation completion targets remain compatible.

## Rollout and recovery boundaries

1. Verify source version, clean-instance regression tests, and the instance's existing Request schema. This change does not authorize overwriting or reinitializing request state. Schema-1 instances do not need the earlier offline conversion again.
2. Check for old connector processes before updating. Never start a second upstream consumer for an existing account. Retiring source scripts does not itself stop separately installed services on another machine.
3. Preserve existing inbox/handled-event/receipt journals. Do not replay every historical event simply because the transport implementation changed.
4. Old accepted requests without an outbox destination need reconciliation against their original request and send evidence. Do not resubmit an old AI request under a new id. Historical `failed_with_notice` records are not blanket authorization to resend late results.
5. On ambiguous sends, inspect the upstream conversation/mailbox and durable receipts, then explicitly resolve the delivery as `delivered`, `pending`, or `cancelled`. Do not claim exactly-once transport where the upstream offers no idempotency or lookup guarantee.
6. Validate live receive → admission → execution → delivery on a configured account before claiming full platform end-to-end acceptance. Mock tests and an HTTP health check do not establish real upstream delivery.

## Validation

`npm test` (including smoke, merge-safety, recovery and the new `test:connector-async` suite) and `npm run test:restart-gate` pass in clean instance environments. The new suite exercises real HTTP admission for all three connectors, the embedded email worker with a loopback-only mail transport, lost admission replies, changed-source retries, gateway/transport ambiguity, local receipt-write failure, missing attachments, WeChat cursor durability and token-refresh replay. No real upstream messages or emails are sent by these tests.

Native WeChat typing from the concurrent mainline change is preserved as a separate scan of durable request activity, not a per-message AI waiter. Email sends one final message (including attachments), without a separate session-created email. Standalone gateway receipt journals are isolated by control-plane URL; guest replies must match an approved intake request rather than granting a generic root-mail relay.

Actual configured-account receive/send acceptance remains a separate live rollout check; the isolated tests do not claim client-visible upstream delivery.

## Regression coverage

- Admission returns without waiting for an AI result; later input reaches RemoteLab's queue promptly.
- Prepared submission survives a lost acceptance response and repeats the same request id and payload.
- Sender downtime does not lose completed replies, even beyond the removed ten-minute deadline.
- Restart recovers pending intake and receipts without repeating accepted AI work or confirmed external sends.
- Different destinations remain independent; uncertain sends retain ordering within the same destination.
- Every email request gets a result delivery even with queued follow-ups; attachments remain in the same email.
- Feishu JSON and multipart source-delivery behavior remains unchanged.
- Actual execution failures/cancellation retain their own terminal semantics; delivery failures do not overwrite execution results.

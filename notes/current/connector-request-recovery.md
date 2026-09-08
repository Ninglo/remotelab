# Connector request recovery: first implementation

Implemented 2026-09-07. This replaces the Feishu wait/generate/direct-send lifecycle with durable admission and an outbox. The HTTP response publication is a read projection, not an independently written state machine.

## Ownership and normal flow

- `lib/connector-inbox.mjs` writes inbound events before the SDK handler returns. Each binding owns its Inbox directory. Its prepared handoff includes the fixed target session, model selection and attachment references; retrying after a lost HTTP response reuses that handoff.
- `chat/requests.mjs` owns accepted input, FIFO order, result snapshot, Delivery children and outstanding completion responsibility. Accepted IDs reserve immutable lookup addresses for request, response and execution. Normal lookup never enumerates historical runs.
- `chat/request-runtime.mjs` reconstructs execution order from active requests and uses the same scheduler for admission and restart. Completion work remains discoverable after the execution slot is released; it does not require another AI attempt.
- Runner `launch.json` is an exclusive durable attempt receipt. An already claimed attempt cannot start another tool process. Linux execution identity includes boot ID and process birth time; silence alone no longer terminates a runner. Explicit idle budgets remain optional.
- `chat/source-deliveries.mjs` reads immutable text and attachment plans from the Request aggregate. Each part has its own lease and remote receipt. A missing receipt becomes `unknown`; a verified part is never automatically sent again.
- `lib/delivery-receipts.mjs` keeps the sender's remote receipt until the control plane acknowledges it. Restart can resend the acknowledgement without repeating the external operation.

The file store serializes short writes, fsyncs the temporary record, atomically replaces it and fsyncs its parent directory. Network and model execution do not hold this queue. The gateway only changes instance business state through HTTP.

## Behavior changes

Admission returns a reserved Run identity immediately; it no longer means that the tool has already started. Busy-session follow-ups are individual FIFO requests, instead of a second batch queue. Consumers must observe the response/Run rather than assume synchronous startup. `killAll()` is asynchronous and drains state commits.

Ordinary Feishu output and scheduled Feishu output share Delivery ownership. Text and attachments are separately acknowledged. A target with an unknown send waits for explicit resolution; unrelated targets can still be claimed. The old in-memory Feishu queue, reply-wait loop and ordinary reply driver have been removed. Other platform adapters retain their platform behavior while using the shared request/response contract.

Result publication occurs before releasing the execution slot. The attachment writer reads session metadata without re-entering Run reconciliation: the former recursive read could wait on its own completion promise. Failed Runs have a failed response with no success payload, and a configured Feishu destination receives a durable failure notice.

## Verification

Run from the source checkout, with the existing clean-instance wrapper:

```sh
npm test
npm run test:connector-recovery
npm run test:triggers
npm run test:integration
npm run test:restart-gate
```

The recovery suite is included in `npm test`. It covers duplicate/conflicting input, fixed handoffs across restart, immutable result/Delivery commit, archived response lookup, lost control-plane acknowledgements, unknown sends, independent targets, superseded leases, partial attachments, completion recovery, schema refusal, conversion, PID reuse, pre-launch cancellation and real SIGKILL recovery. The subprocess test kills the controller after acceptance and during execution, lets its detached tool finish offline, and checks that there was exactly one tool start and no delivered reply is re-claimed.

A flaky test cleanup path formerly waited for a second `exit` event from an already killed child and masked the original error; cleanup now distinguishes signal exit and propagates child errors. The final fault-injection check also runs consecutive fresh processes.

## Offline conversion and rollout

**Consistent upgrade execution:** [upgrade-state tool](../../docs/request-state-upgrade-tool.md) now automates deterministic identity reconciliation, Inbox import, validation and journaled cutover. The converter details below describe the original deployment boundary; use the tool guide for current behavior.

**Operator entry point:** [legacy-instance upgrade and rollback](../../docs/request-state-upgrade.md). The first production attempt failed during conversion and its rollback did not restore service; see the [incident review](../archive/2026-09-07-request-state-upgrade-incident.md). Conversion later completed with additional repairs. The verification limits below describe the initial implementation, not the current migration status of every instance.

Production rollout is separate from code verification. New startup refuses pre-request runtime state; it does not scan and mutate old Run/Publications as a repair fallback.

The deployment-only converter writes a **new staging directory** and never modifies the source:

```sh
node scripts/convert-request-state.mjs --source <stopped-config> --output <new-staging-directory>
```

Unfinished executors require disposition. Prefer waiting for them to finish. If they have explicitly been stopped and are to be recorded as interrupted, pass `--interrupt-unfinished`. This is not a command for cancelling a live process; the operator must first stop it. The converter preserves session/history/assets, retains Run/response identities, imports pending follow-ups and transforms unknown old sends to `unknown`. It writes `conversion-report.json` for row-by-row review.

Before switching a gateway and its instances together:

1. Stop old input consumers/writers and inventory all unfinished work; preserve a full backup.
2. Convert each instance into staging and inspect its report. Review the converter identity mappings; reconcile unsupported batched identities if it refuses them.
3. Reconcile gateway `events.jsonl`, `handled-messages.json`, custom storage roots and receipt journals against the instance requests. The converter does not infer delivery success for ordinary historical replies. No uncertain historical message should be blindly replayed.
4. Verify pending completion targets and old executors separately. Historical results are preserved; the converter does not automatically resend old email/calendar completion effects.
5. Switch one complete gateway/instance unit, confirm real inbound, text, file and failure delivery, then restart it during a controlled task. Only after this passes should other users' instances be changed.

This iteration's automated evidence concerns isolated controller/runner processes and mocked external transports. It does not establish Feishu's remote idempotency horizon, host power-loss behavior, all supported filesystem fsync semantics or a successful production cutover. Those are deployment acceptance checks. The runtime deliberately preserves uncertainty instead of claiming end-to-end exactly-once delivery.

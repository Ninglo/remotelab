# WeChat Connector

WeChat is an instance-local connector. One RemoteLab instance owns one private worker, one binding state directory, and one bot/user authorization boundary.

## Capabilities

- inbound WeChat text / supported images (including image-only messages) -> RemoteLab session message
- native typing while processing, without an extra acknowledgement text bubble
- finalized RemoteLab reply -> the originating WeChat conversation
- `wechat:send_text` -> deterministic plain-text delivery without starting an AI run

## Binding and target semantics

WeChat currently restricts one user to one bot binding. RemoteLab models that limitation as binding cardinality, not as a separate connector type.

`wechat:send_text` resolves its target in this order:

1. an explicitly supplied `sessionId` that already belongs to a WeChat-backed RemoteLab session;
2. otherwise, the WeChat user who scanned the QR code and bound the instance-local bot.

The model-facing action intentionally does not accept an arbitrary raw WeChat user ID. Provider tokens and raw binding identifiers remain inside the connector worker.

## Runtime exposure

The long-running WeChat worker starts a loopback action server only while at least one pollable account binding is ready. It registers `wechat:send_text` in the instance connector capability registry and removes the registration when the binding disappears or the worker stops cleanly.

The legacy `scripts/wechat-connector.mjs` entrypoint remains the process launcher and transport implementation for now, but capability declaration comes from `manifest.json` and this package.

## Operator surface

Use `/connectors/wechat/login` inside the owning RemoteLab instance to bind or restore the bot. Do not copy bindings or tokens between owner and guest instances.

## Native processing feedback (not read receipts)

The worker uses `ilink/bot/getconfig` with the inbound peer and available context token to obtain a transient `typing_ticket`, then `ilink/bot/sendtyping` with status `1` (typing) / `2` (cancel). This is **not an acknowledgement/read receipt**, and does not change the bot nickname or avatar.

- A 300 ms grace period suppresses typing for fast tasks. A config response arriving after completion cannot start typing.
- Text and image-only processing share the same lifecycle. Unsupported payloads remain silent.
- Active tasks refresh typing every 5 seconds after the previous request settles; each provider request has a 5-second timeout. Overlapping work for the same account/peer shares one serialized lifecycle. One task finishing cannot cancel another's typing.
- Success, empty/duplicate publication, failure and cancellation release the lease before final delivery. Cleanup is asynchronous and cannot hold the task or final reply hostage. An ambiguous/failed start still triggers cancel; failed cancels get one bounded retry.
- Graceful worker exit cancels timers, drains in-flight feedback, and removes its signal listeners. Forced termination or provider failure cannot guarantee immediate remote disappearance; the provider controls expiry/rendering. No success is claimed in that case.
- Missing or failed ticket acquisition is logged once for that active target; it does not loop every five seconds throughout a long task. A fresh inbound message may retry with its latest context.
- Tickets are memory-only and discarded when idle. JSON logs contain only `component: wechat_typing`, `operation` (`getconfig`, `start`, `stop`) and `state` (`succeeded`, `failed`, `ticket_unavailable`); never raw provider errors, tickets, tokens or user identifiers. `succeeded` means API acceptance, not verified client visibility.
- Legacy `processingAckText` / `processingAckDelayMs` settings are no longer consumed. There is no fallback acknowledgement bubble. Final replies and actionable failure notices are unchanged.

### Review / diagnosis handoff

Copyable operator prompt: “Review and test the native WeChat typing diff in the selected checkout. Do not touch bindings, send messages, or restart services without separate deployment authorization. Report isolated test results and the `wechat_typing` operation/state logs, never credentials.”

Offline verification (no provider access; mocks only), from the checkout:

```sh
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" node scripts/run-with-clean-instance-env.mjs node tests/test-wechat-typing.mjs
TMPDIR="$PWD/.test-tmp" node scripts/run-with-clean-instance-env.mjs node tests/test-wechat-connector.mjs
TMPDIR="$PWD/.test-tmp" node scripts/run-with-clean-instance-env.mjs node tests/test-wechat-send-text-capability.mjs
```

No typing skill or arbitrary-target action is registered. An operator can explicitly test the current instance's existing **bound user only**, without starting a second poller, copying credentials, changing a binding, generating text, or deploying the worker:

```sh
node scripts/wechat-typing-check.mjs --config /path/to/instance/wechat-connector/config.json
```

This performs getconfig, a two-second typing start, then bounded cancellation (also attempted after an ambiguous start failure). There is no raw target/peer option. Credentials stay inside the connector process. Output contains sanitized API-acceptance flags and response field names, not tickets or user IDs. It explicitly reports `readReceipt=false` and `clientVisibilityVerified=false`; a human still needs to observe their own client to confirm display behavior. Run this only when a short status signal to that bound user is within the operator's authorization.

After an authorized worker deployment, send an ordinary task (also test image-only) and observe typing plus the sanitized worker logs. Absence of a ticket or provider rejection must be reported as such, not as successful typing or read status. API acceptance alone is not end-to-end client or production-rollout verification.

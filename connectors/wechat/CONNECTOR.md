# WeChat Connector

WeChat is an instance-local connector. One RemoteLab instance owns one private worker, one binding state directory, and one bot/user authorization boundary.

## Capabilities

- inbound WeChat text -> RemoteLab session message
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

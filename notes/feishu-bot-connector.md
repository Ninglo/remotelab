# Feishu Bot Connector Research

> Created 2026-03-10 to decide the fastest way to add Feishu as a RemoteLab external surface.
> Status: proposal / implementation guide.
> Use this together with `docs/external-message-protocol.md`.
> Operator handoff checklist: `notes/feishu-bot-operator-checklist.md`.

---

## Conclusion

If we want a **real Feishu connector** for RemoteLab, the right path is:

- build a **Feishu self-built app**
- enable **bot** capability
- subscribe to **`im.message.receive_v1`**
- receive events through **Feishu long connection** using the Node SDK
- map each Feishu chat thread to a normal RemoteLab session
- send the final assistant reply back through Feishu IM APIs

This is the fastest end-to-end path because it preserves our current architecture:

- Feishu stays a thin source adapter
- RemoteLab stays the canonical session/run/event engine
- the connector remains outside RemoteLab core

It is also the fastest Feishu-native implementation path because Feishu’s official docs explicitly position **long connection** as the “about 5 minutes” route for event handling, avoiding public webhook setup, signature verification, and decryption work.

---

## Terminology

We should keep the terms narrow and consistent.

### 1. Connector

A **connector** is the full external-surface adapter.

It owns:

- source-specific receive path
- source-specific auth / SDK / webhook handling
- message normalization into RemoteLab sessions/messages/runs
- source-specific outbound delivery back to that platform

Examples:

- email connector
- GitHub connector
- Feishu connector

### 2. Delivery target

A **delivery target** is narrower: it is only an outbound destination.

Examples:

- send one run result to email
- send one notification to a Feishu group webhook
- post one result back to GitHub as a comment

So:

- **connector** = inbound + outbound adapter around a platform
- **delivery target** = outbound sink only

### 3. Channel binding

A **channel binding** is the stable mapping between an upstream conversation identity and a RemoteLab session.

For Feishu, this should usually mean:

- one Feishu chat / DM thread / group thread key
- maps to one `externalTriggerId`
- which maps to one RemoteLab session

### 4. Completion target

`completion target` is the current repo term used by the email path, but architecturally it is the older, narrower concept.

Long term, the better generic term is:

- **connector** for the full platform adapter
- **delivery target** for the outbound sink

That matches `notes/message-transport-architecture.md` more cleanly than reusing the email-specific wording.

---

## Which Feishu bot we should use

There are two very different Feishu bot shapes.

### Option A — custom group bot webhook

This is the lightweight bot created directly inside one group, with a webhook like:

`https://open.feishu.cn/open-apis/bot/v2/hook/...`

This is useful for:

- one-way notifications
- alarms
- delivery-only integrations

This is **not** the right foundation for a RemoteLab connector because Feishu’s own docs say custom bots:

- only work inside the current group
- do not have data access permissions
- are mainly for pushing messages into a group via webhook

So this should be treated as a **Feishu delivery target**, not as a full connector.

### Option B — app bot inside a self-built Feishu app

This is the right model for RemoteLab.

It supports:

- bot capability
- event subscription
- receiving user messages through `im.message.receive_v1`
- sending and replying to messages through IM APIs
- long connection via the official SDK

This is the version that can behave like our email connector or future GitHub connector.

---

## Why long connection is the fastest path

Feishu supports two main inbound event modes:

- developer webhook endpoint
- long connection via SDK

For our current architecture, **long connection is the fastest path**.

Why:

1. It does not require a public callback URL.
2. It does not require signature verification or decryption logic.
3. It fits a local connector process running on the same machine as RemoteLab.
4. It keeps Feishu-specific transport logic out of RemoteLab core.
5. It is already documented with Node SDK examples.

This is especially attractive for a local-first product like RemoteLab, where the connector can live beside the server and call RemoteLab over `127.0.0.1` or the local chat plane.

---

## Architectural fit with RemoteLab

The current RemoteLab direction already says external systems should be reduced to a standard message flow.

That maps well to Feishu:

- Feishu DM or group context → RemoteLab session
- one incoming Feishu message → one RemoteLab message submission
- Feishu message ID → `requestId`
- Feishu chat identity → `externalTriggerId`
- final assistant message → Feishu reply

So Feishu should be implemented as just another thin client around:

- `POST /api/sessions`
- `POST /api/sessions/:sessionId/messages`
- `GET /api/runs/:runId`
- `GET /api/sessions/:sessionId/events`

The existing GitHub automation flow in `scripts/github-auto-triage.mjs` is a good structural template for:

- owner auth bootstrap
- session create/reuse
- request-id-based submission
- run polling
- assistant reply extraction

---

## Minimal Feishu mapping

### Session identity

Recommended `externalTriggerId` shapes:

- single chat: `feishu:p2p:${chatId}`
- group thread: `feishu:group:${chatId}`

If we later need stricter tenancy separation:

- `feishu:${tenantKey}:p2p:${chatId}`
- `feishu:${tenantKey}:group:${chatId}`

### Message identity

Recommended `requestId` shape:

- `feishu:${messageId}`

Feishu docs explicitly recommend deduping message intake by `message_id`, not by event envelope identifiers.

### Grouping

Recommended initial session metadata:

- `group`: `Feishu`
- `name`: `Feishu: <chat name or user display name>`
- `description`: short source-facing description such as `Inbound Feishu chat bridged into RemoteLab.`

### Normalized message preface

Use the same protocol shape we already use for external sources:

```text
Source: Feishu
Kind: p2p_message
Chat: oc_xxx
Message ID: om_xxx
Sender: Alice
Tenant: tenant_xxx

User message:
Can you summarize the deployment issue from today?
```

For group messages, add mention / thread context when relevant.

---

## Fastest implementation plan

### Phase 0 — Feishu delivery target only

If we only want outbound notifications quickly, use a **custom group bot webhook**.

This is useful for:

- alerts
- run-finished notifications
- delivery-only experiments

But this is **not** a connector.

### Phase 1 — real bidirectional connector

This is the recommended first real implementation.

1. Create a **Feishu self-built app**.
2. Enable **bot** capability.
3. Use the **test tenant / test version** flow for fast iteration.
4. Open the minimum permissions:
   - read bot single-chat messages
   - optionally read `@bot` group messages
   - send IM messages
5. Configure **event subscription** using **long connection**.
6. Subscribe `im.message.receive_v1`.
7. Run a local Node connector process using `@larksuiteoapi/node-sdk`.
8. On each inbound Feishu message:
   - derive `externalTriggerId`
   - derive `requestId`
   - normalize text
   - create or reuse RemoteLab session
   - submit message
   - background-poll run completion
   - send final assistant message back to Feishu

### Phase 2 — richer Feishu surface

Only after Phase 1 works:

- group `@bot` support
- reply-in-thread logic
- message cards
- custom menu events
- approval / action callbacks

---

## Important runtime constraint

Feishu long connection event handlers must finish quickly.

The official docs say:

- event handling must complete within **3 seconds**
- otherwise Feishu may retry / treat it as timeout

This means the connector must **not** wait for a full RemoteLab run inside the Feishu event callback.

The right shape is:

1. Feishu event arrives.
2. Validate / dedupe quickly.
3. Persist or enqueue a local job immediately.
4. Return success to Feishu.
5. Let a background task do the RemoteLab run + Feishu reply.

This is the key architectural adjustment for IM-style connectors.

Email was already asynchronous by nature.
Feishu events are more interactive, so the adapter must acknowledge first and finish the long work afterward.

---

## Recommended V0 scope

To move fast, the first version should be intentionally narrow.

### V0

- Feishu self-built app
- long connection only
- single-chat only
- subscribe only `im.message.receive_v1`
- dedupe by `message.message_id`
- send replies with `im.v1.message.create`
- one Feishu chat → one RemoteLab session

### V1

- support group `@bot` messages
- use `im.v1.message.reply` for group replies tied to the source message
- carry group metadata into the normalized preface

### V2

- support cards / menu events
- support approval-style workflows
- add explicit Feishu delivery target abstraction if needed

This avoids over-design before the basic session bridge is proven.

---

## Node implementation sketch

Because RemoteLab is already Node-based, the simplest connector process is also Node-based.

Suggested stack:

- package: `@larksuiteoapi/node-sdk`
- Feishu inbound: `WSClient`
- Feishu outbound: SDK `client.im.v1.message.create` and `client.im.v1.message.reply`
- RemoteLab auth: bootstrap owner cookie via `GET /?token=...`
- RemoteLab calls: plain `fetch`

High-level flow:

```text
Feishu WS event
  -> quick dedupe / enqueue
  -> create or reuse RemoteLab session
  -> submit message with requestId
  -> poll run
  -> load assistant message event
  -> send reply to Feishu
```

This is operationally very close to the GitHub triage script, just with a different ingress transport and different outbound API.

---

## Recommended permission set for first pass

The exact permission labels in the Feishu console may change, but the V0 connector should be based around this minimum set:

- bot capability enabled
- read user-to-bot single-chat messages
- optionally receive group `@bot` messages
- send IM messages

For the first pass, avoid broader group-read permissions unless we truly need them.

That keeps the bot conservative and easier to reason about.

---

## Official docs worth using

### RemoteLab docs

- External message protocol: `docs/external-message-protocol.md`
- Transport rationale and connector direction: `notes/message-transport-architecture.md`
- Existing connector-shaped script: `scripts/github-auto-triage.mjs`

### Feishu docs

- Quick bot setup:
  - `https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/step-1-create-app-and-enable-robot-capabilities`
  - `https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/step-3-configure-application-credentials`
  - `https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/step-5-configure-event-subscription`
- Echo-bot logic:
  - `https://open.feishu.cn/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/develop-an-echo-bot/introduction`
  - `https://open.feishu.cn/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/develop-an-echo-bot/development-steps`
- Event subscription via long connection:
  - `https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case`
  - `https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/subscription-event-case`
- Node SDK event handling:
  - `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/server-side-sdk/nodejs-sdk/preparation-before-development`
  - `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/server-side-sdk/nodejs-sdk/handling-events`
  - `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/server-side-sdk/nodejs-sdk/invoke-server-api`
- Core APIs:
  - `https://open.feishu.cn/document/ukTMukTMukTM/ukDNz4SO0MjL5QzM/auth-v3/auth/tenant_access_token_internal`
  - `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive`
  - `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create`
  - `https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply`
- Custom bot guide, useful only as outbound-only delivery target:
  - `https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN`

---

## Recommendation for the next implementation session

If we implement this next, the smallest worthwhile slice is:

1. add a standalone local `feishu-connector` process
2. use long connection + `im.message.receive_v1`
3. support only p2p chats first
4. bridge into RemoteLab using the existing external-message protocol
5. reply with plain text first

That should get us to the first real Feishu connector without changing RemoteLab core semantics.

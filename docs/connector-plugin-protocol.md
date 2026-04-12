# Connector Plugin Protocol

> Canonical protocol for communication between Connectors and RemoteLab Instances.
> Connectors are independent services that bridge external channels with RemoteLab.
> The relationship is 1:N — one Connector routes to many Instances.

---

## Terminology

- **Connector**: An independent service that bridges one external channel (email, Feishu, Slack, webhook, voice, etc.) with RemoteLab. Its sole job is: receive external events → dispatch to the correct Instance → push replies back through the external channel. A Connector does not run AI, does not understand message content, does not manage session logic.

- **Instance**: A RemoteLab runtime that runs AI sessions. It receives normalized messages from Connectors via its standard HTTP API. From the Instance's perspective, a Connector-delivered message is indistinguishable from a user typing in the web UI.

- **Tool / Skill**: An in-session capability (create calendar event, query database, etc.). Tools do not create sessions — they are invoked by sessions. Tools are NOT Connectors.

- **Dispatch Table**: The Connector's internal routing table. Maps external addresses/identifiers to target Instances. Built automatically from Instance registrations.

---

## Architecture

```
External World
      │
      ▼
Connector (independent service, one per channel)
      │  Owns: external credentials, dispatch table, admission rules
      │  Duties: receive → normalize → route → deliver → reply
      │
      ├──→ Instance A ← standard HTTP API
      ├──→ Instance B ← standard HTTP API
      └──→ Instance C ← standard HTTP API
```

Self-hosted single-user is the 1:1 special case: one Connector, one Instance, one catch-all rule. Same protocol, no special path.

---

## Optional Connector-Owned Surfaces

Some Connectors need a user-facing setup or authorization flow, such as QR login, OAuth consent, device pairing, or webhook verification. That UI should stay Connector-owned rather than being reimplemented inside the main Instance.

Recommended split:

- Connector owns the actual surface logic: login page, QR/status refresh, provider-specific state, retries, and setup instructions.
- Instance owns only a generic mount/proxy contract such as `/connectors/:id/*` plus a discovery endpoint like `/api/connectors/:id/surface`.
- The mounted URL is stable for the user, but the underlying page and state are still served by the Connector.

Minimal discovery shape:

```json
{
  "connectorId": "wechat",
  "title": "WeChat",
  "entryUrl": "/connectors/wechat/login",
  "allowEmbed": true,
  "surfaceType": "login"
}
```

Implications:

- Connectors can ship custom setup pages without changing Instance code per provider.
- The same stable URL can be embedded later in first-run onboarding or same-origin iframe-style session UI.
- Expiring artifacts such as QR codes refresh behind one stable mount instead of forcing AI or the frontend to re-orchestrate provider-specific state.

This surface contract is optional. Connectors that only need webhook I/O and no user-facing setup flow do not need to implement it.

---

## Protocol: Four Actions

```
Register   ─  Instance → Connector: establish bidirectional link
Deliver    ─  Connector → Instance: push external message
Reply      ─  Instance → Connector: push AI response
Deregister ─  Instance → Connector: tear down link
```

Plus one maintenance action:

```
Heartbeat  ─  Instance → Connector: confirm liveness
```

No polling anywhere. All communication is push-based.

---

## 1. Register

Instance comes online and registers with each Connector it wants to receive messages from.

### Request: Instance → Connector

```
POST connector:port/dispatch/register
Content-Type: application/json

{
  "instanceId": "instance-a",
  "instanceUrl": "https://instance-a.example.com",
  "token": "auth-token-for-connector-to-call-instance-API",
  "rules": [
    { "pattern": "alice@jiujianian.dev", "priority": 10 },
    { "pattern": "*@jiujianian.dev", "priority": 100 }
  ]
}
```

**Fields:**

| Field | Required | Description |
|---|---|---|
| `instanceId` | yes | Stable unique identifier for this Instance |
| `instanceUrl` | yes | Base URL of the Instance's HTTP API |
| `token` | yes | Auth token the Connector uses when calling Instance API |
| `rules` | yes | Array of dispatch rules (channel-specific match patterns) |
| `rules[].pattern` | yes | Match pattern (syntax defined by each Connector) |
| `rules[].priority` | yes | Lower number = higher priority. Used for cross-Instance ordering |

### Response: Connector → Instance

```json
{
  "registrationId": "reg_abc123",
  "connectorId": "email",
  "channel": "email",
  "callback": {
    "replyUrl": "https://connector.example.com/reply",
    "token": "auth-token-for-instance-to-push-replies"
  },
  "status": "active"
}
```

**After registration, both sides hold each other's credentials:**

- Connector holds `instanceUrl + token` → can deliver messages to Instance
- Instance holds `callback.replyUrl + callback.token` → can push replies to Connector

One handshake, bidirectional channel established.

### Idempotency

If the same `instanceId` registers again, the Connector replaces the previous registration (same `registrationId`). This allows Instances to update their rules or URL without explicit deregister.

---

## 2. Deliver

External event arrives at Connector. Connector normalizes, evaluates dispatch table, delivers to the target Instance.

### Request: Connector → Instance

Uses the existing RemoteLab HTTP API. No new endpoints needed on the Instance side.

**Step 1: Create or reuse session**

```
POST {instanceUrl}/api/sessions
Authorization: Bearer {instance-token}
Content-Type: application/json

{
  "folder": "~",
  "tool": "claude",
  "sourceId": "email",
  "sourceName": "Email",
  "externalTriggerId": "email:<rfc2822-message-id>",
  "group": "Email"
}
```

If a session with the same `externalTriggerId` already exists, the existing session is returned (deduplication).

**Step 2: Submit message**

```
POST {instanceUrl}/api/sessions/{sessionId}/messages
Authorization: Bearer {instance-token}
Content-Type: application/json

{
  "requestId": "cmsg_1712345678901_a3f2",
  "text": "Source: Email\nFrom: alice@example.com\nSubject: Re: build failure\n\nLinux build also needs the fix?",
  "sourceContext": {
    "channel": "email",
    "connectorId": "email",
    "messageId": "cmsg_1712345678901_a3f2",
    "from": { "address": "alice@example.com", "name": "Alice" },
    "to": { "address": "rowan@jiujianian.dev" },
    "subject": "Re: build failure",
    "inReplyTo": "<previous-message-id@example.com>"
  }
}
```

**Key design: `sourceContext` carries the reply context.**

The `sourceContext` object contains everything the Connector needs to send a reply (sender, recipient, subject, thread ID, etc.). The Instance stores it opaquely and returns it unchanged when pushing a reply. The Instance never needs to parse or understand these fields.

### Response

- `202` — message accepted, run started or queued
- `200` — duplicate `requestId`, idempotent no-op

---

## 3. Reply

Instance's AI produces a response. Instance pushes the reply to the Connector.

### Request: Instance → Connector

```
POST {callback.replyUrl}
Authorization: Bearer {callback.token}
Content-Type: application/json

{
  "instanceId": "instance-a",
  "sessionId": "session_xyz",
  "externalTriggerId": "email:<rfc2822-message-id>",
  "sourceContext": {
    "channel": "email",
    "connectorId": "email",
    "messageId": "cmsg_1712345678901_a3f2",
    "from": { "address": "alice@example.com", "name": "Alice" },
    "to": { "address": "rowan@jiujianian.dev" },
    "subject": "Re: build failure",
    "inReplyTo": "<previous-message-id@example.com>"
  },
  "reply": {
    "body": "Yes, Linux also needs the fix. I've opened a PR...",
    "html": null,
    "attachments": []
  }
}
```

**Fields:**

| Field | Required | Description |
|---|---|---|
| `instanceId` | yes | Which Instance is sending this reply |
| `sessionId` | yes | The session that produced the reply |
| `externalTriggerId` | yes | Links back to the original external thread |
| `sourceContext` | yes | Opaque object, returned unchanged from Deliver |
| `reply.body` | yes | Plain text reply content |
| `reply.html` | no | HTML version of the reply |
| `reply.attachments` | no | File attachments |

**Connector's job on receiving a reply:**

1. Read `sourceContext` to reconstruct external addressing (e.g., swap `from`/`to`, set `In-Reply-To` header)
2. Send via external API (Cloudflare Worker, Feishu API, etc.)
3. Return delivery result

### Response: Connector → Instance

```json
{
  "delivered": true,
  "externalId": "cloudflare-worker-message-id-xxx",
  "channel": "email"
}
```

Or on failure:

```json
{
  "delivered": false,
  "error": "external_api_error",
  "message": "Cloudflare Worker returned 429",
  "retryable": true
}
```

---

## 4. Deregister

Instance going offline. Tells Connector to stop routing messages to it.

### Request: Instance → Connector

```
DELETE connector:port/dispatch/register/{registrationId}
Authorization: Bearer {instance-token}
```

### Response: Connector → Instance

```json
{
  "registrationId": "reg_abc123",
  "status": "removed",
  "rulesRemoved": 2
}
```

Connector immediately removes all rules for this Instance from the dispatch table. Subsequent messages that would have matched this Instance fall through to the next priority rule, or enter the dead letter queue if no rule matches.

---

## 5. Heartbeat

Instance periodically confirms it is alive.

### Request: Instance → Connector

```
POST connector:port/dispatch/heartbeat
Content-Type: application/json

{
  "registrationId": "reg_abc123"
}
```

### Response

```json
{
  "status": "active",
  "lastHeartbeat": "2026-04-10T14:30:00Z"
}
```

### Timeout behavior

- Default heartbeat interval: 30 seconds
- If no heartbeat received for 60 seconds: Connector marks Instance as `stale`
- Stale Instances stop receiving new messages; traffic falls through to next priority rule
- When a stale Instance sends a heartbeat, it is restored to `active` immediately

---

## Dispatch Table

The Connector's internal routing state. Built automatically from registrations.

### Schema

```json
{
  "version": 1,
  "entries": [
    {
      "registrationId": "reg_abc123",
      "instanceId": "instance-a",
      "instanceUrl": "https://instance-a.example.com",
      "token": "xxx",
      "rules": [
        { "pattern": "alice@jiujianian.dev", "priority": 10 }
      ],
      "status": "active",
      "registeredAt": "2026-04-10T12:00:00Z",
      "lastHeartbeat": "2026-04-10T14:30:00Z"
    },
    {
      "registrationId": "reg_def456",
      "instanceId": "default",
      "instanceUrl": "https://default.example.com",
      "token": "yyy",
      "rules": [
        { "pattern": "*@jiujianian.dev", "priority": 100 }
      ],
      "status": "active",
      "registeredAt": "2026-04-10T12:00:00Z",
      "lastHeartbeat": "2026-04-10T14:30:00Z"
    }
  ]
}
```

### Matching logic

1. Collect all rules from all `active` entries
2. Sort by `priority` (ascending — lower number = higher priority)
3. First matching rule wins
4. If same priority, earlier `registeredAt` wins
5. If no rule matches, message goes to dead letter

### Pattern syntax

Pattern syntax is channel-specific. Each Connector defines its own grammar:

**Email Connector:**
- Exact: `alice@jiujianian.dev`
- Wildcard: `*@jiujianian.dev`
- Local part prefix: `support-*@jiujianian.dev`

**Feishu Connector:**
- Group: `group:oc_abc123`
- User: `user:ou_xyz789`
- Wildcard: `*`

**Webhook Connector:**
- Path: `/hook/instance-a`
- Header match: `X-Target: instance-a`
- Wildcard: `*`

The dispatch table structure and target format are universal across all Connectors. Only the `pattern` field is channel-specific.

---

## Error Handling

### Delivery failure (Connector → Instance)

| Condition | Action |
|---|---|
| Instance returns 5xx or timeout | Retry 3 times: 5s, 15s, 60s intervals |
| All retries exhausted | Message enters dead letter queue |
| Instance returns 4xx (not 429) | No retry, message enters dead letter queue |
| Instance returns 429 | Retry with backoff per `Retry-After` header |
| Repeated failures (>5 in 10 min) | Mark Instance as `degraded` |
| Instance `degraded` for >5 min with no recovery | Mark as `stale`, stop routing |

### Reply failure (Instance → Connector)

| Condition | Action |
|---|---|
| Connector callback returns 5xx or timeout | Retry 3 times: 5s, 15s, 60s intervals |
| All retries exhausted | Store reply in local pending queue |
| Connector recovers (next heartbeat succeeds) | Flush pending replies |
| Reply permanently undeliverable | Mark session with `replyDeliveryFailed` |

### Dead letter queue

Connector maintains a `dead_letter/` store for undeliverable messages:

```json
{
  "originalMessage": { "...standard envelope..." },
  "failureReason": "all_retries_exhausted",
  "targetInstanceId": "instance-a",
  "failedAt": "2026-04-10T15:00:00Z",
  "retryCount": 3,
  "lastError": "ECONNREFUSED"
}
```

Dead letters can be manually re-dispatched or discarded by the admin.

---

## Authentication

All cross-service calls use Bearer token auth:

```
Authorization: Bearer {token}
```

- Connector → Instance: uses `token` from registration request
- Instance → Connector: uses `callback.token` from registration response

Tokens are exchanged once during Register and stored by both sides. No OAuth, no session cookies, no API key rotation protocol (can be added later without changing the wire format).

---

## 6. Skill Declaration

Connectors are not just message bridges — they are **Skill Providers**. Each Connector can declare capabilities that the AI model can invoke during a session.

### Motivation

Outbound messaging has two distinct paths:

- **Reply** (reactive): Model finishes processing an inbound message and responds via the same channel. Driven by `sourceContext` round-trip — the Instance never needs to understand addressing. This is Protocol Action 3 above.
- **Proactive Send** (initiative): Model decides to send a message on its own — a reminder, a notification to a third party, a bulk email. There is no inbound message to reply to. The model must specify the recipient explicitly.

Reply is a protocol-level action (automatic, tied to session completion). Proactive Send and other channel-specific capabilities are **Skills** — model-initiated, explicit, and diverse across channels.

### How Skills are Declared

Connectors declare their skills in the **Register response**. When an Instance registers, the Connector returns its available skills alongside the callback info:

```json
{
  "registrationId": "reg_abc123",
  "connectorId": "email",
  "channel": "email",
  "callback": {
    "replyUrl": "https://connector.example.com/reply",
    "skillUrl": "https://connector.example.com/skill",
    "token": "auth-token-for-instance-to-call-connector"
  },
  "skills": [
    {
      "name": "send",
      "description": "Send an email to a recipient",
      "schema": {
        "to": { "type": "string", "required": true, "description": "Recipient email address" },
        "subject": { "type": "string", "required": true, "description": "Email subject line" },
        "body": { "type": "string", "required": true, "description": "Email body (plain text)" },
        "cc": { "type": "array", "items": "string", "description": "CC recipients" },
        "bcc": { "type": "array", "items": "string", "description": "BCC recipients" },
        "html": { "type": "string", "description": "HTML version of the body" },
        "replyTo": { "type": "string", "description": "Reply-To address" }
      }
    },
    {
      "name": "send_bulk",
      "description": "Send same email to multiple recipients",
      "schema": {
        "recipients": { "type": "array", "items": "string", "required": true },
        "subject": { "type": "string", "required": true },
        "body": { "type": "string", "required": true }
      }
    }
  ],
  "status": "active"
}
```

### Convention: `send` is a Well-Known Skill Name

Every outbound-capable Connector SHOULD implement a skill named `send` with a common minimum schema:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | yes | Recipient address (format defined by channel) |
| `body` | string | yes | Plain text content |

Channels extend this base with their own fields:

- **Email**: `+ subject, cc, bcc, html, replyTo, attachments`
- **Feishu**: `+ msgType, mentions, cardTemplate`
- **Slack**: `+ channel, thread_ts, blocks`

The model can use just `to` + `body` for a simple cross-channel "send a message" invocation. Channel-specific parameters are optional extensions.

### Channel-Specific Skills

Beyond `send`, each Connector may declare arbitrary skills unique to its channel:

**Feishu Connector:**
```json
{
  "skills": [
    { "name": "send", "description": "Send message to user or group", "schema": { "..." } },
    { "name": "create_group", "description": "Create a group chat", "schema": { "name": {}, "members": {} } },
    { "name": "pin_message", "description": "Pin a message in a group", "schema": { "groupId": {}, "messageId": {} } }
  ]
}
```

**Slack Connector:**
```json
{
  "skills": [
    { "name": "send", "description": "Post message to channel or DM", "schema": { "..." } },
    { "name": "set_topic", "description": "Set channel topic", "schema": { "channel": {}, "topic": {} } },
    { "name": "add_reaction", "description": "Add emoji reaction", "schema": { "channel": {}, "timestamp": {}, "emoji": {} } }
  ]
}
```

The Instance does not understand any of these schemas. It stores them and makes them available to the model as tools.

---

## 7. Skill Execution

When the model invokes a connector skill during a session, the Instance routes the call to the Connector's skill endpoint.

### Request: Instance → Connector

```
POST {callback.skillUrl}/{skillName}
Authorization: Bearer {callback.token}
Content-Type: application/json

{
  "instanceId": "instance-a",
  "sessionId": "session_xyz",
  "parameters": {
    "to": "bob@example.com",
    "subject": "Meeting reminder",
    "body": "Hey Bob, 3pm today."
  }
}
```

### Response: Connector → Instance

Success:

```json
{
  "success": true,
  "result": {
    "externalId": "msg-xxx",
    "channel": "email"
  }
}
```

Failure:

```json
{
  "success": false,
  "error": "recipient_not_found",
  "message": "bob@example.com is not a valid recipient"
}
```

The Instance returns this response directly as the tool result to the model.

### Model's View

Skills appear as tools with the naming convention `{channel}:{skillName}`:

```
Available tools (dynamically registered):
  email:send          — Send an email to a recipient
  email:send_bulk     — Send same email to multiple recipients
  feishu:send         — Send message to user or group
  feishu:create_group — Create a Feishu group chat
```

The model decides when and how to use them. The Instance acts as a pass-through router.

### Execution Flow

```
Model invokes email:send(to, subject, body)
  │
  ▼
Instance looks up connector registry: email → skillUrl
  │
  ▼
POST {skillUrl}/send  (Bearer callback.token)
  │
  ▼
Connector executes (uses its own Cloudflare/SMTP/API credentials)
  │
  ▼
Response → Instance → tool result → Model
```

### Skill vs Reply: Comparison

| Aspect | Reply | Skill |
|--------|-------|-------|
| Trigger | Session completion (automatic) | Model tool call (explicit) |
| Addressing | sourceContext round-trip | Model specifies recipient |
| Instance understands address? | No | No (passes through) |
| Endpoint | `POST {replyUrl}` | `POST {skillUrl}/{name}` |
| Auth | Same callback.token | Same callback.token |
| Tied to inbound message? | Yes (always) | No (independent) |

---

## Protocol Summary

| Action | Direction | Endpoint | Trigger |
|--------|-----------|----------|---------|
| Register | Instance → Connector | `POST /dispatch/register` | Instance comes online |
| Heartbeat | Instance → Connector | `POST /dispatch/heartbeat` | Every 30s |
| Deregister | Instance → Connector | `DELETE /dispatch/register/:id` | Instance going offline |
| Deliver | Connector → Instance | `POST /api/sessions` + `/messages` | External event arrives |
| Reply | Instance → Connector | `POST {callback.replyUrl}` | AI reply completed |
| Skill | Instance → Connector | `POST {callback.skillUrl}/{name}` | Model invokes tool |

Six interactions. Connector exposes 4 endpoint groups (register, heartbeat, reply, skill). Instance exposes 2 (sessions, messages — already exist).

---

## Deployment Models

### Self-hosted single user

```
Email Connector (local process)
  dispatch table: [{ pattern: "*@domain.dev", target: localhost:7690 }]
      │
      ▼
RemoteLab Instance (localhost:7690)
```

One Connector, one Instance, one catch-all rule. Same protocol as multi-instance.

### Managed multi-instance

```
Email Connector (shared service)
  dispatch table:
    alice@domain.dev → Instance A
    bob@domain.dev → Instance B
    *@domain.dev → Instance Default
      │
      ├──→ Instance A (vm-a:7690)
      ├──→ Instance B (vm-b:7690)
      └──→ Instance Default (vm-default:7690)
```

### Multiple Connectors

```
Email Connector ──→ Instance A, B, C
Feishu Connector ──→ Instance A, D
Webhook Connector ──→ Instance E
```

Each Connector is independent. They share no state. Instances can register with multiple Connectors.

---

## Migration from Existing Code

| Current code | New role |
|---|---|
| Cloudflare Email Worker (`cloudflare/email-worker/`) | Email Connector: inbound webhook handler |
| `agent-mail-http-bridge.mjs` | Email Connector: HTTP bridge component |
| `agent-mail-worker.mjs` / `embedded-mail-worker.mjs` | Replaced by: Connector delivers via Instance HTTP API |
| `resolveMailboxRootForPayload()` | Replaced by: Connector dispatch table |
| `allowlist` logic | Email Connector: admission check (before dispatch) |
| Cloudflare Worker outbound | Email Connector: reply sender (receives from callback) |
| `connector-bindings.mjs` | Preserved: per-Instance binding/authorization state |
| `connector-state.mjs` | Preserved: capability/delivery state machine |
| `connector-action-dispatcher.mjs` | Replaced by: Instance pushes reply to Connector callback |
| `external-message-protocol.md` | Preserved: defines the Instance-side HTTP API that Connectors call |
| `voice-connector.mjs` / `feishu-connector.mjs` | Refactored into standalone Connectors following this protocol |

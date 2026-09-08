# External Message Protocol

This document is the canonical integration contract for any external tool that wants to use RemoteLab as a **local agent runtime**.

Use it when integrating things like:

- email intake / reply workers
- GitHub issue or PR bridges
- chat bots / IM relays
- custom local automation that wants to open a session and hand work to the active agent

The key product stance is simple:

> RemoteLab does **not** care how another system models threads, issues, emails, bots, or replies.
> The connector normalizes that source into a standard message flow.
> RemoteLab accepts the message, runs the local agent, and exposes normalized session/run/event state back out.

That means platform-specific wrapping stays outside RemoteLab.

---

## 0. Connector topology classes

Before designing a connector, classify it by **protocol capability**:

- **Gateway-capable**
  - the upstream platform can support a shared ingress that receives messages for multiple RemoteLab instances and routes them
  - the same connector can still be deployed as a private single-instance ingress
- **Instance-only**
  - the upstream platform cannot support a shared multi-instance gateway
  - the connector must bind directly to one RemoteLab instance

This yields the primary product rule:

> If a connector is Gateway-capable, it can also run as a single-instance connector.
> If a connector is Instance-only, it must not be modeled as a shared gateway.

Examples in the current product model:

- **Email** — Gateway-capable
- **Feishu** — Gateway-capable
- **WeChat** — Instance-only

Deployment ownership is a separate axis:

- **Official managed** — RemoteLab operates the shared ingress/bot/service
- **User owned** — the user binds their own upstream account/app/bot and RemoteLab runs the adapter

For Gateway-capable connectors, both ownership models are possible.
For Instance-only connectors such as WeChat, the normal shape is a user-owned, instance-local connector worker that is seeded and auto-started when the instance is created and never participates in cross-instance routing.

---

## 1. What RemoteLab is responsible for

RemoteLab owns only the shared conversation/runtime layer:

- authenticate the caller
- create or reuse a session
- append a new user message into that session
- execute the selected local agent tool
- persist run state and normalized events on disk
- commit request results and source-delivery outbox records together
- expose independently claimable deliveries, leases, acknowledgements, and operator resolution over HTTP
- expose status and events over HTTP
- optionally send lightweight realtime invalidation over WebSocket

RemoteLab does **not** need to know:

- whether the source was email, GitHub, Slack, Discord, WeChat export, or something else
- how the upstream system renders threads or replies
- how the connector formats the final message for that platform
- whether the upstream source is “standard chat” or a more awkward surface like GitHub issues

If the connector can turn an upstream update into “a new user message in an existing conversation”, that is enough.

---

## 2. Canonical mapping

Every integration should reduce its own model to this mapping:

| External concept | RemoteLab concept | Notes |
|---|---|---|
| upstream thread / issue / email chain / DM | session | usually one RemoteLab session per external thread |
| one upstream inbound update | message submission | one `requestId` per update |
| upstream thread key | `externalTriggerId` | stable session dedupe key |
| upstream actor metadata | optional light context inside `text` | keep source-specific structure outside RemoteLab and avoid turning each message into a connector-specific prompt |
| local agent reply | assistant events in session history | connector decides how to render or deliver them |
| source-side follow-up | another message submission | same session, new `requestId` |

This is the main simplification:

> Even something non-chat-like, such as a GitHub issue comment, is still just a user message.

The connector can add a short preface such as actor, source, URL, or thread title when that context is genuinely needed, then pass the normalized text to RemoteLab. Prefer the thinnest possible wrapper around the real user message.

---

## 3. Independent admission and delivery

A connector has two independently recoverable jobs, not one long-lived function waiting for AI:

1. Persist the upstream event in a durable inbox before acknowledging receipt or advancing the upstream cursor.
2. Authenticate, resolve/create the session, and persist the prepared submission (stable `requestId`, exact body, session, and `sourceDelivery`).
3. Submit to RemoteLab. On a lost HTTP response, retry the same prepared submission, not a newly rendered message. Once accepted, finish inbox handling immediately; later messages can enter RemoteLab's normal queue.
4. RemoteLab executes normally, without a connector-imposed AI deadline. It commits the result and its delivery records in the same request aggregate.
5. An independent sender claims ready deliveries, formats and sends them, durably records the upstream receipt, then acknowledges the lease. It never waits for an individual AI run.
6. After a restart, inbox processing and receipt/outbox processing resume from disk.

A protocol acknowledgement or optional “received” notice is not the final AI response. Failure of a decorative acknowledgement must not block admission.

Feishu, WeChat, and inbound Email use this request-scoped contract. A persistent upstream connection may still need a resident process; each message does **not** need a resident waiter. Legacy explicit email completion targets remain compatible, but new email intake must not also attach them and create a second final-delivery owner.

---

## 4. Authentication

Today, the simplest machine-to-machine path is the same owner auth used by the browser UI:

1. bootstrap a session cookie with `GET /?token=...`
2. reuse the returned `session_token` cookie for later API calls

Example:

```bash
BASE_URL="https://your.remotelab.host"
TOKEN="YOUR_OWNER_TOKEN"

curl -sS -L \
  -c cookie.jar \
  "${BASE_URL}/?token=${TOKEN}" \
  >/dev/null
```

After that, reuse `cookie.jar` on HTTP requests and WebSocket upgrades.

Current note:

- this is owner-scope auth
- visitor auth is for shared Agents, not for automation connectors

---

## 5. Session creation / reuse

Create a session with:

`POST /api/sessions`

Required fields:

- `folder` — must resolve to a real directory on disk; most connectors should use `~`
- `tool` — the local tool to run, such as `codex`

Useful optional fields for connectors:

- `name` — optional seed title; omit it unless you already have concrete thread/task context
- `sourceId` — stable connector/runtime source id such as `feishu`, `email`, or `wechat`
- `sourceName` — human-facing connector/runtime source name such as `Feishu`, `Email`, or `WeChat`
- `templateId` — optional Agent id when this connector should run under a reusable Agent definition
- `templateName` — human-facing label for that Agent
- `group` — top-level grouping such as `Mail`, `GitHub`, `Bots`
- `description` — short human-facing description
- `systemPrompt` — optional connector-specific override; keep it minimal and use it only for constraints not already handled by backend-owned source logic
- `externalTriggerId` — stable dedupe key for the upstream thread
- `sourceContext` — optional structured session-level source metadata kept outside the inline user message text and retrievable later on demand

Backend-owned source/runtime policy:

- prefer setting `sourceId` / `sourceName` so RemoteLab can apply one shared backend prompt policy for that connector type
- do not treat per-connector `systemPrompt` as the primary place for core business logic
- keep connector overrides narrowly about runtime constraints or local quirks, not the main product semantics

Naming policy for connector-created sessions:

- prefer letting RemoteLab auto-rename after the actual inbound message lands
- only send `name` when it already contains clear thread-specific context
- do not repeat provider/source/group words already stored in `group`, `sourceName`, `templateName`, or other metadata
- generic names such as `Feishu group`, `GitHub issue`, or `Mail reply` are treated as temporary and may be discarded

For recurring owner-side automations, prefer treating the connector as an Automation Agent:

- create a normal RemoteLab Agent for the automation's identity and prompt
- use that Agent's `id`, `name`, and `systemPrompt` as `templateId`, `templateName`, and `systemPrompt` when creating/reusing the review session
- keep one stable `externalTriggerId` per automation thread so review stays in one durable session

See `automation-apps.md` for the higher-level product pattern.

Example:

```bash
curl -sS \
  -b cookie.jar \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/sessions" \
  -d '{
    "folder": "~",
    "tool": "codex",
    "name": "owner/repo#123 — macOS build failure",
    "sourceId": "github",
    "sourceName": "GitHub",
    "group": "GitHub",
    "description": "External GitHub thread bridged into RemoteLab.",
    "externalTriggerId": "github:owner/repo#123"
  }'
```

Important behavior:

- if an unarchived session with the same `externalTriggerId` already exists, RemoteLab returns that session instead of creating a new one
- this is the main dedupe mechanism for “one external thread → one RemoteLab session”
- if the provided `name` is generic or only repeats connector/source/group metadata, RemoteLab keeps the session auto-renameable instead of locking that title in
- the owner sidebar source grouping derives from session metadata rather than a hardcoded frontend list

---

## 6. Message submission

Submit a new inbound update with:

`POST /api/sessions/:sessionId/messages`

Required fields:

- `requestId` — unique per inbound update inside that session
- `text` — normalized message body to append as the next user message

Optional owner-only fields:

- `tool`
- `model`
- `effort`
- `thinking`
- `sourceContext`
- `sourceDelivery` — final reply destination, persisted with this request (see below)
- `images`

Example:

```bash
curl -sS \
  -b cookie.jar \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/sessions/${SESSION_ID}/messages" \
  -d '{
    "requestId": "github:owner/repo#123:comment:456",
    "text": "Source: GitHub\nKind: issue_comment\nRepo: owner/repo\nThread: #123\nActor: alice\nURL: https://github.com/owner/repo/issues/123#issuecomment-456\n\nUser message:\nThe build still fails on macOS after the latest patch.",
    "tool": "codex"
  }'
```

Response behavior:

- `202` means the update was accepted, either as a new active run or as a queued follow-up
- `200` means the same `requestId` was already seen and the call was treated as a duplicate
- an invalid explicit `sourceDelivery` is rejected before accepting AI work; the server must not silently drop the requested final-reply route

Important response fields:

- `duplicate` — idempotency result for this `requestId`
- `queued` — `true` when the message was accepted into the session follow-up queue instead of starting a new run immediately
- `run` — the new run when one started immediately, otherwise `null`

If you want source metadata to stay queryable without padding every prompt, prefer:

- keeping the inline `text` close to the real user message
- storing session-level metadata on `POST /api/sessions` via `sourceContext`
- storing per-message metadata on `POST /api/sessions/:sessionId/messages` via `sourceContext`
- retrieving it only when needed with `GET /api/sessions/:sessionId/source-context`
- `session` — the refreshed session payload

For UI and status rendering, external clients should prefer the server-authored `session.activity` object instead of inventing their own session lifecycle states on the client.

Current `session.activity` shape:

- `activity.run.state` — coarse run state: `running` or `idle`
- `activity.run.phase` — underlying durable run phase such as `accepted`, `running`, `completed`, `failed`, or `cancelled` when available
- `activity.queue.state` / `activity.queue.count` — follow-up backlog state
- `activity.compact.state` — background compaction state: `idle` or `pending`

Title, Space, Project group, workflow state, and `workState.summary` are durable post-turn Session projections. They are refreshed asynchronously by one classifier and are not part of the live `session.activity` state machine.

The `session.activity` object is the canonical backend activity contract.

This means connectors should treat `requestId` as the idempotency key for one upstream update.

---

## 7. Durable delivery and optional progress observation

### Source-delivery contract

Pass an explicit `sourceDelivery` on message admission:

```json
{
  "connector": "wechat",
  "sourceRouteId": "instance-account-route",
  "target": { "accountId": "bound-account", "peerUserId": "upstream-peer", "messageId": "upstream-message", "contextToken": "upstream-context" }
}
```

Supported connectors are `feishu`, `wechat`, and `email`. Targets are adapter-specific, validated routing data; credentials remain in instance bindings. Email targets contain `to`, an optional bound reply alias `from`, `subject`, `inReplyTo`, `references` (an array), and thread/message identifiers. Email text and attachments form one delivery; IM text and attachments have separately tracked delivery records.

The independent sender uses owner-authenticated APIs:

- `POST /api/source-deliveries/claim` with `connector` and `sourceRouteId` returns a delivery and lease, or no available work.
- `POST /api/source-deliveries/:id/complete` with `leaseId` and `externalId` acknowledges a durable upstream receipt. Repeated acknowledgements of the same receipt are harmless.
- `POST /api/source-deliveries/:id/fail` records sending failure. Set `safeToRetry` only when the upstream operation can safely repeat; ambiguous sends become `unknown`, not blind retries.
- `GET /api/source-deliveries?connector=...&sourceRouteId=...` exposes pending/unresolved deliveries. Optional `includeActivity=true` also returns compact unsettled-request destinations (no prompt bodies), so native typing can be independently reconstructed from durable state.
- `POST /api/source-deliveries/:id/resolve` with `state` (`pending`, `delivered`, or `cancelled`) and `reason` allows explicit recovery after upstream inspection.

An expired sending lease means **delivery outcome unknown**, not AI failure. Unknown deliveries block the same destination's following deliveries, not unrelated destinations. Persist receipts before acknowledging RemoteLab, and replay those acknowledgements before claiming new work. Upstream delivery cannot in general guarantee exactly-once transport; retain uncertainty rather than silently sending twice.

Request execution and delivery state are separate: delivery failure never rewrites a successful AI result. Every request gets its own outbox records, even when the session has queued follow-ups.

### Optional progress observation

Clients may also observe progress. This is not a prerequisite for final delivery and must not own the delivery lifecycle.

### Option A — HTTP polling

Use the returned `run.id` and poll:

`GET /api/runs/:runId`

Current run states converge around:

- `accepted`
- `running`
- `completed`
- `failed`
- `cancelled`

For terminal failures, wait for the canonical run/reply publication to settle and preserve its final `failureReason` / `lastError` into connector handling. User-visible notices should map known causes to localized, safe, actionable explanations—such as capacity full, temporary overload, exhausted balance or quota, invalid authorization, context too long, attachment unavailable, or timeout. Do not expose raw provider payloads, credentials, host paths, or stack traces. Use a generic “could not generate a reply” notice only when the final reason is absent or genuinely unclassified.

Once a message has been accepted, a temporary transport error or restart response (`fetch failed`, connection reset/refused, HTTP 408/425/429/5xx) is not a terminal generation result. An observer may stop waiting and return the request/response identifiers, but that cannot mark the AI request failed or discharge its delivery responsibility. Authentication/protocol failures are connector faults, not evidence of model failure. Only canonical execution results determine generation failure or cancellation. Retain bounded timeouts for individual HTTP operations and sender leases; do not add an overall connector AI wait deadline.

### Option B — WebSocket invalidation + HTTP fetch

Connect to:

`GET /ws`

with the owner cookie.

Important rule:

- this WebSocket is **push-only**
- clients do **not** send actions on it
- it only tells you that canonical state changed

Today the relevant push frames are lightweight invalidations such as:

```json
{ "type": "session_invalidated", "sessionId": "abc123" }
```

and:

```json
{ "type": "sessions_invalidated" }
```

When you receive one, re-fetch state via HTTP.

This matches the current architecture rule:

> HTTP is the source of truth; WebSocket only hints that something changed.

---

## 8. Reading normalized events

Fetch the complete normalized session history with:

`GET /api/sessions/:sessionId/events`

Example:

```bash
curl -sS \
  -b cookie.jar \
  "${BASE_URL}/api/sessions/${SESSION_ID}/events"
```

The response includes:

- `events` — normalized events in sequence order

Legacy pagination-style query parameters such as `afterSeq` or `limit` are ignored. RemoteLab intentionally loads the full event list and keeps heavy thinking/tool bodies behind explicit body fetches.

Large or deferred event bodies can be fetched with:

`GET /api/sessions/:sessionId/events/:seq/body`

For owner chat sessions, the main event index is completeness-first: it returns the full event list, while heavy thinking/tool bodies stay deferred behind the event-body route.

Current normalized event types include:

- `message`
- `reasoning`
- `status`
- `tool_use`
- `tool_result`
- `file_change`
- `usage`

Normalized events support observation and debugging. Production source-delivery consumers send the committed request reply payload rather than selecting a session's latest assistant event: another request may already be running by then. The shared reply-selection logic skips assistant-side artifacts such as Codex `todo_list` tails and can fall back past a trailing checklist-only message in the same run.

---

## 9. Normalization rules for connectors

This part is the real protocol discipline.

### Required rules

- Use one stable `externalTriggerId` per upstream thread.
- Use one unique `requestId` per inbound upstream update.
- Treat every inbound upstream update as a **user message**.
- Put only the upstream metadata that materially helps disambiguate the user message into the message body.
- Do not restate connector-side reply-formatting rules on every message; keep turn semantics as backend-owned as possible.
- Keep source-specific rendering, approval rules, and publishing logic outside RemoteLab.

### Good message preface shape

This is a good generic template when extra context is actually needed:

```text
Source: GitHub
Kind: issue_comment
Thread: owner/repo#123
Actor: alice
URL: https://github.com/owner/repo/issues/123#issuecomment-456

User message:
The build still fails on macOS after the latest patch.
```

And for email:

```text
Source: Email
From: alice@example.com
Subject: Re: build failure follow-up
Date: 2026-03-10T08:30:00Z

User message:
Can you confirm whether the fix should also cover Linux?
```

This keeps the core protocol uniform while still preserving upstream context. If the raw user message is already clear on its own, prefer sending just the message instead of padding it with repeated connector metadata.

---

## 10. What is shipped today vs not yet shipped

### Shipped today

- session creation over HTTP
- message submission over HTTP
- idempotency via `requestId`
- session dedupe via `externalTriggerId`
- optional run polling via HTTP
- normalized event reads via HTTP
- push-only WebSocket invalidation
- request-scoped durable outbox for Feishu, WeChat, and Email
- independent delivery claims, receipt acknowledgements, and explicit uncertain-send resolution

### Not yet shipped as a general connector primitive

- a generic server-to-server webhook callback for run/session events
- an outbound adapter for every arbitrary external platform (GitHub automation still owns its publication)
- a dedicated connector auth scope
- full model-writable session metadata beyond the currently exposed creation fields

Explicit email completion targets remain a compatibility/automation path. New inbound email uses the shared request outbox instead of relying on a whole session becoming idle. WhatsApp Business and the local Voice Connector are retired; the browser/mobile Shortcut surface is separate.

---

## 11. Recommended integration stance right now

If you are integrating another tool today, the most stable approach is:

1. keep your source wrapper outside RemoteLab
2. authenticate as the owner
3. create or reuse one session per upstream thread
4. submit each inbound update as a new user message
5. include a validated `sourceDelivery` destination in the durable request
6. run an independent receipt-aware outbox consumer for your platform; observe progress only when useful

This already covers most automation surfaces, including non-standard ones like GitHub issues, because the protocol only assumes one thing:

> an upstream system can always be reduced to “there is a thread, and there is a new user message in it.”

---

## 12. Current fit against the intended product direction

If the target is:

- RemoteLab only accepts normalized inbound messages
- RemoteLab runs the local agent
- RemoteLab exposes normalized event/state back out
- connectors own all platform-specific wrapping and re-submission logic

then the shared admission/outbox implementation supports that direction without requiring a generic webhook layer.

It provides durable ingestion, thread-to-session mapping, idempotent submission, result/outbox atomicity, and independently recoverable publication. The sender polls durable work; WebSocket hints may optimize wake-ups but are never the reliability boundary. Adding a platform requires target validation and an adapter, not a new task runtime or a model-duration timeout.

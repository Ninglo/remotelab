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

## 1. What RemoteLab is responsible for

RemoteLab owns only the shared conversation/runtime layer:

- authenticate the caller
- create or reuse a session
- append a new user message into that session
- execute the selected local agent tool
- persist run state and normalized events on disk
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
| upstream actor metadata | message preface inside `text` | keep source-specific structure outside RemoteLab |
| local agent reply | assistant events in session history | connector decides how to render or deliver them |
| source-side follow-up | another message submission | same session, new `requestId` |

This is the main simplification:

> Even something non-chat-like, such as a GitHub issue comment, is still just a user message.

The connector can add a short preface such as actor, source, URL, or thread title, then pass the normalized text to RemoteLab.

---

## 3. Minimal connector loop

An external connector should follow this loop:

1. Authenticate to RemoteLab and obtain an owner session cookie.
2. Resolve or create the RemoteLab session for the external thread.
3. Submit the new inbound update as a user message.
4. Watch the resulting run until it reaches a terminal state.
5. Read normalized events from the session.
6. Decide how to publish the assistant reply back to the external platform.
7. When the external platform changes again, submit another message to the same session.

RemoteLab is therefore the **shared agent conversation engine**, while connectors stay as thin source adapters.

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
- visitor auth is for shared Apps, not for automation connectors

---

## 5. Session creation / reuse

Create a session with:

`POST /api/sessions`

Required fields:

- `folder` — must resolve to a real directory on disk; most connectors should use `~`
- `tool` — the local tool to run, such as `codex`

Useful optional fields for connectors:

- `name` — initial session title
- `group` — top-level grouping such as `Mail`, `GitHub`, `Bots`
- `description` — short human-facing description
- `systemPrompt` — source-specific guidance for this session
- `externalTriggerId` — stable dedupe key for the upstream thread

Example:

```bash
curl -sS \
  -b cookie.jar \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/sessions" \
  -d '{
    "folder": "~",
    "tool": "codex",
    "name": "GitHub: owner/repo#123",
    "group": "GitHub",
    "description": "External GitHub thread bridged into RemoteLab.",
    "externalTriggerId": "github:owner/repo#123"
  }'
```

Important behavior:

- if an unarchived session with the same `externalTriggerId` already exists, RemoteLab returns that session instead of creating a new one
- this is the main dedupe mechanism for “one external thread → one RemoteLab session”

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

- `202` means the new run was accepted
- `200` means the same `requestId` was already seen and the call was treated as a duplicate

This means connectors should treat `requestId` as the idempotency key for one upstream update.

---

## 7. Watching progress

After message submission, connectors have two supported ways to track progress.

### Option A — HTTP polling

Use the returned `run.id` and poll:

`GET /api/runs/:runId`

Current run states converge around:

- `accepted`
- `running`
- `completed`
- `failed`
- `cancelled`

This is the easiest path for non-interactive connectors.

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

RemoteLab returns raw normalized events. Connectors that want a single outbound reply should derive it on their side from those events. This repo ships a shared helper in `lib/reply-selection.mjs` for that purpose; it skips assistant-side artifacts such as Codex `todo_list` tails and can fall back past a trailing checklist-only message when an earlier substantive assistant reply exists in the same run.

---

## 9. Normalization rules for connectors

This part is the real protocol discipline.

### Required rules

- Use one stable `externalTriggerId` per upstream thread.
- Use one unique `requestId` per inbound upstream update.
- Treat every inbound upstream update as a **user message**.
- Put upstream metadata into the message body, not into RemoteLab-specific source branches.
- Keep source-specific rendering, approval rules, and publishing logic outside RemoteLab.

### Good message preface shape

This is a good generic template:

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

This keeps the core protocol uniform while still preserving upstream context.

---

## 10. What is shipped today vs not yet shipped

### Shipped today

- session creation over HTTP
- message submission over HTTP
- idempotency via `requestId`
- session dedupe via `externalTriggerId`
- run polling via HTTP
- incremental event reads via HTTP
- push-only WebSocket invalidation

### Not yet shipped as a general connector primitive

- a generic server-to-server webhook callback for run/session events
- a generic outbound message capability shared across email, IM, GitHub, and other reply surfaces
- a first-class “connector registry” or dedicated connector auth scope
- full model-writable session metadata beyond the currently exposed creation fields

There is already an email-specific completion-target path in the repo, but that is intentionally **not** the long-term generic connector contract.

---

## 11. Recommended integration stance right now

If you are integrating another tool today, the most stable approach is:

1. keep your source wrapper outside RemoteLab
2. authenticate as the owner
3. create or reuse one session per upstream thread
4. submit each inbound update as a new user message
5. poll `/api/runs/:id` or combine `/ws` invalidation with HTTP reads
6. read assistant message events and publish them however your source platform wants

This already covers most automation surfaces, including non-standard ones like GitHub issues, because the protocol only assumes one thing:

> an upstream system can always be reduced to “there is a thread, and there is a new user message in it.”

---

## 12. Current fit against the intended product direction

If the target is:

- RemoteLab only accepts normalized inbound messages
- RemoteLab runs the local agent
- RemoteLab exposes normalized event/state back out
- connectors own all platform-specific wrapping and re-submission logic

then the current implementation is **mostly aligned**, but not fully complete.

It is already sufficient for:

- standard inbound message ingestion
- thread-to-session mapping
- idempotent update submission
- reading normalized results back out

It is not yet sufficient for a fully generic “push events back to arbitrary external systems” story, because the shipped push surface is still only authenticated WebSocket invalidation, not a generic callback/webhook layer.

So the current implementation is a good **message ingress protocol**, but not yet the full **connector callback protocol**.

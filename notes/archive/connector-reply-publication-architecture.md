# Connector Reply Publication Architecture

Status: proposal draft as of 2026-04-11

Companions:

- `notes/current/connector-state-surface.md`
- `notes/current/instance-scoped-connectors.md`
- `docs/connector-plugin-protocol.md`
- `chat/session-turn-completion.mjs`
- `scripts/wechat-connector.mjs`
- `scripts/feishu-connector.mjs`
- `scripts/voice-connector-remotelab.mjs`
- `chat/router-connector-routes.mjs`

## Why this note exists

- RemoteLab now has a real cross-connector bug: several thin connectors publish a reply when the first run reaches `completed`, even though reply self-check and automatic continuation may still be deciding the final user-visible answer.
- The bug is architectural, not connector-specific. WeChat shows it clearly, but Feishu, Voice, Shortcut reply waits, and the old connector callback protocol all currently rely on the same missing contract.
- This is a stable product surface. The right response is a shared durable contract, not another connector-local timing patch.

## Core judgment

RemoteLab should separate three lifecycles that are currently mixed together:

1. `run lifecycle`
   what the model/tool execution is doing
2. `response lifecycle`
   whether the current user turn has reached a stable publishable answer
3. `delivery lifecycle`
   whether that stable answer was sent through email / WeChat / Feishu / Shortcut / other connectors

`session` is the long-lived conversation.

The thing that external connectors need is not "session is idle" and not "run is completed".

The thing they need is:

> this user turn now has a final publishable response payload

## Principles

### 1. Stable connector surfaces should prefer shared contracts over remember-later patches

If a bug appears on a stable architecture boundary and is likely to recur, fix the boundary once in shared code instead of patching one connector and relying on future operator memory.

### 2. Run completion is not reply publication

`run.state === completed` only means one execution pass finished.

It does not mean:

- reply self-check has accepted the answer
- auto-continuation is no longer possible
- the final user-visible payload has been selected
- external delivery should begin

### 3. Session activity should stay execution-truthful

We should not keep the whole session or run marked as `running` just to delay connector delivery.

The current self-check design intentionally lets the session become idle during background review so new work can arrive and preempt automatic continuation. That behavior is worth preserving.

So the fix should add a new response/publication layer, not overload `activeRunId` or session running state.

### 4. Every accepted user message needs a stable response identity

Today connectors often track a turn by `runId` or `requestId`.
That breaks in at least three cases:

- queued follow-ups may not have a run immediately
- reply self-repair launches a new internal run with a new internal `requestId`
- final externally visible output may span more than one assistant event

The system needs a first-class `responseId` created when the user message is accepted.

### 5. Post-run automation must inherit the same response identity

Anything that still belongs to the same user-visible reply must stay attached to the same `responseId`:

- initial run
- reply self-check review
- reply self-repair run
- result-asset publication for that turn
- source-channel reply push
- completion targets that are logically "send the answer for this turn"

### 6. Final reply payload selection belongs on the server side

Thin connectors should not inspect raw session events and guess:

- which assistant event is the right one
- whether a continuation might still happen
- how multiple visible assistant events should collapse for delivery

The server should expose a canonical publication payload and make connector code consume that.

### 7. Response finalization must survive queueing and restart

RemoteLab already resumes pending connector completion targets on startup.
The response-publication layer should get the same treatment.

Otherwise a crash or restart between run completion and reply finalization will still leave connectors in an ambiguous state.

## Current architectural breakpoints

### WeChat

`scripts/wechat-connector.mjs` waits for `/api/runs/:id` to hit `completed`, then scans session events by `runId` or `requestId`.

This can publish before self-check settles, and it cannot reliably follow a repair run that gets a new internal `requestId`.

### Feishu

`scripts/feishu-connector.mjs` has already accumulated extra logic for queued follow-ups:

- wait for the session to become ready
- submit message
- if queued, scan events to find the eventual run by request/source context
- wait for run completion
- scan assistant events

That is exactly the kind of connector-local state recovery the shared contract should eliminate.

### Voice

`scripts/voice-connector-remotelab.mjs` repeats the same `waitForRunCompletion + loadAssistantReply` pattern as WeChat.

### Shortcut reply wait

`chat/router-connector-routes.mjs` still waits on a run and resolves a reply from raw events. It has the same missing publication boundary.

### Connector callback protocol

`docs/connector-plugin-protocol.md` currently says reply push happens when the AI reply is completed, but it never defines what "completed" means once reply self-check / continuation exists.

## Proposed first-class object

Introduce a durable per-turn object:

- internal name can be `response`
- outward-facing API can expose a `replyPublication` facet if we want the naming to stay explicit

The important part is the shape, not the final field name.

### Minimum fields

- `id`
- `sessionId`
- `initialRequestId`
- `externalTriggerId`
- `sourceContext`
- `rootUserEventSeq`
- `rootRunId`
- `finalRunId`
- `continuationRunIds`
- `state`
- `resolution`
- `createdAt`
- `readyAt`
- `failedAt`
- `payload`

### State

Suggested non-terminal states:

- `accepted`
- `queued`
- `running`
- `reviewing`
- `continuing`

Suggested terminal states:

- `ready`
- `failed`
- `cancelled`

### Resolution

Keep the terminal reason separate from lifecycle state.

Suggested values:

- `accepted_as_is`
- `auto_continued`
- `accepted_after_interruption`
- `fallback_original_after_continue_failure`
- `failed_without_publishable_reply`

This keeps `state` small while preserving product meaning.

## Publication payload

The response object should expose a canonical outbound payload.

### Required output

- `payload.text`
- `payload.attachments`
- `payload.displayEvents`

### Why keep `displayEvents`

Some channels want a single collapsed text body.
Some channels are better served by sequential segments.
Some future channels may need richer formatting.

So the server should compute one canonical visible reply representation and also provide a convenience plain-text collapse.

### Important rule

How multiple assistant events collapse into the final external payload is a server concern, not a connector concern.

That lets us improve publication quality later without rewriting every connector.

## API proposal

### Submit message

`POST /api/sessions/:id/messages`

Return:

- `run`
- `queued`
- `duplicate`
- `response: { id, state }`

Even if the message is queued and no run exists yet, the caller still gets a stable `response.id`.

### Fetch response state

Either:

- `GET /api/responses/:responseId`

or session-scoped:

- `GET /api/sessions/:id/responses/:responseId`

Return:

- lifecycle state
- resolution
- ids for root/final runs
- canonical payload when ready

### Run projection

`GET /api/runs/:id` should include a compact response summary:

- `response.id`
- `response.state`
- `response.ready`

That keeps existing polling clients easy to migrate.

## Internal propagation rules

### Message acceptance

When `submitHttpMessage()` accepts a user message, create a `responseId` immediately.

Attach it to:

- the user event
- the run status
- the run manifest
- any initial source-context snapshot

### Reply self-check review

The hidden review does not create a new response.
It updates the same response from `running` to `reviewing`.

### Reply self-repair run

The repair run gets:

- its own internal `requestId`
- the same `responseId`
- a link to the root response

That keeps execution idempotency and usage accounting separate from reply publication identity.

### Result assets

If result-file publication belongs to the same user turn, attach those asset events to the same response.

### Completion targets

Connector completion targets that mean "deliver the answer for this turn" should bind to `responseId`, not only `requestId`.

Backward-compatible fallback:

- keep accepting `requestId`
- internally resolve it to the owning `responseId`

## Shared helper direction

### Server-side helper

Introduce a shared module, for example:

- `chat/response-publication.mjs`

Responsibilities:

- create/update/load response records
- compute lifecycle state
- attach repair runs to existing responses
- build canonical outbound payload
- resume pending finalizations on startup

### Connector-side helper

Thin connectors should stop open-coding:

- wait for queued run discovery
- wait for run completion
- scan session events for the "right" assistant reply

Replace that with one shared client helper, for example:

- `lib/connector-response-client.mjs`

Responsibilities:

- submit a source turn
- wait for response readiness
- fetch final publication payload

## Startup / recovery requirement

Add a response-finalization recovery step similar to the existing pending-completion-target resume path.

Target behavior after restart:

- if a response was already `ready`, delivery can resume
- if a response was `reviewing` or `continuing`, RemoteLab can deterministically resume or re-evaluate it
- connectors never need to infer publication state from partially written history alone

## Migration path

### Phase 1

- add `responseId`
- project response summary into message submit response and run API
- keep old connector code working

### Phase 2

- migrate WeChat
- migrate Feishu
- migrate Voice
- migrate Shortcut wait path
- migrate old connector reply push path

### Phase 3

- switch source-channel delivery and reply email completion targets to `responseId`
- keep `requestId` matching only as legacy compatibility

### Phase 4

- optionally expose response/publication state in the UI and transcript diagnostics

## What not to do

### Do not solve this by keeping the session artificially running

That would mix execution truth with publication truth and would make interruption/new-work behavior worse.

### Do not make each connector understand self-check

That duplicates product logic and guarantees drift.

### Do not rely on raw event heuristics as the contract

Raw history is a source of truth, but it is not the right API contract for thin connectors.

## Working definition of success

After this lands, every thin connector should be able to follow one simple rule:

1. submit message
2. get `responseId`
3. wait until `response.state` is terminal
4. if `response.state === ready`, deliver `response.payload`
5. never inspect raw events to guess whether the reply is final

That is the architectural boundary this bug is asking for.

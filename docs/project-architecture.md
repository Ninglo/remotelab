# RemoteLab Project Architecture

This document describes the shipped `v1` architecture. Historical proposals in
`notes/` are useful context, but they do not override this contract.

## Optional hardware recording

`remotelab recording` provides instance-local keypad control and multi-receiver PCM capture on macOS/Linux. Each source is a receiver identity plus its channel, with an independent recording lifetime. `lib/recording/` owns private segmented WAV files, recovery, a local control socket, bounded submission retries and a user service; the included Swift/evdev helpers read only configured keypad events. The component ships disabled and uses the existing asset upload and Session message API, without adding a read/write execution capability to the read-only local-helper bridge. It records analysis admission as `submitted`, leaving Run completion and conversation delivery with the normal control plane. See [activation and host acceptance](platform-skills/hardware-recording.md).

## Product model

RemoteLab has one interactive work object: the **Session**.

- An **Instance** is the deployment and data-isolation boundary.
- A **Person** is a human profile used for attribution and UI preferences. Sign-in methods are attached separately.
- An **Identity** is one way a Person appears: a web credential, a Feishu sender,
  another connector sender, or the system identity.
- A **Session** is a durable shared work thread.
- A **Run** is one execution attempt inside a Session.
- A **ShareSnapshot** is an immutable, unauthenticated, read-only publication.

There is no interactive Agent/template object and no Visitor role. Unauthenticated
requests cannot enter the workbench. Every authenticated Person has full access to
every Session and control surface in the instance.

Identity is deliberately not an authorization boundary. It supports:

- attribution: who initiated a Session or turn;
- frontend filtering: All, Mine, a specific Person, System, or Unassigned;
- personal organization: Space, Group, and sidebar order.

It must never prevent one authenticated Person from viewing, opening, modifying,
continuing, archiving, or otherwise operating another Person's Session.

## Shared state and personal views

The Session is the shared truth. These fields are global:

- title and description;
- transcript and attachments;
- selected runtime and provider continuation IDs;
- active/queued Run state;
- workflow state, priority, lifecycle, archive/pin state;
- connector bindings and delivery state;
- work summary and agreements.

Organization is a projection for one Person:

```json
{
  "personViews": {
    "person_alice": {
      "space": "Product",
      "group": "RemoteLab",
      "sidebarOrder": 120
    },
    "person_bob": {
      "space": "Operations",
      "group": "This week",
      "sidebarOrder": 20
    }
  }
}
```

The same Session may therefore appear in different Spaces, Groups, and positions
for different People. The HTTP Session list/detail routes project the requesting
Person's view onto `space`, `group`, and `sidebarOrder`; callers do not need to
interpret the raw view map.

The post-turn Session classifier preserves this boundary. Shared suggestions such
as title, description, workflow state, and work summary update the Session itself.
Space and Group suggestions update only the Person whose turn triggered the run.
The manual **Sort List** flow follows the same rule.

## Authentication and identity

`auth.json` is a versioned document managed by `lib/auth-config.mjs`. It stores:

- `people`: display profiles with one readable `handle` each;
- `credentials`: web token/password records mapped to a Person and web identity;
- `identities`: web, connector, and system identities mapped to People when appropriate;
- `serviceToken`: machine-to-machine authentication for local connectors and workers.

Browser authentication creates an entry in `auth-sessions.json` containing the
resolved `personId` and `identityId`. `/api/auth/me` returns the current Person.
Settings keeps the current Person's default filter under **My view**, while the People
directory shows compact profile summaries and expands credentials or resolved identities
only on demand. System attribution is not presented as a manageable Person. A Person may
be created without immediately issuing a token or password; sign-in methods are attached
separately afterward.

External connector senders are discovered on admission. For Feishu, the durable
provider identity is scoped by connector route/application and prefers the sender's
`openId`. The connector performs a cached, fail-open profile lookup so the server can
derive a readable pinyin-style handle. Matching is automatic in this order: an
existing provider identity, an exact handle/Web username, the same stable proposed
handle across connector routes, then one unambiguous display-name match. If nothing
matches, the server creates a discovered Person with a short stable suffix such as
`jiujianian-a31f`. A later enriched message or a Web Person created with that handle
automatically coalesces the records. Coalescing also transfers the discovered
Person's Session views; target-Person values win when both sides already classify
the same Session field. The manual identity endpoint remains only as a repair path
for ambiguous or incorrect upstream directory data.

The service token authenticates connector processes; the sender carried in
`sourceContext` determines human attribution. If no human sender exists, the
system identity is used.

## Runtime topology

```text
Browser / connector
        |
        v
chat-server.mjs (:7690)
  |-- HTTP canonical reads and mutations
  |-- authenticated Person/Identity resolution
  |-- Session and Request admission
  |-- thin WebSocket invalidation hints
  |-- durable history, Run, delivery, and metadata stores
        |
        v
detached runner -> raw spool/status/result -> normalized Session events
```

`chat-server.mjs` is the single shipped chat/control plane. HTTP is canonical;
WebSocket only announces that clients should refetch. Detached execution survives
control-plane restarts through durable Request/Run state and reconciliation.

## Execution ownership and asynchronous progress

Runs use `storageVersion: 2`. Their files have separate writers:

| File | Owner and meaning |
| --- | --- |
| `status.json` | Controller: admission, launch metadata, cancellation intent, normalized-output checkpoint and finalization |
| `execution.json` | Detached runner: actual process state, provider continuation, usage and terminal execution facts |
| `result.json` | Actual result, written by the runner (or by the controller when execution was rejected before launch) |
| `recovery.json`, `recovery-result.json` | Controller inference from confirmed process loss or a legacy adapter completion marker; a real terminal execution/result takes precedence |
| `spool.jsonl` | Append-only execution output; a partial final line is retained for the next read rather than consumed |

Writers persist only their changed fields. Reads combine the files and preserve
controller-owned cancellation and projection checkpoints. An explicit controller
validation failure (for example, a structured runtime exiting without output)
remains a failed outcome even if the process exited successfully. A cancel intent
is distinct from a cancelled execution: an already completed execution can still
have a later cancel request recorded without changing its result.

There is one writer protocol; the old shared-status mutation lock and old state
merge rules have been removed. Completed historical Runs remain readable through
the same read model: absent execution/recovery files contribute no fields. No
historical rewrite or Request-schema conversion is required.

Before deploying this retirement to an existing instance, verify that every
pre-version-2 runner and its tool process have exited. Let them finish, or, when
maintenance interruption is authorized, cancel the exact old Run through the
control API and resume the unfinished task in the same Session after deployment.
Retain its provider conversation and durable evidence; the resumed task must
check existing jobs and uncertain action results before issuing new work. An old
runner still writes `status.json`; loading the new controller while it is alive
would violate ownership. This is a deployment prerequisite, not a runtime fallback.
Rollback revisions must understand the split execution/recovery files; never
restore an old data backup over newly admitted work.

`request-runtime.mjs` owns request advancement. Admission, release and output
notifications wake it; a single 30-second active-request recovery sweep covers
missed notifications and crashed processes. Per-Run 250ms polling is removed.
The sweep does not read storage when no requests remain. Connector inboxes wake
on admission/completion and arm a timer for the earliest retry instead of scanning
once per second. Terminal automation scripts persist their retry deadline and
retry on that deadline or boot recovery, independently of readers.

Session, history and Run queries do not perform execution reconciliation.
The Run API keeps an exited but unfinalized Request in `running` with
`finalizing: true` and its raw `executionState`, until output validation finishes;
it does not expose a provisional success that could later become a failure.
Metadata normalization is an in-memory projection and persists on an explicit
mutation; it does not overwrite a missing configured working directory during
reads. The runner resolves an unavailable directory asynchronously at launch.

Queue removal competes with the scheduler's durable execution claim. It does not
wait for a slow preparation; a claimed head rejects a stale removal immediately.
A native supplement prepared after its Request was withdrawn is never dispatched.
Cancellation is recorded before waiting for preparation and is rechecked before
launch. Unrelated Sessions can progress independently.

A Request's execution slot is released before cooperation effects. Both root and
native supplemental Requests retain `postCompletionPending` and per-effect
`completionEffects` receipts. Independent effects start independently; a failed
effect retains its error/retry deadline, and successful effects are skipped on
recovery. External effects must still be idempotent across the crash window between
an external write and saving its receipt. Memory review remains independently
scheduled rather than blocking the foreground result.

Feishu question-card network writes are ordered only for the same card. Answer
reservation uses a short per-card state mutation; HTTP submission occurs outside
it and duplicate submissions share the same pending operation. Document read
pacing governs request starts, not completion order. Delivery claims reuse one
Session metadata snapshot per scan; the existing durable outbox, lease and
unknown-outcome fences remain authoritative.

Execution-plan commands commit their decisions before child creation and
submission. Per-plan advancement preserves ordering without occupying the command
queue; stop intents remain writable during a slow child creation and are checked
again before submission and after admission.

Validation includes `tests/test-core-async-boundaries.mjs`, queue removal, native
question surfaces, execution plans, the connector recovery suite and native
Harness integration. The scenarios cover slow-operation isolation, late
preparation, independent completion/restart, cross-process state ownership,
late real results, partial spool records, read-only queries and stop/create races.

## Core files

### Identity and authentication

- `lib/auth-config.mjs` — auth document schema, migration, People, credentials,
  identities, and service-token helpers.
- `lib/auth.mjs` — login verification and authenticated browser sessions.
- `chat/router-public-routes.mjs` — login/logout and ShareSnapshot routes.
- `chat/router-control-routes.mjs` — People/sign-in management APIs.

### Sessions and personal views

- `chat/session-manager.mjs` — Session lifecycle, message admission, Runs, forks,
  delegation, and projection.
- `chat/session-meta-store.mjs` — durable Session metadata normalization.
- `chat/session-person-view.mjs` — normalization, projection, and mutation of
  per-Person Space/Group/sidebar-order state.
- `chat/session-state-classifier.mjs` — post-turn classification request.
- `chat/session-turn-completion.mjs` — applies shared and per-Person classifier
  results using the Run's `viewPersonId`.
- `chat/session-label-context.mjs` — projects the requesting Person's hierarchy
  into the classification prompt.
- `chat/router-session-main-routes.mjs` — Session list/detail/create/message
  routes and initiator resolution.

### Durable execution

- `chat/requests.mjs` and `chat/request-runtime.mjs` — durable admission and ordered execution.
- `chat/runs.mjs` — Run manifests and terminal outcomes.
- `chat/run-launcher.mjs` and `chat/runner-sidecar.mjs` — detached execution.
- `chat/run-projection.mjs` — native output to normalized events.
- `chat/run-reconciler.mjs` — recovery and missing-result settlement.
- `chat/history.mjs` — canonical append-only Session history.
- `chat/work-awareness.mjs` — bounded work, input and reference-suggestion
  records within Session metadata; symmetric non-exclusive overlap queries.
- `chat/necessary-background.mjs` and `chat/related-person-context.mjs` —
  task-relevant original sources, read coverage and independently attributed
  people. See [Session work awareness](session-work-awareness.md).

### Frontend

- `templates/chat.html` — application shell, Person filter, and Settings panels.
- `static/chat/bootstrap.js` — authenticated Person and People directory state.
- `static/chat/session-store.js` — client Session store and active Person filter.
- `docs/frontend-chat-architecture.md` — frontend state ownership and rendering boundary.
- `static/chat/bootstrap-session-catalog.js` — composition of Person, origin,
  Space, search, and archive filters.
- `static/chat/settings-ui.js` — People, handle, credential, resolved-identity, and default
  filter management.
- `static/chat/session-list-ui.js` and `static/chat/sidebar-ui.js` — rendering of
  the current Person's projected view.
- `static/chat/realtime.js` — invalidation handling; no canonical state ownership.

### Connectors

- `connectors/feishu/index.mjs` and `scripts/feishu-connector.mjs` — Feishu
  ingestion, sender attribution, binding, and delivery.
- `scripts/wechat-connector.mjs` — WeChat ingestion and delivery.
- `scripts/agent-mail-worker.mjs` — mailbox ingestion and delivery. “Agent
  Mailbox” is the mailbox subsystem's proper name, not an interactive product object.
- `chat/source-deliveries.mjs` — durable connector outbox.

## API shape

Important authenticated routes include:

- `GET /api/auth/me`
- `GET|POST /api/people`
- `PATCH /api/people/:id`
- `POST /api/people/:id/credentials`
- `DELETE /api/people/:id/credentials/:credentialId`
- `POST /api/people/:id/identities`
- `POST /api/people/reconcile-external-identity` (connector service only)
- `GET|POST /api/sessions`
- `GET|PATCH /api/sessions/:id`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/fork`
- `GET /api/work-awareness`, `GET|POST /api/work-awareness/people`
- `POST /api/work-awareness/start|update|suggest` (Run-attributed records;
  human publication/adoption remains explicit chat input, not an approval API)

All authenticated routes operate against the complete instance Session set. The
Person filter is a client-side convenience over attribution metadata, not a
server-side visibility predicate.

Public routes are limited to login/install/static assets and immutable
ShareSnapshots. A ShareSnapshot never grants access to its source Session.

## Persistence

Runtime state lives in `~/.config/remotelab/`:

| Path | Purpose |
|---|---|
| `auth.json` | People, credentials, identities, service token |
| `auth-sessions.json` | browser login sessions |
| `chat-sessions.json` | Session metadata, including `personViews` |
| `chat-history/` | canonical per-Session event history |
| `chat-runs/` | Run manifests, spool, and results |
| `chat-requests/` | durable admission and execution state |
| `shared-snapshots/` | immutable read-only publications |
| `public-pages/` | instance-local static publications |

Instance roots can override config, memory, and workspace locations. Do not use
Session labels or Person records as a substitute for a separate instance when a
real deployment/data isolation boundary is required.

## Invariants

1. Session is the only interactive product work object.
2. Authentication is binary: full instance access or no workbench access.
3. Person/Identity metadata never narrows Session visibility.
4. Space, Group, and sidebar order are always per-Person view state.
5. Shared Session state cannot be silently copied into a personal view or vice versa.
6. HTTP is canonical; WebSocket is invalidation only.
7. Durable state must survive browser and control-plane restarts.
8. ShareSnapshot is immutable and read-only.
9. Connector service authentication and human sender attribution are separate.
10. Tests that touch state use isolated config, memory, workspace, and provider homes.

## Validation

For a change touching this architecture, exercise at least:

- two authenticated People can list and mutate the same Session;
- each Person can independently classify/order that Session;
- filtering by Person changes convenience views only;
- a Feishu sender becomes a filterable external identity/Person;
- anonymous workbench routes reject access;
- ShareSnapshot remains readable and immutable;
- restart-gate, smoke, integration, and trigger suites remain green.

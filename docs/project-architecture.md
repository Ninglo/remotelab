# RemoteLab Project Architecture

This document describes the shipped `v1` architecture. Historical proposals in
`notes/` are useful context, but they do not override this contract.

## Product model

RemoteLab has one interactive work object: the **Session**.

- An **Instance** is the deployment and data-isolation boundary.
- A **Person** is an authenticated human profile used for attribution and UI preferences.
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

- `people`: display profiles;
- `credentials`: web token/password records mapped to a Person and web identity;
- `identities`: web, connector, and system identities mapped to People when appropriate;
- `serviceToken`: machine-to-machine authentication for local connectors and workers.

Browser authentication creates an entry in `auth-sessions.json` containing the
resolved `personId` and `identityId`. `/api/auth/me` returns the current Person.
Settings exposes People, credentials, identity merging, and the default Person filter.

External connector senders are discovered on admission. For Feishu, the stable
identity key is scoped by connector route/application and prefers the sender's
`openId`. A discovered identity initially gets its own Person so it can be filtered
immediately. Settings can merge that identity into an existing Person later.

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

### Frontend

- `templates/chat.html` — application shell, Person filter, and Settings panels.
- `static/chat/bootstrap.js` — authenticated Person and People directory state.
- `static/chat/session-store.js` — client Session store and active Person filter.
- `docs/frontend-chat-architecture.md` — frontend state ownership and rendering boundary.
- `static/chat/bootstrap-session-catalog.js` — composition of Person, origin,
  Space, search, and archive filters.
- `static/chat/settings-ui.js` — People, credential, identity-merge, and default
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
- `GET|POST /api/sessions`
- `GET|PATCH /api/sessions/:id`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/fork`

All authenticated routes operate against the complete instance Session set. The
Person filter is a client-side convenience over attribution metadata, not a
server-side visibility predicate.

Public routes are limited to login/install/static assets and immutable
ShareSnapshots. A ShareSnapshot never grants access to its source Session.

## Persistence

Default runtime state lives in `~/.config/remotelab/`:

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

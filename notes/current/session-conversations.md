# Session conversations

Status: implemented and verified in isolated tests, 2026-09-14. Deployment acceptance is tracked separately.

## Contract

A Session optionally binds one external conversation. Incoming external messages enter that Session; all user-visible replies from it use the binding, including browser and scheduled input. Internal maintenance output is not a user-visible conversation reply. A true fork does not inherit the parent binding.

A schedule creates an ordinary Session by default. Its optional conversation is part of the creation template: a group destination creates a fresh topic on first publication; an existing topic resolves to its bound Session. Repeated schedule occurrences in a group each get their own Session/topic. No recording or report semantics belong in routing.

Feishu group settings override connector defaults for response mode and optional Session instructions. The recording group uses all human messages, with existing sender, access, mute and command handling. No file-only trigger mode.

## Ownership and consolidation

- Shared pure conversation target normalization defines connector route and external address once.
- Session metadata owns the persistent binding. Connector message indexes are reverse lookup/migration records, not an alternative output policy.
- Requests retain immutable delivery snapshots and the existing durable outbox/receipts. This preserves retries and native-turn coalescing; it does not define another user-facing binding.
- Feishu receipt handling refines a newly created group destination to its actual topic/root and persists that before acknowledging publication.
- Scheduled template normalization and construction are shared by recurring schedules and one-time triggers. Legacy sourceDelivery input is translated at this boundary.
- Existing per-request sourceDelivery remains an ingress compatibility surface for unbound callers. Bound Session replies have one canonical destination.

## Verification

Use fake Harnesses and mocked Feishu sends with isolated instance state. Cover two independent scheduled occurrences, same-topic continuation, browser input, restart, duplicate delivery acknowledgements, pending replies before topic creation, native active input, foreign route isolation, failed sends, ordinary Sessions, true forks and optional per-group instructions. Production acceptance is separate from passing code tests.

## Configuration and code map

The external address has one shape:

```json
{"connector":"feishu","sourceRouteId":"bot-2","target":{"chatId":"oc_example"}}
```

A group-only address requests a new conversation. An existing root address also
includes `rootId`, `messageId` and `replyInThread: true`. Session creation
atomically resolves existing bindings; group-only requests remain independent.
No `new/reuse`, recording predicate, result-to-session routing map or custom
schedule reply transport is needed.

Long-running monitoring should use the existing group-only form when it needs
an independent Home Session and connector topic. `--conversation source` and
`--source-request` are continuation forms: they intentionally select the source
topic and may therefore reuse its bound Session. Individual monitor attempts
stay internal to the Home Session instead of creating one topic per check.

| Responsibility | Module |
| --- | --- |
| Pure address normalization and identity | `lib/conversation-target.mjs` |
| Canonical metadata binding and receipt refinement | `chat/session-conversations.mjs` |
| Runtime admission and reply snapshot | `chat/session-manager.mjs`, `chat/requests.mjs` |
| Pure reply-to-delivery conversion, including offline upgrades | `lib/reply-deliveries.mjs` |
| Durable sending, ordering and receipts | `chat/source-deliveries.mjs` |
| Shared timer creation template and CLI option | `lib/scheduled-session.mjs`, `lib/scheduled-conversation-command.mjs` |
| Group defaults and overrides | `connectors/feishu/group-settings.mjs` |
| Feishu normalization and legacy index adoption | `connectors/feishu/session-flow.mjs`, `scripts/feishu-connector.mjs` |

## Compatibility

Old schedules/triggers read `sourceDelivery` into `sessionTemplate.conversation`.
New writes retain the template only. No historical result is re-sent. New CLI
creation defaults to an ordinary Session; `--conversation source` explicitly
inherits an existing source, and JSON/file options specify a different target.

Old request-scoped integrations and prepared inbox submissions remain readable.
A timer whose request was already accepted before an upgrade uses that durable
acceptance to finish recovery; it does not rebuild its old submission options
or run the task a second time.
New Feishu intake binds once at Session creation and submits normal messages.
The core resolves canonical bindings before consulting the old thread index.
Adoption is lazy on the next incoming message; old unbound Sessions do not
acquire a browser reply destination merely from having historical source
metadata. Explicit detach/fork transfer leaves a null tombstone so old indexes
cannot undo it. Ordinary history forks remain independent.

Delivery snapshots keep accepted work stable through retries. The first receipt
may refine a group destination to its newly created topic. A delayed receipt
cannot restore an explicitly detached or transferred binding. Operator recovery
of an uncertain new-topic send requires the actual message ID. It never guesses
a root or repeats an ambiguous send automatically.

## Acceptance evidence

Isolated fake-Harness HTTP scenarios verified ordinary and bound Sessions,
route/tenant identity, browser-origin replies, archived continuation, explicit
fork replay/transfer, independent true forks, first-root publication, pending
parts, cold server restart and continuation without connector-local indexes.
Native Harness tests verified a coalesced turn publishes once. Timer tests
verified new-topic occurrences, anchored continuation, visibility and execution
links. Existing offline upgrade, connector and restart suites remain required.
No real audio or external send is claimed by these tests.

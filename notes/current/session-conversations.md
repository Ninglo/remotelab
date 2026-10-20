# Session conversations

Status: current contract, revised 2026-10-20. Deployment acceptance is tracked separately.

## Contract

A Session optionally binds one external conversation. Incoming external
messages enter that Session. Browser and scheduled input use the binding;
connector input may snapshot its current reply anchor inside the same bound
scope. Internal maintenance output is not a user-visible conversation reply. A
true fork does not inherit the parent binding.

A schedule creates an ordinary Session by default. Its optional conversation is part of the creation template: a group destination creates a fresh topic on first publication; an existing topic resolves to its bound Session. Repeated schedule occurrences in a group each get their own Session/topic. No recording or report semantics belong in routing.

Feishu group settings override connector defaults for response mode and optional Session instructions. The recording group uses all human messages, with existing sender, access, mute and command handling. No file-only trigger mode.

## Ownership and consolidation

- Shared pure conversation target normalization defines connector route and external address once.
- Session metadata owns the persistent binding. Connector message indexes are reverse lookup/migration records, not an alternative output policy.
- Requests retain immutable delivery snapshots and the existing durable outbox/receipts. A request snapshot may select a current Feishu root/topic inside the Session's connector, route, tenant and chat without changing the Session binding.
- Feishu receipt handling refines a newly created group destination to its actual topic/root and persists that before acknowledging publication.
- Scheduled template normalization and construction are shared by recurring schedules and one-time triggers. Legacy sourceDelivery input is translated at this boundary.
- Per-request `sourceDelivery` is the reply authority for that request. Bound Sessions provide the default and constrain explicit snapshots so they cannot cross transport scopes.

## Creation, continuation and silence

This is the canonical decision contract, subordinate to the object definitions in
[Core domain contract](core-domain-contract.md). Feishu setup and API documentation
map these rules to provider fields and calls; they do not maintain separate policy.

1. An exact external conversation has one stable owning Session within its
   connector, Bot/route, tenant and chat scope. Root and provider thread IDs are
   aliases of that conversation. Resolve the binding before creation, including
   group mainlines, private chats and topics. Atomic creation resolves concurrent
   first messages to the same Session. Configuration changes and onboarding
   cannot replace an existing binding.
2. Follow-ups, corrections and added work in an existing topic continue its
   Session. Run completion, archive state, model changes, compaction and restart
   do not create a new Session. Running work uses native input or queueing;
   stopped work starts a later execution in the same Session.
3. Create an independent Session for an explicit new-topic request or work that
   needs its own durable context and continuation. Tool use, input length and
   execution duration alone do not justify splitting. A group mainline has a
   stable Session whose Harness may answer inline, remain silent or explicitly
   create a bound work topic. No second semantic dispatcher is required.
4. Handoff preserves the actual accepted inputs, attachments, attribution and
   necessary context. The destination owns work and replies after successful
   transfer; the origin retains provenance and the handoff receipt. References,
   similar titles and copied text alone do not transfer ownership.
5. A published interactive topic must resolve back to the Session producing it.
   Scheduled and background results follow the same binding/receipt path as
   interactive work. Publication receipt refinement precedes acknowledgement.
6. Silence is a normal response decision, not a failed admission. Participation
   controls can record without executing or stop reception. Errors retain the
   original Request and destination; recovery cannot silently fork work or
   reinterpret a failure as deliberate silence.

| Input or event | Session outcome |
| --- | --- |
| Supplement or correction in a bound topic | Continue its Session |
| Follow-up after completion, restart or runtime change | Continue its Session |
| Explicit independent new topic | Create and bind a new Session |
| Independent work received on the group mainline | Harness explicitly creates a work Session/topic |
| Local mainline question | Continue the mainline Session |
| Reply to a scheduled/background result | Continue the producing Session |
| Explicit continuation of uniquely identified old work | Continue under the verified target and applicable authorization |
| Ordinary human discussion needing no contribution | Record/execute only as allowed; a silent response need not create a Session |
| Duplicate event or uncertain transport receipt | Recover the original preparation/Request; no new work identity |

Native topic groups address every human input to the topic's Agent. Ordinary
groups retain their configured participation boundary. This difference governs
participation, not the meaning or lifetime of Session identity.

## Single admission and optional feedback

The connector resolves a Session, prepares the immutable payload and reply
destination, and persists that preparation before submitting it. A retry uses
that Session, body and execution/observation mode. It does not parse runtime
commands again or rebuild ownership from changed settings.

Active inputs go directly to Request admission. Optional social feedback uses
`acceptedRequestId` to project an already admitted Request; it never appends a
second human input or performs another conversation-binding admission. Queued and
archived Requests remain valid sources. Feedback read, classification, decision
storage and provider failures cannot reject the main input.

Listening inputs use the same preparation/resolution path in observation mode,
preserving attachments without starting a Harness. Invitations are decided from
explicit participation controls before selecting the mode. Old prepared inputs
retain their accepted packet contract.

## Verification

Use fake Harnesses and mocked Feishu sends with isolated instance state. Cover two independent scheduled occurrences, same-topic continuation, browser input, restart, duplicate delivery acknowledgements, pending replies before topic creation, native active input, foreign route isolation, failed sends, ordinary Sessions, true forks and optional per-group instructions. Production acceptance is separate from passing code tests.

Contract regressions must cover concurrent first input, post-completion and cold
restart continuation, mainline reuse after configuration changes, original
attachments through handoff, optional feedback failure, queued Request feedback
without a duplicate history event, listening invitations, frozen retry packets
and rejection/delivery recovery. See `test-feishu-thread-session.mjs`,
`test-feishu-ingress-dispatch.mjs`, `test-feishu-accepted-feedback.mjs`,
`test-feishu-participation-recovery.mjs` and `test-http-session-source-delivery.mjs`.

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
| Accepted-input feedback projection and listening records | `chat/session-observations.mjs` |

## Compatibility

Old schedules/triggers read `sourceDelivery` into `sessionTemplate.conversation`.
New writes retain the template only. No historical result is re-sent. New CLI
creation defaults to an ordinary Session; `--conversation source` explicitly
inherits an existing source, and JSON/file options specify a different target.

Old request-scoped integrations and prepared inbox submissions remain readable.
A timer whose request was already accepted before an upgrade uses that durable
acceptance to finish recovery; it does not rebuild its old submission options
or run the task a second time.
New Feishu intake binds at Session creation and submits every message with its
own reply snapshot. That snapshot preserves the selected conversation mode:
group `continue` stays unthreaded, while `fork` and bound thread follow-ups stay
threaded.
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

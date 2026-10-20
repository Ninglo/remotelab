# Core Domain Contract

Status: current baseline, revised 2026-10-20.

This is the canonical product-object contract. The conversation creation and
continuation rules live in [Session conversations](session-conversations.md).
Platform documents describe their mapping to this contract; they do not define
another work identity or lifecycle.

## Durable work and execution

`Session` is the only durable work object. It owns the conversation identity,
history, artifacts, current work context, runtime preferences, archive state and
optional external conversation binding. A message can add requirements, correct
earlier instructions or resume completed work without creating another Session.

`Request` is a durable accepted input within a Session. It preserves the original
input and attachments, initiator, idempotency identity, accepted options and reply
destination. Acceptance is distinct from execution and delivery.

`Run` is a concrete Harness execution. It owns its frozen runtime selection,
execution state, provider references and output. Native steering may feed several
accepted Requests into one Run. A Session may have many Runs over time.
Completion, failure, cancellation, model changes, compaction and service restart
do not change Session identity. Provider-native conversation IDs support resume;
they are not the durable work identity.

`Delivery` records publication of a Request's output and its external receipt.
Several parts may deliver one answer. Sending again, receiving a late receipt or
recovering a process cannot create another task or silently move the Request.

These execution and transport records support the Session. They do not create
parallel task objects with competing work ownership.

## People and access

People and external identities provide attribution, authentication and personal
views. Every authenticated Person has full access to the instance's Sessions;
Person identity does not impose Session ownership or authorization partitions.
Space, Project group and sidebar ordering are per-Person projections. Session
history, title, runtime and workflow state are shared.

Authentication, resource access, connector scope and backend tool authorization
remain enforced by code. A prompt cannot grant access. Sharing an authenticated
instance does not imply authorization to send a particular message or perform
every available external action.

Interactive App/template and Visitor role objects are retired. The previous
`Principal -> App -> Session` diagram and single-owner access model are historical,
not a refactor direction. New work must not reintroduce them through compatibility
fields or UI labels.

## Publication

`ShareSnapshot` is an immutable read-only publication of selected Session history.
It is separate from a live Session and does not receive future execution updates.
It remains the unauthenticated publication surface.

A Feishu topic is an interactive address for a Session, not a ShareSnapshot.
Publishing a scheduled or background result binds its actual topic receipt back
to the producing Session so human follow-ups can continue that work.

## Decision ownership

RemoteLab resolves exact conversation bindings, stores accepted inputs, handles
idempotency, queues execution and delivers results. The Harness interprets the
task, decides whether a contribution is useful, performs authorized work and
chooses when an independent persistent Session is useful.

The Session decision and response decision are separate. Existing bindings select
the Session; participation rules decide whether to receive/execute, and the Harness
may decide to remain silent. A deliberate silent result is distinct from an
unaccepted, failed, cancelled or undelivered Request. Optional reactions and
presentation must never become another admission or routing authority.

For the detailed ownership rules, scenario matrix and acceptance cases, use
[Session conversations](session-conversations.md). The Harness/control-plane
boundary is maintained in [Thin control plane](thin-control-plane-architecture.md).

## Forks and independent work

A true history fork creates a new Session with copied durable context and hard
isolation. It does not inherit an active Run, provider-native resume ID, external
trigger identity, external conversation binding or completion targets.
Later parent/child changes do not synchronize automatically.

The supported exact fork point is the current durable head. An unsupported
historical pre-compaction state must not be silently approximated.

Opening an independent work Session may carry the accepted source inputs and
relevant context rather than clone the whole history. It retains provenance and
an explicit delivery destination. Handoff does not discard the original text,
attachments or the original input's delivery responsibility.

## Derived surfaces

Session lists, workflow views, progress cards, attention cues and task-like labels
project Session and execution records. They do not own a parallel work lifecycle.
Persisted presentation metadata remains legitimate; its existence does not make
it the authoritative task object. The working directory is execution context,
not a work identity.

See [Session-first workflow surfaces](session-first-workflow-surfaces.md) for
organization behavior. A future cross-Session work object requires an explicit
product decision and independent lifecycle; it cannot emerge accidentally from
a card, transport index or classification output.

## Refactor acceptance

Every refactor must preserve:

- Session identity across input, execution, publication and later continuation.
- Original input, attachments and attribution through explicit handoff.
- One responsible execution destination per accepted input.
- Idempotent recovery without creating new work from uncertain receipts.
- Shared authenticated access and per-Person presentation as separate concerns.
- Harness semantic judgment and deterministic transport responsibilities.

The shipped code map is [Project architecture](../../docs/project-architecture.md).
Historical decisions remain in Git history and explicitly historical notes;
they must not be labeled as a second current baseline.

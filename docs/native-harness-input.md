# Native Harness input

RemoteLab forwards additional user messages to an active native Harness as soon
as its input channel is available. The Harness owns when those messages affect
model inference, tool execution, retries and subsequent turns. Receiving an
input is not a claim that an already-running model call has consumed it.

## Supported transports

| Harness | Transport | Active input | Stop |
| --- | --- | --- | --- |
| Codex | App Server, JSON-RPC over stdio | `turn/steer`, with `expectedTurnId`; `turn/start` only after a definite no-active-turn rejection | `turn/interrupt` |
| Pi | `--mode rpc` | `prompt` with `streamingBehavior: "steer"` | `clear_queue`, then `abort` |
| Claude Code | `--input-format stream-json --output-format stream-json` | streamed user messages with UUIDs | native interrupt control request |

The built-in tools select native input. Custom tools retain their existing batch
contract unless their tool record explicitly declares `"inputMode": "native"`.
An arbitrary program that only mimics a CLI's output is not automatically a
bidirectional implementation of that CLI's protocol.

The HTTP endpoint remains `POST /api/sessions/:id/messages`. It durably accepts
each requestId and returns a response address. Compatible active native inputs
return `queued: false`; they are forwarded without waiting for the root task to
finish. Incompatible Harness/model/effort changes during an active native task
return HTTP 409 (`SESSION_BUSY`). Stop the task or wait for completion before
sending with the changed configuration. Internal maintenance operations and
explicit batch-only custom runtimes retain their separate sequential contract.

## Ownership and recovery

The main process owns request identity, source context, attachments, history and
reply delivery. It does not choose a tool-result boundary or inject fabricated
tool results to make steering possible.

The detached sidecar owns the native process's stdin/stdout and a private local
control socket. Losing or restarting the main process does not close this
channel or stop the Harness's active tools. On native settlement the sidecar
closes the process; the next independent run uses the existing native session
resume mechanism. This is a bidirectional connection for active work, not a
second permanent chat service.

Additional requests keep independent request/response IDs and reference the
execution through `nativeDispatchRunId`. Their input text, attachment references
and source Context are recorded before transport. Requests consumed by one
execution share its final result. The root request atomically reserves reply
destinations, so the same conversation gets one final reply while distinct
destinations still receive their result.

Each sidecar journals native input as `dispatching`, then `accepted` or a
definite `rejected` result. Retrying a requestId reads the receipt or joins the
original pending acknowledgement. A lost acknowledgement is never converted
into a fresh model run. If the sidecar dies with an uncertain receipt, that input
fails explicitly instead of replaying potentially side-effecting work. A definite
native rejection fails only that input and leaves the existing task running.

Cancellation stops new handoffs into the cancelling execution. Already accepted
native inputs remain part of that execution; the Harness owns interruption of
its tools. The sidecar retains bounded process termination as a fallback when
the native interrupt cannot finish.

## Completion and streamed output

Native lifecycle events determine completion. A single `turn.completed`, Pi
`agent_end`, or Claude `result` is insufficient if the Harness has more work.
RemoteLab does not terminalize native runs from intermediate spool status events.
This also lets native error recovery finish before RemoteLab declares failure.

Codex preserves native item IDs, tool events and raw text deltas; the existing
transcript continues to publish finalized text items. Reasoning summaries stream
with projection state for replay deduplication. Pi retains its structured
tool/text/thinking events. Claude tracks input UUIDs and acknowledgement events;
`queued_turn_count: 0` alone does not establish that all submitted messages have
finished. Thinking projection state survives observer restarts, and cumulative
Claude cost is converted into per-result deltas.

The implementation uses Harness integration protocols. It does not depend on a
particular model's `async` tool flag or promise that arbitrary inference streams
can be mutated after a request has started.

## Feishu ingress

The connector already returned after main-service admission. It now dispatches
immediately on durable receipt and HTTP completion, and independent topics in
one chat no longer share an input slot. Short shared-index writes are serialized
to preserve bindings under concurrency.

The connector retains durable transport retry and same-topic ordering through
attachment preparation and HTTP admission. These protect `/mute`, model commands,
first-thread binding and exact retry payloads. They never wait for model output.
Moving raw upstream attachment ingestion into the main process would be a
separate transport architecture change; it is not required for active Harness
input. See [Feishu ingress verification](../notes/current/feishu-ingress-dispatch/verification.md).

## Verification and activation

`npm test` includes native protocol, transport, request dispatch, detached
recovery and connector regressions. The native-only gate is
`npm run test:native-harness`.

Optional real CLI tests use isolated homes, dummy credentials and loopback mock
model APIs, with the first inference held while another message is submitted:

```sh
REMOTELAB_NATIVE_CODEX_BIN=/path/to/codex \
REMOTELAB_NATIVE_PI_BIN=/path/to/pi \
REMOTELAB_NATIVE_CLAUDE_BIN=/path/to/claude \
npm run test:native-installed
```

Validated versions on 2026-09-10: Codex CLI 0.153.4, Pi 0.85.0 and Claude Code
2.1.267. Tests establish actual CLI protocol behavior against simulated model
responses; they are not production Feishu or live-model acceptance tests.
Older Claude versions can acknowledge at the replay/consumption boundary rather
than immediately; the driver still writes later inputs without waiting on that
acknowledgement. Older CLI versions in general are not certified by these tests.

Production activation is intentionally deferred for this change. No active
service or connector was restarted during implementation. Before activation,
retain the known-working checkout and a maintenance shell, advance the intended
instance to the verified main commit, restart only that instance, and check a
real follow-up while its Harness is running. Do not treat publishing the source
commit as proof of deployed behavior.

Official protocol references:

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Pi RPC](https://pi.dev/docs/latest/rpc)
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

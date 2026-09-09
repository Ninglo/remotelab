# Connector model and effort visibility

## Problem and reproduction

The Codex model catalog preferred native config.toml and recent models over the
RemoteLab product default, including still-supported GPT-5.6-Sol. Connector
requests carried model/effort without retaining them in session metadata. Opening
that session could therefore display a different model from the running request.
The early session-entry notification exposed no runtime information.

Failing regressions before the fix:

```text
actual: 'gpt-5.6-sol'
expected: 'gpt-6-astra'

actual: '会话已创建。\n\n查看会话详情和进度：...'
expected: /模型：fake-model/
```

## Implementation

- The Codex catalog always defaults to gpt-6-astra / low. Explicit model and
  effort selections remain available; CLI preferences only enrich the catalog.
- Admission resolves and stores runtimeSelection separately from raw options
  and their fingerprint. The entry notice and runner share this snapshot.
- A normal user run records its model/effort in session metadata. Internal calls
  do not overwrite user preferences. Historical records remain readable.
- The entry includes model, effort, Harness and the existing session URL. Missing
  provider defaults are labeled as Harness-controlled. Existing first-input,
  email, internal-operation and duplicate-delivery rules remain intact.

## Verification

Isolated tests before and after implementation, including a blocked fake Harness:

```text
test-models-codex-fallback: ok
test-session-runtime-selection: ok
test-reply-publication: ok
durable requests: early entry survives admission, concurrency, settlement, archive and restart
npm test: exit 0
npm run test:restart-gate: exit 0
npm run lint:filesize: exit 0 (advisory existing oversized files)
git diff --check and node --check: exit 0
```

The queued-run test changes session preferences after admission, replays the
original request, and checks the actual detached-run manifest retains the
admitted model/effort. The durable-store test recreates the store and verifies
new defaults cannot replace the stored snapshot. Tests use isolated state and
mock external transports; no test messages were sent to live chats.

Machine-local logs are under notes/local/runtime-visibility-20260909/.
The source is ready for the current owner instance restart; this does not claim
activation on other instances or retroactive repair of historical notifications.

# Feishu ingress dispatch

Implemented and tested in an isolated checkout on 2026-09-10. No production service or connector was restarted, and no external Feishu messages were sent.

## Behavior

The connector persists an upstream event before acknowledging it, then immediately attempts the existing main-service message endpoint. Completing that HTTP handoff immediately releases the next input. The one-second sweep remains only for restart discovery and bounded transport retries; it does not govern normal input latency.

Independent topics in one chat, and independent document comment threads, no longer share an ingress execution slot. Within one conversation, preparation and HTTP handoff remain ordered so `/mute`, runtime selection commands, first-thread bindings and immutable prepared submissions retain their established meaning. No connector code waits for model completion or chooses where the Harness applies user input.

The existing chat-wide bot publication fence now covers routing and quota admission only. Reaction calls, attachment preparation and main-service submission run outside it. A peer reply racing a publication still waits for the newly assigned thread/message aliases to be persisted, preserving bot-loop protection. Main-service acceptance receipts, fixed retry payloads and the outbound delivery journal remain unchanged.

Concurrent topic processing required serializing the short read/modify/write transactions for the message/session index and known-sender index. These file locks do not cover network or model work. Inbox scans also recheck the durable receipt before dispatch, so a scan overtaken by completion cannot repeat an already accepted event.

## Reproductions and checks

Before the change:

- Accepting input followed by `idle()` left the processor untouched until the periodic sweep.
- Holding the first topic's HTTP transport prevented an independent topic from entering its own transport within the test deadline.
- Parallel message-index writes failed with `ENOENT` while renaming the shared timestamp-based temporary file.
- Restoring eight independent pending inputs retained only two of the expected nine known senders.

All fourteen focused connector regressions pass with the clean-instance wrapper; full output is retained in `test-results.txt` beside this note. New coverage includes a real loopback HTTP server holding the first acceptance while eight sibling topics submit, immediate admission/completion wakeups, ordered same-topic retries, stale-scan deduplication, shutdown, twelve concurrent message-index updates, and preserved sender/thread indexes after buffered recovery. Existing bot publication races, quota persistence, mute, runtime commands, topic fork/continue, document comments, source delivery, WeChat inbox boundaries, email receipt-loss recovery and offline conversion regressions pass.

The new `tests/test-feishu-ingress-dispatch.mjs` belongs in the connector recovery gate. Production receive-to-Harness acceptance remains a later rollout check; these tests establish connector transport behavior without using a real upstream account.

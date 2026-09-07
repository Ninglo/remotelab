# Connector restart refactor verification

## Original problem

Feishu processing, Run completion and reply sending could lose their next-step owner when the controller or connector restarted. The previous session had a partial implementation and unfinished regression changes; its session summary incorrectly still described design-only work.

## Reproduced failures and fixes

- Publication regression: removed legacy response variable was still referenced; the merged first-reply session link was missing. Restore the current response identity and build the snapshot with session/full-history context.
- HTTP generated-file integration: Run was completed and files uploaded but finalization never finished. `appendAssistantMessage -> getSession -> Run reconciliation` recursively awaited the same sync promise. The write path now reads metadata and returns a projection without re-entry.
- Inbox test: the exact prepared handoff was not persisted, so retries could change selected model or attachment references. Save it before submission; reuse it after restart; reject same-ID content conflicts.
- Attachment-only admission: the store rejected an empty text body even with uploaded images. Preserve the HTTP contract by accepting text or attachments.
- Archived response lookup: a response ID different from request ID became unfindable. Persist immutable direct lookup addresses before acceptance.
- Completion recovery: released execution records disappeared before pending completion effects ran. Keep outstanding completion responsibility on the Request until its handler returns.
- Pre-launch cancellation: accepted input had no `activeRunId` yet, so cancellation returned null. Cancel the durable Request and terminalize it without launching an executor.
- Trigger regression: reply Delivery lost trigger/schedule/occurrence IDs. Preserve them in the result/Delivery commit.
- Test cleanup: a signalled child retained a null exitCode and cleanup awaited an exit that had already occurred. Track signalCode and propagate IPC failures.

## Evidence

Automated commands and final results are recorded in the repository-root `test_results.txt`. The recovery tests are part of `npm test`; no live customer message was needed for these checks. See `connector-request-recovery.md` for the state model and the remaining production migration/acceptance boundary.

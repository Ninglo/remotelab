# Session Debug

Use this skill when a RemoteLab session, run, or share link needs inspection from the CLI.

Default behavior:

- Prefer CLI or API inspection over browser-only debugging.
- Keep the investigation scoped to the target session or run.
- Report the concrete state, blocker, and next repair step.

## Response time

For ordinary "how fast are replies now?" questions, use `remotelab response-time --json`.
It reads the existing monitoring snapshot once and returns first response, final
delivery, stage statistics, observation time and coverage. `--days 7` returns the
seven daily measurements; it does not average daily percentiles. This entry does
not inspect transcripts, scan spools, call a model or create another collector.

For a known message, use `remotelab response-time --request-id <accepted-input-id> --session <session-id> --json`.
The current Session is the default. This is a bounded lookup of existing local
Request and delivery-owner records, including explicitly attributed steered
replies. Do not substitute the current input for a previous message. Missing or
pending receipts remain unknown; use targeted diagnostics only if the reported
gap or anomaly needs investigation.

The summary separates ordinary conversations from group mainlines and preserves
the monitoring definitions and coverage. First response includes openings and
excludes automatic status and reactions. Final delivery is provider acceptance
of the final result, not task acceptance. See [monitoring](../monitoring.md#response-time-query)
for the maintained contract.

## Codex safety blocks

For `Potentially unintended activity`, check the structured native error before
diagnosing context length. Codex exposes `codexErrorInfo: misalignmentPolicyViolation`
(native rollout: `codex_error_info: misalignment_policy_violation`). This is a
behavior-monitoring stop, not a context-window overflow. A `remote compact`
prefix identifies the operation that failed, not the cause of the block.

RemoteLab retains the public native error in the spool and normalized status
event (`providerError`), including additional details and optional `misalignment`
explanation/continuation information. The event also retains thread/turn IDs and
the provider's retry indicator. Older runs may have only the message in the
spool; inspect the exact thread's native rollout, preserving the original.

Stop automatic dispatch for the affected workflow and review prior actions
against the human's authorization. Preserve request/response IDs, errors and
tool results. The monitor is asynchronous, so the latest innocent-looking input
does not identify the triggering action, and earlier actions are not rolled back.
Do not infer a policy violation by the user or a confirmed agent mistake from
the flag alone. Do not clear history or switch credentials to evade the block.

The API has no general unblock endpoint. Codex's installed protocol may carry an
optional public explanation and a provider-issued `steer.message`: preserve it,
present the explanation for review, and obtain explicit human confirmation
before using that provider-supported continuation. Never invent continuation
instructions or automatically execute the returned steer. If none was returned,
prepare a support report with timestamps, native version, thread/turn IDs and
the exact error; do not claim that a local restart or compaction will unlock it.
For API projects, authorized `safety.alert.created` webhooks and the Safety Alerts
API can supply available category information; a ChatGPT subscription is not an
API-project credential.

References: [OpenAI monitoring guide](https://developers.openai.com/api/docs/guides/safety-checks/misalignment-monitoring)
and [Codex App Server](https://learn.chatgpt.com/docs/app-server). Verify the
installed protocol with `codex app-server generate-json-schema` before using
optional fields. Validate error transport with `tests/test-native-codex.mjs`
and `tests/test-codex-adapter.mjs` in the clean-instance test wrapper.

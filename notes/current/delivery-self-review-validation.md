# Optional delivery self-review — 2026-10-22 validation

Default-off personal setting; the selected Harness checks delivery inside its existing task. No separate reviewer, completion gate or automatic continuation. The setting and acceptance snapshot are documented in [the execution contract](../../docs/session-work-awareness.md#可选交付前自检).

Historical source: `8172ab91` introduced the visible-turn projection; `ceefdb5d^:chat/session-reply-self-check.mjs` includes attachment-only results and `resultRunId`. Feedback dated 2026-06-15 records the attachment false-negative; 2026-06-02 records hidden earlier replies after automatic continuation. Both constrain the new opt-in. The old default-continue decision bias is not restored.

## Evidence

The real-model test used installed Codex CLI 0.159.2, its configured gpt-6-astra / medium, isolated files, a disposable provider home and a loopback HTTP file. Only this runner’s existing native authentication/configuration was copied into that disposable home; it was removed after execution. It did not enable any production Person or send test messages to Feishu. Source data contained two orders with 10 and 20 units. An earlier claimed completion had left a mock report (999 rows / 999 units) and an empty summary.

| Sample | Observed result | Time | Input / output tokens | Tool commands |
|---|---|---:|---:|---:|
| Repair, off | Corrected both files; 2 rows / 30 units; two actual registered attachments | 24.157 s | 59,454 / 498 | 3 |
| Repair, on | Corrected both files; 2 rows / 30 units; two actual registered attachments | 25.630 s | 62,351 / 548 | 3 |
| Already delivered attachment, on | Read the real file and referred to the existing download entry; no duplicate artifact | 11.870 s | 31,153 / 113 | 1 |
| Missing source, on | Rejected the prior unsupported “999” completion; reported missing CSV without fabricating a result | 17.341 s | 46,230 / 205 | 2 |
| Supplement/correction, on | Answered 8 × 9 = 72, then delivered only order a: 1 row / 10 units | 24.082 s | 62,462 / 519 | 3 |

The final pair adds 1.473 seconds, 2,897 input tokens and 50 output tokens. Cached input differs (55,808 off / 58,496 on). An earlier passing pair measured 27.503 / 38.502 seconds (+10.999 seconds), demonstrating the latency variation; these are whole-task usage totals, not a fixed review fee or latency estimate. Both baseline and opt-in repaired this task, so this sample does not establish a success-rate improvement. The enabled block is 1,310 characters, versus 173 for the disabled reset (+1,137), before normal slot reuse; no additional reviewer model call is scheduled.

The first test run exposed an overly broad test instruction to always attach files and an asset-verification bug (passing the client projection instead of the stored asset ID). The test now uses the production conditional attachment contract and reads the stored asset by ID. The review procedure also explicitly excludes already confirmed attachments from a new Artifacts block and avoids unsolicited blocker-report attachments. All five cases were rerun with the corrected test. Earlier failed records are retained in the instance's evidence directory.

## Execution and surface regression

- `test-delivery-self-review.mjs`: default off, no rule read when off, identity mismatch, explicit on/off, stale versions, current-run ownership, older UI preservation, captured rule/hash, Codex/Claude/Pi prompt assembly and real attachment-only visible/publication projection.
- `test-native-harness-integration.mjs`: actual request manager and native transport with a deterministic provider fixture; running/queued input, same-person frozen setting, different-person isolation, retry, stop, controller restart, ordinary steer and one final/file delivery. This is transport validation, not a live model claim.
- The complete `npm run test:workboard` suite passed (26 scenario scripts, including native transport).
- Personal settings card callbacks, narrow Web settings, strict-start, rule-context and usage regression: 23 tests passed alongside the new unit/contract test and static serving check.
- `test-delivery-self-review-browser.mjs`: real browser plus isolated HTTP server; default off, save on, reload, save off, another Person unchanged, desktop 1200 × 900 and mobile 390 × 844 without horizontal overflow.
- `test-http-file-assets.mjs`: real HTTP upload/download routes pass. Generated model files were published by the normal artifact collector and read back byte-for-byte. Loopback HTTP availability is local verification, not public or Feishu delivery.

These checks do not establish that every Harness will follow the optional procedure, nor that a human has clicked the production Feishu control. The implementation preserves ordinary verification while off; a person can opt in through existing settings. Deployment version and active-instance scope must be read from the service separately.

This delivery is prepared for review only. The later human constraint excludes production deployment, restart, mainline/source switching, automatic website publication and enabling any existing Person. Production rollout and real Feishu opt-in remain separate acceptance steps.

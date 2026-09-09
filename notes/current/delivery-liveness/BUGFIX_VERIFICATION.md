# Delivery liveness and visible failures

## Contract

Each delivery either obtains a receipt, retries within its existing five-attempt bound when failure is known safe, or retains a visible failed/unknown state. An uncertain operation is never blindly repeated. It no longer blocks later attachments or replies in the same conversation. Active sends retain ordering until their lease expires; missing/malformed claim times also expire rather than blocking forever.

Feishu HTTP operations settle within 30 seconds even if the transport ignores abort. Attachment download redirects and streaming bodies share a 30-second deadline. Preparation failures cannot proceed into a later message send after cancellation. An external send that times out may still have succeeded remotely, so it remains unknown and keeps its original lease for a late acknowledgement.

Success and failure journals replay independently. A rejected acknowledgement is retained with its error and a 30-second backoff; other acknowledgements and deliveries can proceed. Feishu limits each journal replay to ten records and a 30-second budget checked between acknowledgements, with each HTTP acknowledgement independently bounded. The journal never repeats an external send.

Failed originals remain in active Request state until explicitly retried, confirmed delivered, or dismissed through the existing resolution API. Session detail projects the current issue list; session summaries carry only the count, preserving their cache contract. Pending deliveries older than two minutes show a connection/delay warning even when no sender is running. A read-only observer checks every ten seconds and invalidates open pages only when issues change, so elapsed-time warnings do not require a manual reload. Retry progress, expired sends, failures and uncertainty appear above the composer and in the session list without changing chronological ordering.

For Feishu, the same Request atomically adds at most one simple text notice and a session link. Notice failures never create more notices, and do not block subsequent output. A pending notice is cancelled if all original deliveries resolve before it is sent. Notices remain best effort: if the same Feishu channel is unavailable, the independently persisted web status is the fallback. No model call is used for these notices.

## RED evidence

- Queue fault: `an uncertain send must not freeze the topic`, actual `null`.
- Receipt fault: `stale lease` stopped before the healthy acknowledgement.
- Ignored abort and stalled redirected body: expected `rejected`, actual `hung`.
- Session API: expected delivery ID, actual `undefined`.
- Late success: an obsolete warning remained claimable after the delivery resolved.
- Integration regressions uncovered and fixed inconsistent list/detail summary ETags and a frontend signature that ignored delivery-only changes. An empty timeline must still show delivery issues.

## GREEN evidence and limits

`tests/test-delivery-liveness.mjs` covers queue progress, no resend of an uncertain original, notification recursion, late receipts, failure retention/resolution, retry exhaustion, connector-offline visibility, stale warning cancellation, poisoned journal replay/backoff, ignored abort, redirect/body deadline and session/list API projection. It runs in the standard recovery gate.

The optional `tests/test-delivery-issues-browser.mjs` starts an isolated real controller and uses its authenticated API. Chromium verifies the actual page and sidebar on desktop/mobile, keyboard disclosure, literal error text instead of injected HTML, live warning removal and persistence after reload. It uses no real connector or model send. Set up Playwright and its browser dependencies outside the shipped package, then pass the module path and artifact directory as arguments.

Full isolated `npm test`, restart gate, syntax/diff checks and advisory file-size lint passed. Final frontend fixes also passed the real browser/API test, sidebar ordering, queue panel and summary ETag regressions; CI validates the exact landing commit before activation. Detailed fault logs, API/browser checks and screenshots live in ignored `test-results/feishu-delivery-liveness/`.

This is a bounded failure-handling contract, not a promise that every platform error can be automatically repaired. Permission changes, unsupported/oversized content and true send ambiguity may still require a person or agent to intervene. Filesystem failure, a stopped controller and an unavailable external channel can prevent immediate persistence or notification; existing disconnected UI/service supervision remains necessary. This change does not add recursive alerts, automatic replay of unknown messages, or retrospective scanning of archived legacy failures.

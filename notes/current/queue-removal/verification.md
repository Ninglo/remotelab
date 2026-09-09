# Queued-message removal

Request: mistaken queued follow-ups could only be viewed, with older entries hidden.

Each queued row now exposes Remove. All entries are accessible in the scrollable queue.
The DELETE endpoint uses ordinary session access and shares the scheduler lock. It only
removes pending follow-ups, atomically records cancellation and release, and retains the
request identity for retries. Active work and remaining FIFO order are preserved. Removed
input creates no transcript message, executor, completion agent or external reply.

Verification: [test output](test_results.txt). Tests include nonexistent/cross-session IDs,
URL-encoded connector IDs, unauthorized requests, idempotence, admission replay, a real
server restart with an active fixture executor, transcript exclusion, no launch receipt,
keyboard/mobile removal, older rows, reload, double clicks, network errors and switching
sessions while removal is pending. New regressions run in the normal smoke gate.

The first restart-gate attempt observed an unrelated frontend fingerprint change while
other tests were active; the complete gate passed on a sequential run. Browser fixtures
use temporary instance state and a fake executor, with no live connector sends.

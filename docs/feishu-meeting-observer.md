# Feishu meeting discovery and observer pilot

Operator prompt: “Use this instance's own Bot to discover company meetings. Enable
automatic attendance only for the specified meeting number, human organizers and
time window. Save original transcript events and report actual admission and text
coverage. Do not start the meeting, borrow human OAuth or join other meetings.”

Supply the Bot profile, tenant, approved test meeting number, human organizer
open IDs and expiry together. The operator verifies current application scopes,
publishes the required event subscriptions and configures the existing Connector.
Only inaccessible enterprise approval or host admission is a human dependency.

The Connector registers `vc.meeting.all_meeting_started_v1` and
`vc.meeting.all_meeting_ended_v1` on its existing WebSocket. These are enterprise
discovery events, not evidence of access to private artifacts. It never opens a
competing same-app connection. A missing policy disables the feature.

Private `meeting-observer-policy.json` in the Connector storage directory:

```json
{
  "enabled": true,
  "appId": "cli_example",
  "tenantKey": "example-tenant",
  "targets": [{
    "meetingNo": "123456789",
    "ownerOpenIds": ["ou_example"],
    "notBefore": "2026-10-09T20:00:00+08:00",
    "expiresAt": "2026-10-09T20:45:00+08:00"
  }]
}
```

Discovery records and selected meeting events are saved privately under
`meeting-observer/<meeting_id>.json`. Join intentions are durable before the API
write; an ambiguous result never repeats the visible join, including after restart. Successful
event reads establish admission separately from a join request. Reads use a
durable page cursor and de-duplicate event IDs, saving speaker fields, timestamps
and original transcript items. Polling exists only while a permitted test is
active and drains available pages immediately, then checks every two seconds.
Expiry, end events or repeated failures stop collection without ending the human
meeting. A post-end API denial preserves all text already captured.

Feishu can reject entry with `120002` until the host enables AI Summary and allows
agents in the meeting's Security settings. Only this definite rejection permits
another join attempt: every two seconds, at most thirty attempts and sixty seconds,
within the authorized target window. Other rejections and ambiguous responses
stop or resume reads without repeating the join. Provider error codes, HTTP status
and diagnostic log IDs are retained without authenticated SDK request objects.

Required Bot scopes: `vc:meeting.all_meeting:readonly` for discovery and
`vc:meeting.bot.join:write` for native attendance and event reads. Check current
Feishu data conditions, app availability and host restrictions independently.
No startup log, granted scope or created calendar event proves full coverage.
Unrecorded speech, late entry, disconnected intervals and private post-meeting
artifact restrictions remain explicit acceptance boundaries. This pilot saves
original events; it does not publish company-wide summaries or silently start
all-meeting attendance.

## Post-meeting delivery to a recording group

Operator prompt: “Connect this instance's existing meeting discovery to the
specified recording group. Start with new meetings from the agreed cutoff plus
these explicitly approved acceptance samples. Fetch authorized original text,
reuse the existing recording-analysis workflow, verify actual group messages and
analysis replies, and preserve failures for recovery. Keep attendance disabled;
do not change another person's artifact sharing or execute proposed actions.”

Supply the exact Connector/Bot, tenant, destination chat, tenant document origin,
new-meeting cutoff and any individually approved sample meeting IDs/source links
in one handoff. An unavailable resource ACL or enterprise event subscription is
a human dependency only after checking the actual existing capability. This
worker does not request per-file access, transfer ownership or enable attendance.

The existing enterprise-ended handler durably admits a job before acknowledging
its event. Startup replays discovery files through the same admission gate; the
cutoff uses the meeting's end time, not event arrival time. The existing Connector
inbox runs one material transaction at a time, using the meeting ID as its durable
identity. A Minutes-token claim additionally prevents two meeting IDs from
publishing the same source. This is one ingestion per meeting, not a revision or
multi-segment recording synchronizer. Historical records outside the cutoff are
ignored unless named individually in `sampleMeetingIds`.

Create private `meeting-ingest-policy.json` alongside the discovery policy:

```json
{
  "enabled": true,
  "appId": "cli_example",
  "tenantKey": "example-tenant",
  "chatId": "oc_authorized_recording_group",
  "documentBaseUrl": "https://example.feishu.cn",
  "notBefore": "2026-10-15T16:50:00Z",
  "sampleMeetingIds": ["1234567890123456789"],
  "samples": {
    "1234567890123456789": {
      "minuteUrl": "https://example.feishu.cn/minutes/obcExample",
      "noteUrl": "https://example.feishu.cn/docx/docExample",
      "sourceRefs": ["feishu:original_authorized_message"]
    }
  }
}
```

`ownerOpenIds` can further restrict organizers. `meeting-observer-policy.json`
continues to own discovery and attendance; keep its `targets` empty when
attendance is stopped. Restart the existing Connector to load the implementation
and recover discovery. Do not run a competing worker or WebSocket.

The material reader uses the existing Bot identity to resolve the meeting's
recording URL and related artifact tokens. It exports speaker/timestamp text
from readable Minutes. It can also fetch the related original Docx transcript,
or follow the explicit “文字记录” link in a readable note. Known note links from
an authorized source can be supplied as sample/recovery hints. It does not scan
other groups or borrow another person's OAuth, and does not treat an AI summary
as an original transcript. Unified-note tabs without an independently readable
transcript are not covered. A private Minutes file may deny access even when the
linked Docx transcript is readable. Public note discovery from personal
notification messages is not provided by this worker; an empty artifacts API
response therefore remains a coverage gap unless an authorized source supplies
the note link. No capability claim extends to all company-private materials.

`meeting-ingest/materials/<meetingId>/source.json` records provenance, actual read
identity, provider errors and log IDs, original links, text length and hash. It
preserves the original text in a private file. An empty or unavailable transcript
never produces a success message in the group. Generation retries are bounded to
12 attempts with persisted due times (1, 2, 4, 8, then up to 15 minutes between
attempts, with a durable two-hour material deadline). This accommodates observed production
recording generation taking over forty minutes. Network retries start at 250 ms,
then 500 ms, 1 s, 2 s, up to 5 s; application/ACL denial stops with recoverable
evidence. Restart does not replenish an attempt budget.

Before sending, the worker persists its intention and a stable provider UUID.
After success it reads the real message back and checks destination and source
marker. Ambiguous sends are recovered by bounded history reads (up to 500 messages)
and never blindly resent, even after the provider's UUID lifetime expires. A
missing readback becomes `delivery_unknown`, not a new send. Successful recovery
reuses the same message and thread. Definite provider rejection is recorded
separately. The source marker is visible for audit and recovery.

Only after message readback does the worker submit to the existing Connector
Session/Request path. The original group's current prompt is reused, with an
explicit analysis-only instruction and private source-file pointers. Submission
is persisted before HTTP admission and retries reuse the same Request. The Bot
is the source actor; neither the meeting owner nor a human approver is invented.
`analysis_accepted` means the Request was admitted, not that the analysis or its
Feishu delivery finished. Verify the Session response and source-delivery receipt
and read the actual reply in the original meeting thread before claiming full
acceptance. No transcript document is recreated or audio uploaded.

Inspect or recover through the existing Connector's private mailbox:

```bash
node scripts/feishu-meeting-ingest.mjs status --storage-dir <connector-state>
node scripts/feishu-meeting-ingest.mjs retry --storage-dir <connector-state> \
  --meeting-id <id> --note-url <authorized-note-url> --source-ref <original-source>
```

The retry command prints a command receipt path. A native filesystem notification
wakes the existing consumer; pending commands also recover at startup. It does
not run a second worker. Retries reset the finite read budget, preserve send
intentions and immutable Request payloads, and cannot resend an accepted job.
Do not clear dedup claims or edit send intentions to force a retry. If a send is
unknown, inspect the actual destination first; a retry only rechecks that same
message. A new root message requires separate reconciliation if no receipt can
be established.

To pause, set only `meeting-ingest-policy.json`'s `enabled` to `false`. The worker
rechecks policy before material work, visible sending and analysis admission;
an already in-flight provider operation may finish. Existing analysis Requests
have their normal independent cancellation controls. Discovery stays enabled and
attendance stays stopped. Re-enable and retry selected retained jobs; restarting
with a later cutoff excludes newly accumulated meetings, so recovery never needs
a blanket historical replay.

Acceptance checks: authorized sample source and actual transcript; real root
message and final analysis reply; repeated end events and restart without another
root; delayed generation and permanent denial; ambiguous send readback; a later
new meeting through the real event subscription. Synthetic subsequent events in
isolated tests prove the handler path, not live provider subscription coverage.
Record a still-pending natural meeting separately from a passed replay test.

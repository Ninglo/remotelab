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
new-meeting cutoff, source-group/organizer scope and any individually approved sample
meeting IDs/source links in one handoff. An unavailable resource ACL or enterprise event subscription is
a human dependency only after checking the actual existing capability. This
worker does not request per-file access, transfer ownership or enable attendance.

The existing enterprise-ended handler checks participation before admitting a job.
Startup replays discovery files through the same admission gate; the
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
  "scope": {
    "mode": "source_group_or_organizer",
    "organizerOpenIds": ["ou_authorized_organizer"],
    "organizerNotBefore": "2026-10-15T16:50:00Z",
    "userOrganizerLookup": true
  },
  "userNoteLookup": true,
  "userNoteTranscript": true,
  "intake": {
    "root": "/absolute/private/recordings/intake",
    "scriptPath": "/absolute/existing/recording-analysis/scripts/intake.py"
  },
  "recovery": { "dailyRetry": true },
  "processingMode": "transcribe_archive",
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

Source eligibility is required even for samples and recovery commands. In
`scope.mode: "source_group_or_organizer"`, either of these qualifies:

- The exact meeting's provider metadata supplies its originating `chat_id`, and
  the Bot-only `is_in_chat` API confirms the Bot belongs to that group.
- The provider's meeting owner (organizer) matches `scope.organizerOpenIds`.
  This uses live meeting details or the same Bot/tenant's persisted discovery
  owner, never a caller's assertion. `organizerNotBefore` bounds expansion to
  newly authorized meetings without replaying older personal meetings.

Bot attendance alone, membership of a named human in the group, the host,
participants, title, destination group and existing artifact access do not
qualify under this mode. If owner metadata is absent, explicit
`userOrganizerLookup: true` permits the existing profile's authorized user to
search by organizer and exact meeting time; all pages are checked for the exact
meeting ID. A host is never substituted for the organizer. Unresolved ownership
or lookup failures remain in the scope record and deny content/ACL work.

Legacy `scope.mode: "participating"` remains supported for other instances:
actual Bot attendance or source-group Bot membership qualify. Its optional
`groupMemberOpenIds` plus `userGroupLookup` checks exact human membership via the
existing user profile. These legacy extensions do not apply to the new mode.
Top-level `ownerOpenIds` remains an additional restriction, not an alternative
admission rule; use `scope.organizerOpenIds` for the union described above.

`meeting-ingest/scope/<meetingId>.json` records the decision and evidence. The
same check precedes material reads, visible delivery and permission/analysis
admission, including old queued jobs with cached text. Revoked jobs become
`scope_excluded`; restoration of an already-started ownership transfer must still
finish. Discovery metadata remains separate from collection. Human/automatic
audio uploads retain their existing intake policy and are not changed by this
meeting policy. Do not open a competing worker or WebSocket.

The material reader uses the existing Bot identity to resolve the meeting's
recording URL and related artifact tokens. It exports speaker/timestamp text
from readable Minutes. It can also fetch the related original Docx transcript,
or follow the explicit “文字记录” link in a readable note. Known note links from
an authorized source can be supplied as sample/recovery hints. It does not scan
other groups or borrow another person's OAuth, and does not treat an AI summary
as an original transcript. Unified-note originals require the explicit user transcript option described below. A private Minutes file may deny access even when the
linked Docx transcript is readable. Public note discovery from personal
notification messages is not provided by this worker; an empty artifacts API
response therefore remains a coverage gap unless an authorized source supplies
the note link. No capability claim extends to all company-private materials.

When this instance already has an authorized user identity in the same CLI
profile, `userNoteLookup: true` explicitly enables one additional metadata path:
Bot meeting details (`query_mode=0`) provide `note_id`, then the user-only
`note +detail` resolves the note and standalone transcript tokens. This can work
when `query_mode=1` returns an empty object. It does not log in, request new
permissions, switch profiles or change resource ACLs. Normal transcript/Docx reads and group delivery still use the Bot. `source.json.noteLookup` records the separate
metadata identity and note ID; default behavior remains Bot-only. For a verified unified Note, `userNoteTranscript: true` additionally permits
`note +transcript` under that same existing authorized user identity. The CLI
fetches all pages into a fresh file; failure or missing timestamped text does not
publish a partial result. `source.json.transcriptIdentity` identifies the actual
reader. This option does not transfer ownership or obtain new user authorization. Check the existing profile's actual authorization
before enabling this option. Do not retry an old failure if its material has
already been manually posted and analysed in the target group; retain that
manual receipt separately rather than claiming automatic success or reposting it.

`meeting-ingest/materials/<meetingId>/source.json` records provenance, actual read
identity, provider errors and log IDs, original links, text length and hash. It
preserves the original text in a private file. An empty or unavailable transcript
never produces a success message in the group. Generation retries are bounded to
12 attempts with persisted due times (1, 2, 4, 8, then up to 15 minutes between
attempts, with a durable two-hour material deadline). This accommodates observed production
recording generation taking over forty minutes. Network retries start at 250 ms,
then 500 ms, 1 s, 2 s, up to 5 s; application/ACL denial stops the immediate attempt with recoverable evidence. Restart does not replenish an attempt budget.

When `intake.root` and `intake.scriptPath` point to the instance's existing
recording-analysis registry, the worker registers eligible meetings before
material collection and updates them through failure, transcript acquisition and
Request admission. Stable source IDs are `feishu-meeting:<meetingId>`; downstream
Harness work updates this same entry rather than registering a second Minutes
source. The existing registry owns file hashing, locking, versions and readback.
Producer updates preserve consumer analysis, gaps and consumption receipts,
including an explicit re-read/merge after a version conflict. Partial collection
and failed transcription remain discoverable; Request admission never marks
analysis or consumption complete. A successfully exported original transcript is
saved locally; this worker does not download meeting audio.

For `recovery.dailyRetry: true`, the instance's existing daily review may run
`retry-pending` before reading the index. It queues eligible archived material
failures through the same Connector mailbox, at most once per UTC date/meeting,
and rechecks current scope. It does not replay pre-cutoff meetings, resend
unknown deliveries, or re-admit already submitted analysis/permission work.
Each recovery retains its finite two-hour attempt budget. No extra timer or
second daily consumer is created. Configure the existing daily review to read
pending/failed entries and their original Request, retain unresolved reasons,
and read available full transcripts even when analysis is still pending.

Before sending, the worker persists its intention and a stable provider UUID.
After success it reads the real message back and checks destination and source
marker. Ambiguous sends are recovered by bounded history reads (up to 500 messages)
and never blindly resent, even after the provider's UUID lifetime expires. A
missing readback becomes `delivery_unknown`, not a new send. Successful recovery
reuses the same message and thread. Definite provider rejection is recorded
separately. The source marker is visible for audit and recovery.

Only after message readback does the worker submit to the existing Connector
Session/Request path. The original group's current prompt is reused, with an
explicit processing instruction and private source-file pointers. Submission
is persisted before HTTP admission and retries reuse the same Request. The Bot
is the source actor; neither the meeting owner nor a human approver is invented.
`analysis_accepted` means the Request was admitted, not that the analysis or its
Feishu delivery finished. Verify the Session response and source-delivery receipt
and read the actual reply in the original meeting thread before claiming full
acceptance. No transcript document is recreated or audio uploaded.

`processingMode: "transcribe_archive"` separates intake from analysis. Readable
text and authorized permission recovery both submit only source preservation,
complete transcription, intake registration and a short archive receipt. The
Harness leaves `analysis: pending` and does not produce summaries, candidate
memories/actions or schedule later analysis. A human's subsequent request can
use the saved original text. `archive_accepted` records admission only, with a
separate `archive` Request receipt; verify actual files and index before calling
the archive complete. Omit the mode (or use `analyze`) to preserve a legacy
instance's automatic summary workflow. Permission recovery still restores
original ownership immediately, before any later processing.

For an explicitly authorized instance, `permissionRecovery` may opt a denied
**identified Minutes recording** into the existing Harness execution path:

```json
{
  "permissionRecovery": {
    "enabled": true,
    "instructionsPath": "/absolute/private/path/recording-permission-workflow.md",
    "authorizationRefs": ["actual-human-request-id"]
  }
}
```

This applies only after participation has passed. Recovery instructions must
recheck the current scope before new access/ACL/publication work; an already
started ownership restoration must still finish if scope is later revoked.
Keep the original ownership policy, exact notification wording, restoration and
failure recovery steps in that private file. An enabled flag without both the
instruction path and human authority references does not activate recovery.
The Connector sends a truthful processing notice, verifies it, and admits one
Request into that same recording-group thread. The Harness reads the instructions,
notifies the original owner before changes, performs the authorized grant and
restoration, checks actual access, then delivers the transcript analysis and verified
participant information. The Connector itself never silently transfers ownership.
`permission_recovery_accepted` means only that this work was admitted; its actual
permission, restoration and delivery results remain in that Request's evidence.
Duplicate events/restarts reuse the same job and message. A denied API without a
known Minutes URL does not create a group notice. Recovery disabled in policy
stops pending jobs before a new send/admission. Requests already admitted must be
stopped via the normal Session controls.

For future-only activation, set `notBefore` to the human-agreed cutoff and clear
historical `sampleMeetingIds`/`samples`. This flow covers the existing enterprise
meeting-ended discovery, including observed calls; it does not claim that arbitrary
personal audio uploads generate an enterprise meeting event. Do not open a second
same-app WebSocket to add event coverage.

Inspect or recover through the existing Connector's private mailbox:

```bash
node scripts/feishu-meeting-ingest.mjs status --storage-dir <connector-state>
node scripts/feishu-meeting-ingest.mjs retry-pending --storage-dir <connector-state>
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

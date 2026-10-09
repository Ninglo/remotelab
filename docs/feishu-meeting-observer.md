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

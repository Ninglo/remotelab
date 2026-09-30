# Give Jev dated project context from published daily reports

Operator prompt:

> Connect the selected Jev group to our existing daily project reports. Use the
> local Markdown directory and publisher receipt directory below. Validate that
> each source is the published, body-verified version; keep dates and caveats;
> select bounded relevant excerpts without another model call. Verify supported
> yes/no questions, unknown facts, stale publications, and normal group routing.

Supply the Bot route, selected chat ID, absolute `reportsDir` and `receiptsDir`,
and the report timezone (default `Asia/Shanghai`). Enable `dailyReportMemory`
only on a group already using `jevReactions`, `quickReactions`, ambient
participation, and `groupFeed`:

```json
{
  "dailyReportMemory": {
    "reportsDir": "/instance-workspace/project-knowledge/daily",
    "receiptsDir": "/instance-workspace/project-review/publication-receipts",
    "timeZone": "Asia/Shanghai"
  }
}
```

The connector checks today's and the preceding two dates for the latest
publication no older than 48 hours. A usable receipt has `ok=true`,
`body_verified=true`, `dry_run=false`, a document URL, matching date and source,
and a `body_sha256` equal to the local Markdown. An unpublished edit is not
treated as the published report. Missing, failed, future, or expired inputs
leave the existing decision path available without project memory.

Local file metadata invalidates a bounded process cache. Each incoming
question selects at most four complete relevant paragraphs, totaling at most
3,200 characters including section names. Whole paragraphs retain evidence
links and qualifications. The report is not copied into a second knowledge
store, and its normal publisher remains the only writer. The next message
automatically reads a newly published version. No polling task, Feishu fetch,
Harness startup, or additional Jev request is introduced.

Jev receives `state.project_memory` alongside the existing recent discussion.
Its instructions distinguish explicit dated evidence from plans, oral reports,
and live state requiring a new check. Missing information produces no binary
answer; it is not evidence for No. Recent corrections supersede older reports.
The 85% binary probability gate and @-mention text routing are unchanged. An
additional parallel evidence question must also reach 85% support for using
current discussion or the dated project snapshot. It blocks a high-probability
Yes/No when the report cannot establish the requested live fact; it shares the
same Jev call and does not add a network round trip.
If evidence is insufficient, a requested reply follows the existing complex
work route rather than treating the report as enough for a brief factual answer.
Source date, URL, publication time and body hash are retained in the decision
and its Session event. A structured connector log also records input use and
Jev latency without storing the report text in the log.

This provides project snapshots. Architecture and stable identity facts are a
separate input source, and are not inferred from the daily report's prose.

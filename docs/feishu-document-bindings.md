# Bind document comments to an existing conversation

Ask your Agent: “Bind this Feishu document to this review topic. Receive new comments and replies in its existing Session; use the normal Feishu API when replying to a comment.” Supply the document URL, target Session, and connector identity together. Binding authorizes intake from that document's commenters, not additional business actions.

The first version supports docx documents and one target Session per document. It runs inside the existing connector; no additional consumer or scheduled AI polling Session is created. It accepts drive.notice.comment_add_v1 events through the existing WebSocket connection, durably queues them, and reads the bound document on demand, including solved threads and all pages. There is no periodic remote scan. Startup, reconnection, and newly declared bindings each trigger recovery reads. Failed admitted events use the existing durable inbox retry mechanism. Failed scans retain their checkpoints and retry; inaccessible targets are not silently replaced with a new Session.

The Agent uses the instance's existing configuration and authenticated API:

```sh
node scripts/feishu-document-bindings.mjs bind \
  --config /path/to/connector/config.json \
  --file-token DOCX_TOKEN --url https://tenant.feishu.cn/docx/DOCX_TOKEN \
  --session REVIEW_SESSION --base-url http://127.0.0.1:7696
```

`status` with the same config and token shows the target, last successful scan, error, and pending count. `unbind` disables future intake (an already admitted request remains in its Session). An existing binding is immutable: repeating `bind` preserves its cursor; changing its Session requires an explicit migration rather than quietly duplicating input.

Intake starts at binding time; historical comments are context, not automatically replayed requests. Subsequent edits are separate revisions. Each input includes author ID, document URL, quote, available anchor relation, and full comment-thread context. Missing/deleted anchor relations are not evidence of a current precise location. Images are not downloaded by this first version. The Agent can read the document using the provided token to resolve additional context.

The connector persists the exact pending message before admission and uses a deterministic request ID on retry. It filters its own Bot identity, including replies posted through the CLI as that Bot. Replies posted as a different user are not automatically recognizable as Agent output; use the bound Bot identity. Document inputs queue as separate turns instead of steering an active response. The connector does not post automatic document replies or mark comments resolved; the Agent uses the normal API to reply to the supplied comment ID. Its ordinary final response follows the Session's existing conversation delivery.

For recurring reviews, set `sessionTemplate.reuse` to `calendar_day` and `reuseTimezone` to an IANA zone through the existing schedule PATCH API. Occurrences with the same schedule and local date reuse the earliest execution Session and its topic. A new date creates a fresh Session. Existing morning occurrences can be adopted when enabling this policy mid-day. A publication workflow must bind each day's document to that day's execution Session. Neither binding nor schedule reuse changes document content or replaces comment anchors.

Verification should cover replay after lost admission acknowledgement, edits, own-reply suppression, full pagination, access failure, and actual human comments. Unit tests and a successful empty scan do not prove a human comment has completed an end-to-end reply.

The Feishu event follows recipient notification semantics; explicit local binding does not grant notifications for every accessible document. The bound Bot must receive comment notifications for that document. This deployment has previously received non-mention comments for the report documents. Comment edits have no confirmed dedicated event; they are discovered on later event/recovery reads or the regular review. A successful socket connection is not end-to-end validation of a new comment.

# Bind document comments to an existing conversation

Ask your Agent: “Bind this Feishu document to this review topic. Receive new comments and replies in its existing Session, reply in the original document comment, and maintain the document within our existing authorization.” Supply the document URL, target Session, and connector identity together. Binding authorizes intake from that document's commenters, not additional business actions.

The first version supports docx documents and one target Session per document. It runs inside the existing connector; no additional consumer or scheduled AI polling Session is created. It accepts drive.notice.comment_add_v1 events through the existing WebSocket connection, durably queues them, and reads the bound document on demand, including solved threads and all pages. Only received comment events trigger reads; startup, reconnection, and newly declared bindings do not scan documents. Queued automatic scans from older versions are archived locally without provider requests. Received events that have not finished retain their checkpoints and the existing durable inbox retry mechanism across restarts; inaccessible targets are not silently replaced with a new Session.

The Agent uses the instance's existing configuration and authenticated API:

```sh
node scripts/feishu-document-bindings.mjs bind \
  --config /path/to/connector/config.json \
  --file-token DOCX_TOKEN --url https://tenant.feishu.cn/docx/DOCX_TOKEN \
  --session REVIEW_SESSION --base-url http://127.0.0.1:7696
```

`status` with the same config and token shows the target, reply mode, last successful scan, error, and pending count. New bindings default to `replyMode: comment`: the completed answer goes to the original document comment through the existing durable source-delivery pipeline, while the Session retains its chat conversation and context. Chat progress is not posted to document comments. The Harness should not also send a comment reply manually in this mode. Document access and provider failures remain visible delivery failures; they do not fall back to posting in the chat.

Existing bindings without a reply mode retain the previous behavior. To migrate one, repeat the original `bind` command with `--reply-mode comment`. This changes only the policy for future inputs; it preserves the generation, intake start time, and seen/pending cursor, and does not replay historical comments or change already admitted requests. `--reply-mode conversation` keeps manual comment replies plus ordinary Session chat delivery for workflows that already depend on that behavior.

`unbind` disables future intake (an already admitted request remains in its Session). Repeating `bind` otherwise preserves the binding; changing its Session requires an explicit migration rather than quietly duplicating input.

Intake starts at binding time; historical comments are context, not automatically replayed requests. Subsequent edits are separate revisions. Each input includes author ID, document URL, quote, available anchor relation, and full comment-thread context. Missing/deleted anchor relations are not evidence of a current precise location. Images are not downloaded by this first version. The Agent can read the document using the provided token to resolve additional context.

The connector persists the exact pending message, source context, and reply destination before admission and uses a deterministic request ID on retry. It filters its own Bot identity, including replies posted through the CLI as that Bot. Replies posted as a different user are not automatically recognizable as Agent output; use the bound Bot identity. Document inputs queue as separate turns instead of steering an active response. Each input carries its document URL and handling rules, so refreshing a chat Session's instructions cannot erase the document-specific reply policy. Comments are not automatically marked resolved. Body updates remain the Harness's responsibility within the existing task authorization, with comment anchors preserved.

For recurring reviews, set `sessionTemplate.reuse` to `calendar_day` and `reuseTimezone` to an IANA zone through the existing schedule PATCH API. Occurrences with the same schedule and local date reuse the earliest execution Session and its topic. A new date creates a fresh Session. Existing morning occurrences can be adopted when enabling this policy mid-day. A publication workflow must bind each day's document to that day's execution Session. Neither binding nor schedule reuse changes document content or replaces comment anchors.

Verification should cover replay after lost admission acknowledgement, edits, own-reply suppression, full pagination, access failure, and actual human comments. Unit tests and a successful empty scan do not prove a human comment has completed an end-to-end reply.

The Feishu event follows recipient notification semantics; explicit local binding does not grant notifications for every accessible document. The bound Bot must receive comment notifications for that document. This deployment has previously received non-mention comments for the report documents. Comment edits have no confirmed dedicated event; they are discovered on later comment-event reads or an explicitly requested review. A successful socket connection is not end-to-end validation of a new comment.

# Feishu document comment replies


A docx has at most one fixed Session per Feishu connector. The binding is created by the first eligible comment or by an explicit bind. Once bound, the Session cannot be replaced; pausing intake retains the target. A missing or archived target is an error, not a reason to create another Session.

A comment or reply triggers the Bot only when that exact message explicitly @mentions it. This applies even in Bot-owned and explicitly bound documents, and after the Bot has already replied in the same thread. Ordinary comments and comments that only @mention someone else do not start work or get a reaction.

Newly created Bot-owned documents default to the Session that creates them. The instance's
`lark-cli` launcher records the creating Bot application, document token and
`REMOTELAB_SESSION_ID` from successful Bot creation responses. This durable
creation record is the default routing binding; the connector materializes its
binding on the first eligible mention. A Bot-owned document with no creating Session gets one on its first eligible mention. An unbound document the Bot does not own can also be bound by an eligible mention. The same Session is reused across comment threads and restarts. Automatic answers return to the thread that triggered them, including when the creator Session is a Web Session or uses a different Bot for chat.

Explicit existing bindings, disabled bindings and explicit creation targets win.
For an explicitly requested alternate target, set `REMOTELAB_DOCUMENT_SESSION_ID`
for the creation command; `none` leaves it without a target until the first eligible mention.
A missing recorded target is a repairable failure, not permission to silently
start another Session. No startup scans or scheduled AI jobs are added.

Harness processes receive `scripts/bin` first on PATH; Bash also inherits a launcher
function so login profiles cannot bypass registration by resetting PATH. For an older running Harness
or a shell that replaces PATH, use `node "$REMOTELAB_PROJECT_ROOT/scripts/lark-cli.mjs"`
in place of `lark-cli` when creating documents. Supported creation receipts are
`docs +create`, docx copy, Wiki docx node creation, and the raw docx/Wiki create
APIs. Keep the normal JSON result (including `identity`, `ok` and the new token).
The launcher preserves CLI output and exit status. If registration fails after
creation, it reports the failure on stderr; repair the existing document's route
instead of creating a second document. SDK/direct-HTTP publishers should call
`recordCreatedDocument` in `lib/feishu-document-creation.mjs` after successful Bot
creation, using the actual application and creating Session.

For automatic Bot-owned bindings, the connector checks current ownership when it receives a mention. Read/edit access alone does not qualify for that routing mode. Bot-owned historical documents need no creation record: the first eligible mention creates a document Session, without replaying old history. Changing ownership away from the Bot stops owned-document intake without replacing its binding. Existing explicit bindings retain their target.
Ownership/read failures are retained in the durable event inbox;
they do not create a replacement Session or claim a reply was delivered.

## Explicit review-topic binding

Ask your Agent: “Bind this Feishu document to this review topic. Receive comments and replies that @mention you in its existing Session, reply in the original document comment, and maintain the document within our existing authorization.” Supply the document URL, target Session, and connector identity together. Binding authorizes intake from that document's commenters, not additional business actions.

The first version supports docx documents and one target Session per document. It runs inside the existing connector; no additional consumer or scheduled AI polling Session is created. It accepts `drive.notice.comment_add_v1` events through the existing WebSocket connection. An eligible mention is durably queued and reads only the referenced thread, including its paginated replies. Earlier or later replies in that thread are context, not separate tasks. Startup, reconnection, newly declared bindings, and unmentioned comments do not query the document. Legacy queued scans without mention evidence are not replayed. Received mentions retain their checkpoints and bounded retries across restarts; inaccessible targets are not silently replaced with a new Session.

The Agent uses the instance's existing configuration and authenticated API:

```sh
node scripts/feishu-document-bindings.mjs bind \
  --config /path/to/connector/config.json \
  --file-token DOCX_TOKEN --url https://tenant.feishu.cn/docx/DOCX_TOKEN \
  --session REVIEW_SESSION --base-url http://127.0.0.1:7696
```

`status` with the same config and token shows the target, reply mode, last successful scan, error, and pending count. New bindings default to `replyMode: comment`: the completed answer goes to the original document comment through the existing durable source-delivery pipeline, while the Session retains its chat conversation and context. Chat progress is not posted to document comments. The Harness should not also send a comment reply manually in this mode. Document access and provider failures remain visible delivery failures; they do not fall back to posting in the chat.

Existing bindings without a reply mode retain the previous behavior. To migrate one, repeat the original `bind` command with `--reply-mode comment`. This changes only the policy for future inputs; it preserves the generation, intake start time, and seen/pending cursor, and does not replay historical comments or change already admitted requests. `--reply-mode conversation` keeps manual comment replies plus ordinary Session chat delivery for workflows that already depend on that behavior.

`unbind` pauses future intake (an already admitted request remains in its Session). Repeating `bind` with the same target resumes intake without resetting its cursor; specifying a different Session is refused. All bindings require an explicit mention; `--intake all` is no longer supported. Use `--intake mention` when adopting an existing comment Session for that same document. Old unbound per-comment Sessions are not merged or replayed.

Intake starts at binding time; historical comments are context, not automatically replayed requests. A subsequent edit does not trigger work on its own unless Feishu sends a qualifying mention event for it. Each input includes author ID, document URL, quote, available anchor relation, and full comment-thread context. Missing/deleted anchor relations are not evidence of a current precise location. Images are not downloaded by this first version. The Agent can read the document using the provided token to resolve additional context.

The connector persists the exact pending message, source context, and reply destination before admission and uses a deterministic request ID on retry. It filters its own Bot identity, including replies posted through the CLI as that Bot. Replies posted as a different user are not automatically recognizable as Agent output; use the bound Bot identity. Document inputs queue as separate turns instead of steering an active response. Each input carries its document URL and handling rules, so refreshing a chat Session's instructions cannot erase the document-specific reply policy. Comments are not automatically marked resolved. Body updates remain the Harness's responsibility within the existing task authorization, with comment anchors preserved.

For recurring reviews, set `sessionTemplate.reuse` to `calendar_day` and `reuseTimezone` to an IANA zone through the existing schedule PATCH API. Occurrences with the same schedule and local date reuse the earliest execution Session and its topic. A new date creates a fresh Session. Existing morning occurrences can be adopted when enabling this policy mid-day. A publication workflow must bind each day's document to that day's execution Session. Neither binding nor schedule reuse changes document content or replaces comment anchors.

Verification should cover replay after lost admission acknowledgement, edits, own-reply suppression, full pagination, access failure, and actual human comments. Unit tests and a successful empty scan do not prove a human comment has completed an end-to-end reply.

The Feishu event follows recipient notification semantics; explicit local binding does not grant notifications for every accessible document. Feishu may send non-mention notifications after a Bot participates in a thread; the connector ignores those. A successful socket connection is not end-to-end validation of a new comment.

For a qualifying mention, the connector reads the exact
comment ID through [batch query](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/batch_query)
and paginates its replies. This covers inline comments anchored to a selection
and whole-document comments. Feishu's single-comment GET only reads whole-document comments.
After accepting the request, the Bot immediately adds the Feishu `Get` (收到)
reaction to the exact comment or reply that mentioned it. It does not wait for
model output. The answer still returns in the original comment thread; a failed
reaction neither blocks nor replays the request.

When a Connector uses `accessPolicy.mode: "roles"`, document binding reconciliation
admits only provider subjects in that policy's exact HR or optional non-HR
collaborator list. Collaborator admission preserves existing document work without
classifying the person as HR or granting HR-specific business access. Interviewer and
unknown comments, including previously queued comments, are marked seen without
submitting them to the bound Session. Interviewer queries use the separate private
message route described in [role-restricted queries](feishu-bot-setup.md#role-restricted-application-queries).

# Feishu action choice and message presentation

## Choose the useful result from the user's goal

Decide during the normal task turn what the user needs to receive or use. The
user need not name a Feishu API, card, calendar, or task. Choose an office
action from the intended outcome and choose a display form from how the result
will be read. A resource action and a display form can be used together: a
calendar event is the commitment; a card can make its status easy to scan.
Create only the resources the request authorizes, and do not duplicate the
same answer across surfaces.

| User's actual need | Suitable action or display |
| --- | --- |
| Understand an answer, reasoning, comparison, or open-ended discussion | Reply normally; the bound Connector publishes rich-text `post`, or a mixed Markdown/native-table card for supported GFM tables. |
| Scan a compact status, decision, warning, or next action with a few stable fields | Consider a fixed status card even without an explicit card request. Use it when the header and concise body make the result materially easier to act on. |
| Put a real time commitment on a calendar | For a Bot-owned event, use `calendar.create` after resolving the calendar, time zone, start, and end; read back the event. For attendees or invitations use `lark-calendar`. A proposed time alone is a reply, not an event. |
| Assign or track a concrete follow-up | Use `task.create` with the intended owner and due date when known; read back the task. A discussion of possible next steps is a reply. |
| Maintain structured records or a reusable data source | Use the matching Base action and verify fields and permissions; use a view, form, or dashboard only when the user needs that interaction. |
| Preserve a long-lived, editable explanation | Use the document workflow and `feishu-doc-writing` component choices. |
| Feishu document comment | Reply in concise plain text; the comment API does not render Markdown. |
| Button, form, or other interactive card | Use the `lark-im` card workflow only when its callback handler and permissions are in place; a static status card does not provide this interaction. |

The fixed `card.send` action constructs card JSON in code from the selected
title, body, status, recipient, and stable key. It sends a separate message;
keep any companion reply brief and avoid repeating the card body. Bound Session
replies containing supported Markdown tables automatically become native table
cards within durable source delivery; other replies remain rich-text posts.
A card cannot stand in
for an actual calendar event, task, or Base record. `card.send` targets a user
or chat, not the source thread; do not move a thread result into the top-level
chat. Use the thread-aware `lark-im` workflow only when that placement and its
Bot permissions have been verified.

For a Session whose reply destination is a Feishu chat or thread, source
delivery automatically converts the final text or Markdown answer to a `post`,
or one JSON 2.0 card when it contains supported top-level GFM tables. Text and
native tables stay in order in the same message; no separate card send is needed.
Tables use content-based column widths, automatic row height and pagination.
See [rendering limits and fallback](../feishu-bot-setup.md#markdown-rendering).
The connector's local code handles Markdown, known mentions, code blocks, and
math; formulas may be rendered locally and uploaded as images. Delivery
notices use plain `text`. This conversion and the fixed office actions make no
second model request: the model's choice of action and content belongs to the
normal task turn, and the post-answer adaptation consumes no additional model
tokens. Do not run a separate model pass merely to restyle a finished answer.

This guide is discoverable through the platform skill index for Feishu message
and office tasks. Loading it supports the in-turn choice of action and display;
automatic reply formatting runs without loading this guide.

For common office work, run the shipped `remotelab feishu` actions. Each action is a
fixed `lark-cli` recipe: the Harness chooses an action and supplies data; it does
not rebuild the API call or card JSON on every turn. Every action forces Bot
identity. Specify the intended Bot profile explicitly.

```bash
remotelab feishu list
remotelab feishu contact.get --profile bot-2 --user-id <known-open-id>
remotelab feishu calendar.list --profile bot-2
remotelab feishu task.list --profile bot-2 --limit 10
```

The result is compact JSON. `message.send`, `card.send`, `reaction.add`,
`calendar.create`, and `task.create`
automatically read back the created resource and return `confirmed`.
They never retry a write after a failed readback. Use `--dry-run` to preview the
actual CLI request without sending it. Reuse the same `--key` when retrying the
*same* message/card/task request; use a new key for a new request.

## Fixed workflows

| Need | Action | Required data |
| --- | --- | --- |
| Known person | `contact.get` | `--user-id` |
| Text message | `message.send` | `--user-id` or `--chat-id`, `--text`, `--key` |
| Message readback | `message.get` | `--message-id` |
| Static status card | `card.send` | recipient, `--title`, `--body`, `--key`; optional `--status info|success|warning|error` |
| Emoji reaction | `reaction.add`, `reaction.list` | `--message-id`; add also needs `--emoji` |
| Bot calendar | `calendar.list`, `calendar.get`, `calendar.create` | create needs `--calendar-id`, `--summary`, `--start`, `--end` with timezone, `--key` |
| Bot task | `task.list`, `task.get`, `task.create` | create needs `--summary`, `--key`; optional due, assignee, tasklist |
| Base records | `base.records`, `base.upsert` | Base token, table ID; reads select 1–5 `--field` values; writes provide `--fields-json` and exactly one of `--create` or `--record-id` |

```bash
remotelab feishu card.send --profile bot-2 --user-id <known-open-id> \
  --title 'Daily status' --body 'Ready' --status success --key <stable-request-key>
remotelab feishu reaction.add --profile bot-2 --message-id <message-id> --emoji SMILE
remotelab feishu calendar.create --profile bot-2 --calendar-id <bot-calendar-id> \
  --summary 'Review' --start '2026-10-01T09:00:00+08:00' \
  --end '2026-10-01T09:30:00+08:00' --key <stable-request-key> --dry-run
remotelab feishu base.records --profile bot-2 --base-token <base-token> \
  --table-id <table-id> --field Name --field Status --limit 10
```

The card action uses a stored status-card template. Its caller passes text and
status, not card JSON. Button callbacks are a separate `card.action.trigger`
workflow: the current Connector handles its own discussion handoff cards, and
an arbitrary new button needs an explicit handler and Feishu callback setup.
A successful static card send does not establish that its buttons work.

Native Harness questions have a built-in Connector handler: the original
interactive question card accepts option buttons or a custom-answer form, then
updates in place on answer, timeout or cancellation. It never sends another
timeout reminder. Pending questions use an orange header labelled `请选择 · 单选`,
`请选择 · 多选`, or `请填写答案`, with a short instruction for submitting. Short
single-choice buttons share rows of two; long labels use full rows, and each
explanation stays with its option. Optional custom input stays collapsed and
uses a full-width input and a primary `提交答案` button; multi-select has its own
`提交选择` button. A user answer changes the original header to green `已回答`
and shows the answer, with the original question behind an expander. Native sync
confirmation shows its readable processing outcome on that same card, without
another success-status message. The raw choice and protocol ID remain in durable
records, while button labels omit the ID. Review results return in a detail card
with an original-work link and closed full-content panel; failures stay visible.
Required questions and substantive final answers remain separate. Timeout
fallback uses blue `已采用默认` (or `超时未答` without options), while cancelled
or ended questions use grey. Closed questions have no active answer controls.
These controls reuse the existing `card.action.trigger`
subscription; they do not turn arbitrary status cards into interactive forms.

Ordinary messages and forwarded references continue as task supplements while a
question is open. Only a valid numbered shortcut sent after the question opened
can answer it without a question ID. Use the card's custom-answer form for free
text; it binds the answer to that question. The Connector's Auto runtime snapshot
does not switch the active Harness when it delivers a supplement.

`base.upsert` takes a field map as task data, not generated API code. Use the
Base field list to confirm writable names and select options before writing;
`--create` explicitly creates a new record and must not be blindly repeated.
Calendar creation has an idempotency key and no automatic retry after readback.

## When no fixed action fits

Read `lark-cli skills read lark-shared` for the selected instance's profile,
then **one** matching domain skill. Prefer a `+shortcut`, then a typed command;
use `lark-cli api` only if the installed CLI has no matching command. Keep Bot
identity explicit with `--as bot`; do not switch to a person's token to fill a
Bot permission gap. Use `--jq`, bounded pages and field projection for compact
results. A known `open_id` is readable as Bot; the installed
`contact +search-user` keyword search is user-only.

| Other need | Domain skill |
| --- | --- |
| Group/thread management, interactive card actions | `lark-im` |
| Free/busy, rooms, complex calendar rules | `lark-calendar` |
| Task lists, comments, reminders | `lark-task` |
| Base fields, views, forms, dashboards | `lark-base` |
| Sheets, Drive, Docx, Wiki | `lark-sheets`, `lark-drive`, `lark-doc`, `lark-wiki` |
| Meetings, Minutes, approvals, OKRs | `lark-vc`, `lark-minutes`, `lark-approval`, `lark-okr` |

For long Feishu document writing, use the installed `long-form-output` and
`feishu-doc-writing` skills before `lark-doc`. A Feishu discussion thread and a
RemoteLab Session are different objects; Session handoff uses
`remotelab session-spawn --guide`.

The Feishu Connector transports events and replies. General Feishu office APIs
run through the instance's `lark-cli`; an empty `remotelab connector list` does
not mean Bot office APIs are unavailable. On failure, check profile, Bot scope,
contact visibility, resource ACL and returned API code separately. For a missing
Bot application scope use
[`feishu-auth-request`](../../skills/feishu-auth-request/SKILL.md). Do not print
App Secrets or tokens.

### Foldable work process

Existing progress-card buttons also produce usage observations without saving personal defaults. Read signals, per-user click counts, collection coverage and the authenticated analysis endpoint are documented in [Feishu card engagement](../feishu-card-engagement.md). A read receipt is a signal, not proof that someone read the content carefully.

In Feishu conversations with progress cards enabled, ordinary progress updates the original card. Latest and previous progress share one 工作过程 panel that the reader can expand or collapse directly, as in Web. The executing Harness chooses the initial expansion from the task: use `assistant-message --progress-mode expanded|collapsed --compact --json`, optionally with the initial checklist. Start expanded when showing the work path is useful, collapsed for a routine result. Required decisions, exceptional risks, questions and final results retain separate notifications; they are not expansion criteria. No personal habit or extra model call is involved. `/progress expanded|collapsed` is an optional explicit override for this Run. Older messages/card/default commands remain accepted as expansion aliases. Without a progress card, useful progress still sends messages.


An ended progress stream shows execution and final-reply delivery separately.
It reports sending, cancelled, failed, unconfirmed or delivered from the final
answer's durable receipts, including all declared text/file parts. A completed
Run or an earlier progress receipt cannot claim that the final answer arrived.

### Bot-created document comment routing

Create Bot docx documents through the instance `lark-cli` launcher so their creation
receipt records the current Session. On older running Harnesses or shells that
replace PATH, invoke `node "$REMOTELAB_PROJECT_ROOT/scripts/lark-cli.mjs"` with the
same CLI arguments. Keep normal JSON output. Unless the user explicitly specifies
another target, inherit `REMOTELAB_SESSION_ID`; an explicit alternative uses
`REMOTELAB_DOCUMENT_SESSION_ID=<session-id>` and an explicitly unbound document uses
`REMOTELAB_DOCUMENT_SESSION_ID=none`. Do not add a scheduled scanner or an extra
manual comment reply. The existing connector handles received comments and sends
the final answer to the original comment. See [document comment routing](../feishu-document-bindings.md)
for supported receipts, direct SDK registration, explicit bindings and failures.

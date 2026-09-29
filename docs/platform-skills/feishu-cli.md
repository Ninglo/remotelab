# Feishu actions and message presentation

## Reply presentation: automatic path and when to use a card

For a Session whose reply destination is a Feishu chat or thread, write the
answer once as normal text or Markdown. Source delivery automatically converts
that answer to a Feishu `post` rich-text message. The connector's local code
handles Markdown, known mentions, code blocks, and math; formulas may be
rendered locally and uploaded as images. This conversion does **not** make a
second model request or consume additional model tokens. It is already wired
into the Feishu Connector, so do not call `remotelab feishu card.send` merely
to format an ordinary answer.

| Situation | Presentation path |
| --- | --- |
| Ordinary answer, explanation, list, or short progress update in a Feishu chat/thread | Reply normally; the bound Connector publishes `post` automatically. |
| Feishu document comment | Reply in concise plain text; the comment API does not render Markdown. |
| Connector delivery notice | The Connector publishes plain `text` automatically. |
| A separately requested, compact status or alert that benefits from a colored header | Use the fixed `card.send` action with an explicit recipient, title, body, status, and stable key. This creates a separate message. |
| A button, form, or other interactive card | Use the `lark-im` card workflow only after the callback handler and permissions are in place; a static status card does not provide this interaction. |
| A lasting long-form document | Use `feishu-doc-writing` and `lark-doc`; a chat card is not a document. |

Use a status card when the user requests a card or a distinct, compact status
artifact; keep normal conversational results in the reply. The fixed card
template constructs card JSON in code from the supplied fields. Sending that
card does not itself call a model, but choosing and composing those fields
during a model turn has the ordinary input/output cost of that turn. There is
no automatic post-answer model pass to restyle a reply as a card.

This guide is discoverable through the platform skill index for Feishu message
and card tasks. Loading it is for deciding whether a separate Feishu action is
needed; automatic reply formatting runs without loading this guide.

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

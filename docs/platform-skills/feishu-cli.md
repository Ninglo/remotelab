# Feishu actions

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

The result is compact JSON. `message.send`, `card.send`, and `reaction.add`
automatically read back the created message or reaction and return `confirmed`.
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
| Bot calendar | `calendar.list`, `calendar.get`, `calendar.create` | create needs `--calendar-id`, `--summary`, `--start`, `--end` with timezone |
| Bot task | `task.list`, `task.get`, `task.create` | create needs `--summary`, `--key`; optional due, assignee, tasklist |
| Base records | `base.records`, `base.upsert` | Base token, table ID; reads also select 1–5 `--field` values; writes provide `--fields-json` |

```bash
remotelab feishu card.send --profile bot-2 --user-id <known-open-id> \
  --title 'Daily status' --body 'Ready' --status success --key <stable-request-key>
remotelab feishu reaction.add --profile bot-2 --message-id <message-id> --emoji SMILE
remotelab feishu calendar.create --profile bot-2 --calendar-id <bot-calendar-id> \
  --summary 'Review' --start '2026-10-01T09:00:00+08:00' \
  --end '2026-10-01T09:30:00+08:00' --dry-run
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
without `--record-id`, that action creates a new record and must not be
blindly repeated. Calendar creation also has no automatic retry.

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

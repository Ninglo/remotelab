# Feishu CLI

Use this guide for direct lark-cli access to Feishu resources. The Feishu Connector carries messages into
RemoteLab Sessions; it is not a second client for general Feishu OpenAPI work.

## Choose one workflow

1. Read `lark-cli skills read lark-shared` for the current instance's profile and
   Bot/User identity. Honor an owner's explicit Bot-only policy; never silently
   switch to a person's token.
2. Read **only the domain skill needed for this action**. For an action crossing
   domains, add only those domains it actually uses. Do not preload IM, Docs,
   and Base for every Feishu request.
3. Prefer a `+shortcut`, then a typed resource command. Use `lark-cli api` only
   if the installed CLI has no matching command; then read
   `lark-openapi-explorer` and the official endpoint definition.

| Intent | Skill | First command to inspect |
| --- | --- | --- |
| Resolve a person or department | `lark-contact` | `lark-cli contact --help` |
| Send/read messages, groups, cards, reactions | `lark-im` | `lark-cli im --help` |
| Events, free/busy, rooms | `lark-calendar` | `lark-cli calendar --help` |
| Tasks and task lists | `lark-task` | `lark-cli task --help` |
| Base records, forms, dashboards | `lark-base` | `lark-cli base --help` |
| Spreadsheet cells and workbooks | `lark-sheets` | `lark-cli sheets --help` |
| Drive files, folders, ACL | `lark-drive` | `lark-cli drive --help` |
| Docx content or comments | `lark-doc` | `lark-cli docs --help` |
| Wiki hierarchy | `lark-wiki` | `lark-cli wiki --help` |
| Meetings, Minutes, approvals, OKRs | Matching `lark-vc`, `lark-minutes`, `lark-approval`, or `lark-okr` | `lark-cli <domain> --help` |

For long Feishu document writing, first follow any installed `long-form-output`
and `feishu-doc-writing` skills to choose content and layout, then use `lark-doc`
for the actual document operation. A Feishu discussion thread and a RemoteLab
Session are different objects; for a new Session handoff read
`remotelab session-spawn --guide`.

## Identity and action examples

The following are **Bot-owned or Bot-visible** examples, not shortcuts to a
person's private resources. Replace placeholders and inspect the one selected
command's `--help` before writing.

```bash
lark-cli --profile <profile> whoami --as bot
lark-cli --profile <profile> contact +get-user --user-id <known-open-id> --as bot --jq '{ok,user:{name:.data.user.name,open_id:.data.user.open_id}}'
lark-cli --profile <profile> calendar calendars list --as bot --jq '{ok,calendars:[.data.calendar_list[]? | {calendar_id,summary}]}'
lark-cli --profile <profile> task tasks list --as bot --page-size 10 --jq '{ok,items:[(.data.items // .data.tasks // [])[] | {guid,summary}]}'
```

For a requested Bot message, inspect `lark-cli im +messages-send --help`, send
once, and check the returned ID instead of inferring delivery from exit status:

```bash
lark-cli --profile <profile> im +messages-send --as bot --user-id <known-open-id> --text '<message>' --idempotency-key <unique-key> --jq '{ok,message_id:.data.message_id,chat_id:.data.chat_id}'
lark-cli --profile <profile> im +messages-mget --as bot --message-ids <message-id> --jq '{ok,messages:[.data.messages[] | {message_id,chat_id,msg_type,content}]}'
```

- A known `open_id` can be read as Bot. The installed `contact +search-user`
  keyword search is user-only; do not use it as an implicit Bot fallback. For
  an email/phone supplied by the caller, the Bot `batch_get_id` API may resolve
  the ID if its exact scope and contact data range are granted.
- `calendar calendars list --as bot` and `task tasks list --as bot` concern the
  Bot's calendars and tasks. They do not expose a person's calendar or tasks.
- A static interactive message card uses IM sending. Updating an issued card's
  entity or elements uses CardKit; button handling also needs a configured
  callback. Reactions and message delivery need separate readback checks.
- Keep large output out of the model context: use `--jq` to select needed
  fields, a bounded `--page-size`, and a single domain's command help. For a
  write, use `--dry-run` where supported, send once with an idempotency key if
  available, then read back the returned resource ID.
- A resumed Feishu Session normally receives group messages after its previous
  admitted message; a failed boundary lookup falls back to full history. For a
  request about older conversation, use
  `lark-cli im +chat-messages-list --help` and query the specific chat or thread.

## Permission or delivery failure

Check the selected profile, token identity, installed command schema, published
scope, contact data range, and resource ACL separately. A successful API call
does not prove that a card callback fired or a message reached its intended
conversation. For a missing Bot scope use
[`feishu-auth-request`](../../skills/feishu-auth-request/SKILL.md). The
`scopes/apply` API only covers scopes already configured in the app; the
dedicated `/page/scope-apply` page is for adding a new application scope.
Do not print App Secrets or tokens.

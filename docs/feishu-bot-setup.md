# Feishu Bot Setup Contract (Prompt-First)

This document is the rollout contract for asking an AI agent on the RemoteLab machine to wire a Feishu connector.

The human should mostly stay in one conversation with that agent, hand over the needed context in one concentrated round, and only leave the chat for explicit `[HUMAN]` console or client steps.

## Copy this prompt

```text
I want you to set up a RemoteLab-backed Feishu bot on this machine.

Follow `docs/feishu-bot-setup.md` in this repository as the setup contract.
Keep the workflow inside this chat.
Before doing work, collect every missing input in one message so I can answer once.
Do every automatable step yourself.
After my reply, continue autonomously and only stop for true `[HUMAN]` steps or final completion.
When you stop, tell me exactly what I need to click or send, and how you'll verify the next state afterward.
```

## Outcome

By the end of this flow you should have:

- one self-built Feishu app bot
- one subscribed inbound event: `im.message.receive_v1`
- one local `feishu-connector` using persistent connection
- one working private-chat validation path
- RemoteLab sessions created or reused behind the bot
- AI-generated RemoteLab attachments delivered back to the originating Feishu conversation

This rollout stays intentionally narrow at first:

- self-built app bot, not a custom group webhook bot
- same-tenant rollout first, not cross-tenant distribution
- private chat first, group support later
- persistent connection / long connection, not public webhook mode
- reply handling supports text, inbound images/rich posts, and outbound AI-generated file/image attachments

## One-round input handoff

The AI should try to confirm the whole packet below in one early exchange.

- region: `feishu-cn` for `open.feishu.cn` or `lark-global` for `open.larksuite.com`
- the first validation user is in the same Feishu tenant as the app
- which RemoteLab session tool should back the bot by default
- whether V0 should start with `all` or `whitelist`

If the app does not exist yet, the AI should tell the human in one pass which console outputs it will need back later, rather than asking for them one at a time.

## [HUMAN] steps

1. Create a self-built Feishu app.
2. Enable the app's bot capability.
3. Open the minimum IM read and send permissions needed for private chat, plus `im:resource` (获取与上传图片或文件资源).
4. Subscribe only `im.message.receive_v1` under Tenant Token-Based Subscription.
5. Choose persistent connection / long connection as the inbound mode.
6. Add the first tester to app availability scope and publish or apply the current version.
7. Send the AI this handoff payload:

```text
Feishu bot setup ready.

App ID: ...
App Secret: ...
Region: Feishu CN / Lark Global
Subscribed event: im.message.receive_v1
My user is in app availability scope: yes / no
I can already search the bot in Feishu: yes / no
```

8. After the AI reports the connector is online, send a private test message to the bot.

Prefer one Feishu-console visit that covers app creation, permissions, event subscription, persistent connection mode, availability scope, and publish/apply before returning to the AI.

## Important human-side notes

- Start with same-tenant private chat; do not start with cross-tenant distribution.
- If the console warns `No connection detected`, let the AI bring the connector online first, then return and save persistent connection mode again.
- If outbound later fails with Feishu error `99991672`, enable the exact IM send permission named in the error message.
- Reply images must be no larger than 10 MB; other reply files must be no larger than 30 MB. Larger images are sent as ordinary files when they fit the 30 MB file limit.
- If you want the bot to add a quick “I’m looking” reaction before the real reply lands, also enable `发送、删除消息表情回复 (im:message.reactions:write_only)`.

## AI execution contract

- ensure the RemoteLab chat server is running at `http://127.0.0.1:7690`
- front-load all missing context and expected return payloads so the human can finish the console work in as few interruptions as possible
- create `~/.config/remotelab/feishu-connector/config.json`
- run `npm run feishu:ops -- discover`, then use `npm run feishu:ops -- restart --bot <bot-id>` so the recorded config and runtime owner select the exact connector
- use `npm run feishu:check -- --watch 15` and the connector logs to validate inbound and outbound behavior
- keep the rollout inside this conversation; when a console fix is required, pause with a precise `[HUMAN]` instruction
- if V0 succeeds, optionally suggest widening availability or switching from `all` to `whitelist`

## Fast operator commands

Use the built-in ops wrapper when you need a short, repeatable troubleshooting loop instead of ad-hoc shell steps.

```bash
npm run feishu:ops -- discover
npm run feishu:ops -- list
npm run feishu:ops -- status
npm run feishu:ops -- restart
npm run feishu:ops -- backfill --count 2 --tool micro-agent --model gpt-5.4 --effort low
```

Notes:

- `status` shows the active runtime, whether the connector process is up, the latest inbound event, and recent text messages that were recorded as `silent_no_reply`
- `restart` refreshes the Bot registry, uses the exact recorded systemd unit when present, and otherwise passes the selected config to the local instance helper
- `backfill` creates a fresh reply session and drafts a catch-up reply for recent silent text messages; add `--dry-run` to inspect the target and prompt without sending
- if `backfill` fails with `Bot/User can NOT be out of the chat`, the bot is no longer in that chat, so the draft exists but Feishu will refuse delivery until the bot is added back

### Harness-side Feishu CLI access

RemoteLab does not expose document or Wiki reads as connector tools. The four
former commands (`document_get`, `wiki_node_get`, `wiki_children_list`, and
`wiki_tree_list`) and their local capability server are not part of the product
surface.

The harness uses the package-provided `lark-cli` directly through normal shell
tools. RemoteLab, the Feishu connector, and every harness launched for the Bot
run inside the same instance runtime cell: one OS user, one home directory, one
environment contract, and one instance-owned lark-cli config directory. The
connector initializes that config from its existing Bot credentials at startup;
the App Secret is never copied into a prompt.

RemoteLab does not pin the CLI to Bot identity or reset the owner's default.
The harness can inspect authorized identities and follow the CLI's
version-matched workflow before using any Feishu capability:

```bash
lark-cli profile list
lark-cli auth status --json --verify
lark-cli skills read lark-doc
lark-cli docs +fetch --doc <docx-or-wiki-url>
```

This is not an API proxy or a handwritten permission bridge. `lark-cli` talks
to Feishu directly with the selected Bot or user identity's actual authorization, so adding Base,
Doc write, Sheets, Drive, or another supported capability does not require a
new RemoteLab connector tool. The real security boundary is the instance's OS
user and filesystem sandbox; sibling Bot instances do not share profiles.
User access requires a user to authorize the app; receiving a message from that
person does not supply their user token. A user login belongs to the instance,
not automatically to each sender in a group. For legacy deployments explicitly
authorized to remove the former Bot-only policy, use the CLI's
`config strict-mode off --global` and `config default-as auto` in that instance.
Connector startup preserves these choices rather than reapplying restrictions.

### Multiple Bot discovery and targeted maintenance

Keep each Bot in its own config and state directory. The legacy default remains:

```text
~/.config/remotelab/feishu-connector/config.json
```

Additional Bots are discovered from:

```text
~/.config/remotelab/feishu-connectors/<bot-id>/config.json
```

Run discovery after adding a Bot. It records the Bot ID, config path, state
directory, and current process or systemd owner in
`~/.config/remotelab/feishu-bots.json`. The registry contains only an App ID
fingerprint, never the App Secret.

```bash
npm run feishu:ops -- discover --json
npm run feishu:ops -- status --bot bot-b
npm run feishu:ops -- restart --bot bot-b
```

For a config outside the standard directories, register it explicitly once:

```bash
npm run feishu:ops -- discover --config /srv/remotelab/bot-b/config.json
```

Before every Bot-targeted `status` or `restart`, discovery refreshes the
registry. A systemd-managed Bot is restarted through its exact recorded unit.
A macOS launchd-managed Bot is restarted through its exact LaunchAgent label,
with the legacy unload/load path retained as a fallback.
A directly managed Bot is restarted through its exact config path and
`storageDir`. If more than one runtime owner matches a config, restart fails
closed as ambiguous instead of choosing a process.

With no `--bot` or `--config`, the legacy `default` Bot is preferred. If no
valid Bot named `default` exists and exactly one valid Bot is discovered, that
single Bot is selected automatically. Multiple valid Bots still require an
explicit selector.

## Config contract

```json
{
  "appId": "cli_xxx",
  "appSecret": "replace-with-real-secret",
  "region": "feishu-cn",
  "loggerLevel": "info",
  "chatBaseUrl": "http://127.0.0.1:7690",
  "sessionTool": "codex",
  "systemPrompt": "You are the operations Bot. Prioritize operations context and workflows relevant to this Bot.",
  "accessPolicy": {
    "mode": "all"
  },
  "responsePolicy": {
    "group": "mention_only"
  }
}
```

Notes:

- use `feishu-cn` for `open.feishu.cn`
- use `lark-global` for `open.larksuite.com`
- omit `sessionFolder` to use the operator's home directory by default
- `systemPrompt` is the Bot's lightweight profile. The matching Session stores
  it and passes it into the harness when the Session context is initialized;
  use it to name the Bot's role, activate relevant context, and guide behavior
- a Bot prompt is an attention/context boundary; the instance runtime cell is
  the host security and capability boundary
- the connector initializes the instance-owned `lark-cli` app credentials
  without overriding identity policy or defaults; RemoteLab makes the packaged
  binary and that same config visible to harness processes
- `botId` / `sourceRouteId` remains transport addressing so replies, Topics and
  deferred results return through the Bot that owns the originating conversation
- every admitted chat message receives a persistent `THINKING` reaction before
  RemoteLab submission; this acknowledgement is fixed product behavior rather
  than a third policy dimension, and failure to add it never blocks the request
- the connector forwards mostly the rendered user message plus mention-token hints, not a large blob of transport metadata
- `accessPolicy.mode` defaults to `all`; use `whitelist` when only selected senders may use the Bot

These are the only two message policies. `accessPolicy` decides who may use the
Bot. `responsePolicy.group` defaults to `mention_only`: group messages require an
explicit mention of this Bot to start a conversation. Once the Bot has joined a
thread, human replies in that same thread need no further mention and continue
its existing Session. Participation is persisted per Bot and thread, including
threads created by a Bot reply; it survives connector restarts. Other threads
and ordinary group chatter still require a mention. An existing group Session,
quoting a message outside a thread, mentioning another user, or `@all` cannot
activate a thread. Set the policy to `all` to accept every human group message.
Private messages are always admitted immediately after access control.
The response filter runs before commands, reactions, attachments and AI submission,
including stored-message replay. Mention matching uses the Bot's API identity.
Thread continuation never bypasses sender access control or Bot loop protection.
Access and response policies apply to the whole Connector. Session-start routing
can separately be overridden per group with `sessionPolicy` below.

### Harness and model commands

Runtime selection has two levels. `Default` is copied when a new Session is
created; an existing Session keeps its own snapshot until explicitly changed.
Inside an existing task thread or private conversation, use these commands:

| Command | Behavior |
| --- | --- |
| `/status` | Show the Harness, model and effort in the current scope. |
| `/default` or `/default <harness\|model\|effort> <value>` | Show or change the Default used by new Sessions. |
| `/harness` or `/harness <id>` | List available Harnesses or change the current Session. |
| `/model` or `/model <id>` | List the current Harness's models or change the current Session. |
| `/effort` or `/effort <level>` | List supported reasoning levels or change the current Session. |
| `/follow` | Compatibility alias: copy the current Default into this Session. |
| `/mute` | Stop automatic responses in the current topic or chat; explicit mentions still wake the Bot once. |
| `/unmute` | Restore the original response behavior in that topic or chat. |
| `/help` | Show these commands and `/fork` / `/continue`. |

Selecting any runtime option updates the complete Harness/model/effort snapshot
for subsequent Feishu messages in that Session. Selecting a different Harness
uses its own default model and effort; selecting a different model uses that
model's default effort. Invalid choices leave the current configuration intact.
Lists and `/status` are read-only. In a group with mention-only responses, mention
the Bot unless it has already joined the current thread.

Control commands execute directly without launching an AI turn or creating a
task. `/default ...` changes only the shared Default. The other setters change
only an existing Session; a group main timeline must first create a task with
`/fork <任务文本>` when no Session is bound. Peer Bots cannot invoke these
control commands.

When a connector creates a new Session, its selected Harness/model/effort is
written as part of Session creation and sent with the first prompt. There is no
separate "set effort, then send the task" step. Running and already queued
Requests retain the selection frozen at admission. The Inbox saves a setter's
exact plan before applying it, so retries do not re-resolve changing Defaults.

### Mute a discussion

Send `/mute` in a task thread to stop ordinary discussion messages from starting
AI turns. The Connector drops these messages before processing reactions,
attachment downloads, Session creation and model submission. It still records
normal transport receipts. Existing running or queued tasks continue and can
deliver their results.

An explicit mention of this Bot wakes it for that input only; the conversation
stays muted afterwards. Local settings commands and explicit `/fork` or
`/continue` tasks remain usable under the usual access/mention rules. `/unmute`
restores normal response routing and never replays skipped discussion. `/status`
shows the mute setting. If several Bots share a thread, address a settings
command as `@Bot /mute` to select one; other Bots ignore that addressed command.

Mute defaults to off and is persisted in the Connector's `conversation-settings`
store, keyed by Bot route, tenant, chat and topic identity. It does not require an
AI Session. Sibling topics and other Bots retain their own settings. On a group
main timeline `/mute` affects that timeline only; individual topics remain
separate. In a private chat it affects that private conversation. Peer Bots
cannot change these settings, and their explicitly mentioned handoffs retain
the existing durable loop limits.

### Default fork and one-shot Bot handoffs

To preserve different groups' working habits, ask your agent:
“Set the Connector default to Continue, but use Fork for these group chat IDs: … .
Keep explicit commands and bound-thread continuation unchanged; do not deploy
or restart another instance.” Provide the target Connector and exact chat IDs
in that same request. The agent should validate and edit its config, then reload
by restarting only that Connector when rollout is authorized.

```json
{
  "sessionPolicy": {
    "defaultMode": "continue",
    "groups": {
      "oc_example_fresh_tasks": "fork",
      "oc_example_shared_context": "continue"
    }
  }
}
```

Only `fork` and `continue` are accepted; invalid modes fail config loading.
Precedence: explicit `/fork` or `/continue` → existing thread binding → exact
chat-ID override → Connector default. Omitting the policy keeps the current
`fork` default. `continue` uses the existing group/topic route (creating its
Session if absent), not the most recently created fork. Changing this policy
never moves or deletes existing Sessions; private chats, document comments,
access control and Bot handoff loop protection are unchanged.

- A new group task (including an unbound topic/thread) creates a blank Session
  by default and replies in a Feishu thread. It does not copy group history.
- Human follow-ups in a bound thread reuse that Session. A case-insensitive
  `/fork` marker anywhere in a group message explicitly starts another blank
  Session, including inside an existing thread. Leading mentions, rich-text
  formatting and surrounding whitespace do not affect detection. All `/fork`
  occurrences are removed and the remaining text becomes the task. This is a
  literal marker: quoting or discussing `/fork` also triggers it, and it takes
  precedence over other commands in the same message. Normal access and mention
  rules still apply; the marker does not enable forks in private chats.
- `/continue <task>` opts out of the default fork: use the existing thread
  binding, or the legacy group/topic Session route when there is no binding.
  Ordinary human private messages and document comments keep their prior routing.
- Other Bots (`app` / `bot` senders) may hand off a task only with an explicit
  mention of this Bot, even under `group: all`. Self messages remain ignored.
  Sender access control still applies; a mention does not bypass the whitelist.
  Admitted Bot messages use the same session and reply-location routing as human
  messages. Bot identity never forces a thread reply; only the shared fork/thread
  rules do so.
  **Feishu-console prerequisite:** enable and publish
  `im:message.group_at_msg.include_bot:readonly` (receive user/Bot mentions).
  The broader `im:message.group_msg.include_bot:read` also delivers Bot events,
  but is not needed just for handoffs. Ordinary `group_at_msg` / `group_msg`
  permissions only deliver user messages; changing local filtering cannot fix
  a missing upstream permission. See [Feishu's receive-event contract](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive).
- All peer Bots share **one admission per Session/thread**, not one per sender.
  Once used, later Bot events in that thread are silently ignored, including
  `/fork` and command-usage requests; humans can continue normally. The same
  bound Session cannot regain its allowance through another thread alias.
- Admission is reserved durably before reactions or AI submission. Retries of
  the same upstream event retain their reservation and use the existing request
  ID; connector restarts and human forks do not reset a thread's allowance.
  Source/root/parent messages, delivered replies, and returned thread IDs all
  retain the consumed quota in `storageDir/bot-handoffs/`. Preserve this directory
  with Inbox and delivery receipts during backup/migration; do not clear it to retry.

For an instance whose peer Bots are intentionally repeated task triggers, set
`"botHandoffPolicy": "unlimited"` in its connector config. The default is
`"once_per_session"`. This setting changes only the admission quota: self-message,
explicit-mention and sender-access checks still apply, as does normal session
routing. Existing quota records are retained, including when the default is
restored. Use the default for Bots that can reply to one another.

The default bounds Bot interaction within a Session/thread, not unrelated new top-level
messages. Verify a real peer-Bot mention after enabling the permission; local
admission tests alone do not prove platform event delivery.

### Markdown rendering

The model can emit ordinary Markdown. The connector sends adjacent Markdown
lines together in a single `post` / `md` element so GFM tables, numbered lists,
task lists, and block quotes retain their structure. Thread replies and normal
chat messages use the same renderer; no table-specific prompt or Skill is needed.
Known mentions become Feishu's inline `<at user_id="...">...</at>` extension,
including inside table cells. Native `at` elements must not share a paragraph
with `md`. Fenced code and rendered formula images remain separate native blocks.

See the [official message content contract](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json).
Some Markdown styles require a recent Feishu client. Tables need blank lines
around them, and Feishu does not support nested tables or images inside table cells.

### Formula rendering

Feishu replies support standard LaTeX delimiters: `\(...\)` or `$...$` for
inline math, and `\[...\]` or `$$...$$` for display math. The connector
validates formulas with MathJax. Compact inline expressions are emitted as
Unicode inside one Markdown element; complex inline expressions and display
formulas are rendered to PNG, uploaded through Feishu's message-image API, and
inserted into the rich-text reply. Identical formulas reuse an in-process
content-hash cache. If parsing, rendering, or upload fails, the complete LaTeX
source is preserved as readable text instead of sending a partially converted
formula.

## Success state

- the connector log contains `persistent connection ready`
- the tester can search the bot and open a private chat
- an inbound message reaches RemoteLab
- RemoteLab creates or reuses the matching session
- the bot sends a reply back into Feishu
- AI-generated Attached files arrive as native Feishu image/file messages in the same private chat, group, or topic thread

## After V0

- widen the same-tenant availability scope
- validate searchability for another coworker
- add group support only after private chat is stable
- treat cross-tenant distribution as a later marketplace or distributable-app phase

## Related internal docs

If you need deeper implementation or rollout context after the setup is working:

- `notes/feishu-bot-connector.md`
- `notes/feishu-bot-operator-checklist.md`
- `notes/feishu-bot-setup-lessons.md`
- `docs/external-message-protocol.md`

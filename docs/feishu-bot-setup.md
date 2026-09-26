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
Bot. `responsePolicy.group` defaults to `mention_only`: ordinary group messages
require an explicit mention of this Bot to start a conversation. Native Feishu
topic groups default to `all`, because each topic is already an intentional AI
conversation surface. An exact `groups[chatId].responseMode` override can narrow
a topic group back to `mention_only` or widen an ordinary group to `all`.

Once the Bot has joined a Thread in an ordinary group, human replies in that
same Thread need no further mention and continue its existing Session.
Participation is persisted per Bot and Thread, including Threads created by a
Bot reply; it survives connector restarts. Other Threads and ordinary group
chatter still require a mention. An existing group Session, quoting a message
outside a Thread, mentioning another user, or `@all` cannot activate a Thread.
Private messages are always admitted immediately after access control.
The response filter runs before commands, reactions, attachments and AI submission,
including stored-message replay. Mention matching uses the Bot's API identity.
Thread continuation never bypasses sender access control or Bot loop protection.
Access and response policies apply to the whole Connector. Session-start routing
can be overridden per group with `groups` below.

### Harness and model commands

Every new Standard Session starts from Auto. An existing Session keeps its own
runtime snapshot until explicitly changed.
Task commands use one primary reply action, optional modifiers, then task text.
The short mobile-friendly form is `/thread task text`. Put `--harness`,
`--model`, and `--effort` before the task text when needed. The connector also
accepts the multi-line command block, with or without a blank line before the
task text. It parses the complete command shape first, rejects unknown,
duplicate, or conflicting commands, and only then applies it. A slash command
mentioned in ordinary prose is never executed.

Examples:

```text
/thread --harness codex --model gpt-5.6 --effort high 请分析这个问题并给出修复方案。
```

Multi-line form:

```text
/thread
/harness codex
/model gpt-5.6
/effort high

请分析这个问题并给出修复方案。
```

Inside an existing task thread or private conversation, use these commands:

| Command | Behavior |
| --- | --- |
| `/status` | Show the Harness, model and effort in the current scope. |
| `/log keywords or question` | Search historical Sessions and return up to 3 matches with titles, Session links and available LangSmith trace links. |
| `/harness` or `/harness <id>` | List available Harnesses or change the current Session. |
| `/model` or `/model <id>` | List the current Harness's models or change the current Session. |
| `/effort` or `/effort <level>` | List supported reasoning levels or change the current Session. |
| `/tier` or `/tier <sota\|quality\|balanced\|economy>` | List or change the current Session's model tier. |
| `/mute` | Stop automatic responses in the current topic or chat; explicit mentions still wake the Bot once. |
| `/unmute` | Restore the original response behavior in that topic or chat. |
| `/help` | Show these commands and the task-command format. |

`/log Auto Research 数据接入` searches titles, descriptions, work summaries and
visible user/assistant messages, including archived Sessions. Everything after
`/log` (including subsequent lines) is a literal search query, up to 1000 characters;
do not combine it with other commands. Ranking uses keyword relevance with extra
weight for titles and summaries, not recency. It returns at most three matches,
and distinguishes disabled uploading, Sessions outside collector coverage,
pending/waiting uploads, upload failures, unsupported historical dates or tools,
and empty histories. It does not start an AI run,
create a Session, publish traces, or restore automatic links on ordinary replies.

The authenticated `GET /api/sessions/search?q=...` endpoint uses the instance's
normal shared Session access. Internal helper Sessions, hidden blocks, reasoning
and tool output are excluded. A disposable index under
`CONFIG_DIR/cache/session-log-search/` stores term counts and event cursors;
subsequent searches index only new events. The first search on a large history
may need a retry while the index builds. Missing/corrupt indexes are rebuilt;
unreadable histories are reported as incomplete results. Existing LangSmith
snapshot links retain their normal LangSmith access requirements.

`langsmith-case-link.json` can optionally name a `historyStateDir` alongside
`stateDir` and `backfillStateDir`. Each directory is an instance-local basename
containing `state.json` for the configured `projectId`. Historical imports use
the same `sessions[id].latestSnapshot` shape as backfills, with
`kind: "historical_import"`; `/log` labels those links explicitly. Publish a
snapshot into this index only after verifying the uploaded content. Preserve
original execution dates inside historical imports and distinguish import time
from execution time. A bad source does not suppress a valid link from another
configured source.

`/inline` and `/thread` select reply topology; they do not copy or fork old
context. In an ordinary chat group, `/inline` uses the chat's long-lived main
Session and `/thread` creates a blank Session for a new Thread. A topic-mode
group is already a Thread surface, so it supports `/thread` but not `/inline`.
Inside an existing Thread, `/thread` is a harmless explicit restatement of the
fixed topology.

`/quick` is an independent execution-profile choice. It creates a Session with
the fixed Quick runtime at the location selected by the chat topology and
`replyPolicy`: ordinary groups may be inline or threaded, while topic-mode
groups always remain threaded. A new topic may therefore start with `/quick`
without conflicting with its Thread identity. An already-bound Standard
Session cannot be converted in place; start a new topic for a new Quick Session.
Only `/inline` and `/thread` accept `--harness <id>`, `--model <id>`, and
`--effort <level>` before the task text. Use a standalone `--` before task text
that itself starts with `--`.
The removed `/fork`, `/continue`, `/f`, and `/c` forms are ordinary text, not aliases.

Two frequent commands have explicit stable aliases. Aliases resolve to the
canonical name before validation and execution:

| Command | Alias |
| --- | --- |
| `/model` | `/m` |
| `/quick` | `/q` |

Aliases are opt-in rather than generated from the first letter, keeping the
command surface small and avoiding collisions. A path such as `/f/data` or
`/m/checkpoints/model.bin` remains ordinary task text; only an exact command or
alias followed by whitespace or end-of-line is parsed.

Selecting any runtime option updates the complete Harness/model/effort snapshot
for subsequent Feishu messages in that Session. Selecting a different Harness
uses its own default model and effort; selecting a different model uses that
model's default effort. Invalid choices leave the current configuration intact.
Lists and `/status` are read-only. In a group with mention-only responses, mention
the Bot unless it has already joined the current thread.

Command-only blocks execute directly without launching an AI turn or creating a
task. New Standard Sessions always start from Auto. Runtime setters change an
existing Session when one is bound, or apply to the one task in the same
command block. The next new Session starts from Auto again. Peer Bots cannot
invoke these control commands.

When a connector creates a new Session, its selected Harness/model/effort is
written as part of Session creation and sent with the first prompt. Auto is used
when no Session-local override was supplied. There is no
separate "set effort, then send the task" step. Running and already queued
Requests retain the selection frozen at admission. The Inbox saves a setter's
exact plan before applying it, so retries keep the admitted Session snapshot.

### Mute a discussion

Send `/mute` in a task thread to stop ordinary discussion messages from starting
AI turns. The Connector drops these messages before processing reactions,
attachment downloads, Session creation and model submission. It still records
normal transport receipts. Existing running or queued tasks continue and can
deliver their results.

An explicit mention of this Bot wakes it for that input only; the conversation
stays muted afterwards. Local settings commands remain usable under the usual
access/mention rules. `/unmute`
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

### Reply placement, Session topology, and one-shot Bot handoffs

Every chat has one long-lived main Session. Every Feishu Thread has one separate
Session. A message already inside a Thread always reuses that Thread's Session;
reply settings and commands cannot move it back to the mainline or split it.
The inbound message ID is only a delivery address and is never part of mainline
Session identity.

```json
{
  "responsePolicy": { "group": "mention_only" },
  "replyPolicy": {
    "group": "thread",
    "private": "inline",
    "chats": { "oc_example_shared_mainline": "inline" }
  },
  "groups": {
    "oc_example_recordings": {
      "responseMode": "all",
      "replyMode": "thread",
      "systemPrompt": "Process incoming recordings and discuss the results in this conversation."
    }
  }
}
```

`replyPolicy.group` defaults to `thread`; `replyPolicy.private` defaults to
`inline`. `replyPolicy.chats[chatId]` and `groups[chatId].replyMode` override the
default with `inline` or `thread`. `groups[chatId]` also supports
`responseMode` (`all`/`mention_only`) and an optional `systemPrompt`. Topic
groups use `all` when no exact chat override exists; ordinary groups fall back
to `responsePolicy.group`. The prompt is appended to global instructions when
creating a Session; existing Sessions keep their instruction snapshot.

Precedence is: topic-group or existing-Thread topology → explicit `/inline` or
`/thread` → exact chat-ID override → chat-type default. `/thread` starts a blank
Thread Session from an ordinary mainline and is idempotent inside a Thread; it
never copies the main Session history. `/inline` submits to the stable main
Session and is rejected in topic-mode groups or existing Threads. `/quick`
selects only the execution profile after that placement is resolved. Private
chats use the same model, although actual Thread publication still depends on
Feishu supporting Threads in that chat type.
`sessionPolicy`, `sessionMode`, `/fork`, and `/continue` are intentionally not
supported and fail configuration validation or remain ordinary message text.

- A mainline task follows the configured reply mode. `thread` creates a blank
  Thread Session; `inline` reuses the chat's main Session.
- Human follow-ups in a bound Thread always reuse that Session. A leading Bot
  mention may precede `/inline` or `/thread` on the mainline. Mentioning either
  command in ordinary prose does not execute it.
- Other Bots (`app` / `bot` senders) may hand off a task only with an explicit
  mention of this Bot, even under `group: all`. Self messages remain ignored.
  Sender access control still applies; a mention does not bypass the whitelist.
  Admitted Bot messages use the same session and reply-location routing as human
  messages. Bot identity never forces a Thread reply; only the shared reply
  routing rules do so.
  **Feishu-console prerequisite:** enable and publish
  `im:message.group_at_msg.include_bot:readonly` (receive user/Bot mentions).
  The broader `im:message.group_msg.include_bot:read` also delivers Bot events,
  but is not needed just for handoffs. Ordinary `group_at_msg` / `group_msg`
  permissions only deliver user messages; changing local filtering cannot fix
  a missing upstream permission. See [Feishu's receive-event contract](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive).
- All peer Bots share **one admission per Session/thread**, not one per sender.
  Once used, later Bot events in that thread are silently ignored, including
  reply-mode and command-usage requests; humans can continue normally. The same
  bound Session cannot regain its allowance through another thread alias.
- Admission is reserved durably before reactions or AI submission. Retries of
  the same upstream event retain their reservation and use the existing request
  ID; connector restarts and human messages do not reset a thread's allowance.
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

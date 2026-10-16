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
- subscribed inbound events: `im.message.receive_v1` and `im.chat.member.bot.added_v1`
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
4. Subscribe `im.message.receive_v1` and `im.chat.member.bot.added_v1` under Tenant Token-Based Subscription; use `card.action.trigger` for the group configuration controls.
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

### Group announcement context

New group topics/threads automatically read their group's announcement using
Bot scope `im:chat.announcement:read`. Bound discussion/work chats both use the
discussion chat announcement as their shared project context. Text and links are captured per topic;
subsequent replies reuse that snapshot and omit it from the model input after
confirmed Harness receipt. New topics read later edits. Empty, unreadable,
truncated and non-text content are marked explicitly. No announcement is edited.
See [topic announcement context](connector-turn-context.md#feishu-topic-announcements-2026-10-12)
for limits, legacy support, retries and existing-topic rollout behavior.

### Harness-side Feishu CLI access

RemoteLab does not expose document or Wiki reads as connector tools. The four
former commands (`document_get`, `wiki_node_get`, `wiki_children_list`, and
`wiki_tree_list`) and their local capability server are not part of the product
surface.

The harness uses fixed `remotelab feishu` actions for recurring office work;
each action invokes the package-provided `lark-cli` with Bot identity, compact
output, and readback where supported. Other authorized operations use
`lark-cli` directly through normal shell tools. RemoteLab, the Feishu connector,
and every harness launched for the Bot run inside the same instance runtime cell:
one OS user, one home directory, one
environment contract, and one instance-owned lark-cli config directory. The
connector initializes that config from its existing Bot credentials at startup;
the App Secret is never copied into a prompt.

RemoteLab does not pin the CLI to Bot identity or reset the owner's default.
The harness can inspect authorized identities and follow the CLI's
version-matched workflow before using any Feishu capability:

```bash
lark-cli profile list
lark-cli auth status --json --verify
remotelab feishu list
remotelab feishu calendar.list --profile <bot-profile>
lark-cli skills read lark-doc
lark-cli docs +fetch --doc <docx-or-wiki-url>
```

These fixed actions are reusable recipes, not an API proxy or a handwritten
permission bridge. `lark-cli` talks
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
- group admission does not add a mandatory reaction; private-chat processing
  receipts keep their existing behavior
- the connector forwards mostly the rendered user message plus mention-token hints, not a large blob of transport metadata
- `accessPolicy.mode` defaults to `all`; use `whitelist` when only selected senders may use the Bot

`accessPolicy` decides who may use the Bot. Newly added groups default to active
participation (`defaultGroupParticipation: "active"`): the main Session receives
discussion and decides when a useful contribution is needed. The Bot-added event
automatically creates/reuses that group's main Session and publishes a pinned
configuration card. The first admitted message is a fallback when that event is
unavailable. Existing mute, pause, card suppression, explicit `mention_only` and disabled
participation controls are preserved. Legacy `responseMode: "all"` groups use
the same three-state controller as other active groups. Set `defaultGroupParticipation` to
`"mention_only"` for a connector whose new groups should require invitations, or
set an individual group's `responseMode: "mention_only"`. Connector-wide legacy
`responsePolicy.group` remains accepted for compatibility; the new setting controls
the default. Self and peer-Bot guards apply in every mode. Explicitly passive
groups filter uninvited messages before attachment handling or model submission.
An accepted topic binding permits later human follow-ups in that same topic;
other groups, tenants and Bots never inherit it.

Participation cards are replaced on the next publication after reaching 13 days
from their original send time. Such replacements show “旧卡片已满13天，更换新卡片”
inside the new card; ordinary edits keep the same message and do not reset its age.
See [group card presentation](feishu-project-links.md) for the retained controls.

Work and learning topic groups that are intended as assistant task entry points
must explicitly set `groups[chatId].responseMode: "all"`; do not infer their role
from `chat_mode=topic` or their name. A sharing topic group can retain
`responseMode: "mention_only"`. Review the actual group purpose and prior
participation decisions when repairing a missing entry-point configuration;
new groups otherwise use the active default. This intake setting does not remove explicit mute
or the self/peer-Bot guards.

Each invited Thread creates or continues its own Session, scoped by Bot, tenant, chat
and topic. The Session answers directed requests and relevant supplements;
human-to-human chatter may remain silent,
including forwarded messages, unless explicitly told to stay silent or paused.
An accepted binding preserves Session continuity across connector restarts and
admits later unmentioned human follow-ups. Quoting a message outside a Thread does not
create topic identity; it follows the group's mainline admission policy.
Private messages are always admitted immediately after access control.
The response filter runs before commands, reactions, attachments and AI submission,
including stored-message replay. Mention matching uses the Bot's API identity.
Session fallback never bypasses sender access control or Bot loop protection.
Explicit mute, listening and paused state retain their existing meaning.
Session-start routing
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
| `/log` or `/log <question>` | Continue the Session bound to this topic or chat. The model checks the Run that preceded `/log`, verifies its LangSmith status through read-only APIs, and answers the question with the relevant viewing steps. |
| `/harness` or `/harness <id>` | List available Harnesses or change the current Session. |
| `/model` or `/model <id>` | List the current Harness's models or change the current Session. |
| `/effort` or `/effort <level>` | List supported reasoning levels or change the current Session. |
| `/tier` or `/tier <sota\|quality\|balanced\|economy>` | List or change the current Session's model tier. |
| `/mute` | Stop automatic responses in the current topic or chat; explicit mentions still wake the Bot once. |
| `/unmute` | Restore the original response behavior in that topic or chat. |
| `/help` | Show these commands and the task-command format. |

`/log` resolves the current conversation binding, then freezes the prior Run
before submitting a normal model turn in that same Session. The text after
`/log`, including subsequent lines, is passed to the model as the user's
question. A bare `/log` supplies a default question.
The model verifies the trace through the authenticated, read-only
`GET /api/sessions/{id}/langsmith?format=json&runId={priorRunId}` endpoint and
explains the relevant viewing or debugging steps. If that Run is not mapped
into LangSmith, the response must distinguish a Session-level trace from a
Run-specific link. `/log` does not create another Session or publish a trace.
An unbound topic receives a short error instead of creating a Session.

`GET /api/sessions/{id}/latest-run` returns the current active Run or the
last user turn's Run ID without returning message bodies. The connector calls
it before admitting `/log`, so the diagnostic target cannot become the new
`/log` Run. The earlier historical Session search API remains available to
the model for questions that explicitly ask about historical Sessions.

The authenticated `GET /api/sessions/search?q=...` endpoint uses the instance's
normal shared Session access. Internal helper Sessions, hidden blocks, reasoning
and tool output are excluded. A disposable index under
`CONFIG_DIR/cache/session-log-search/` stores term counts and event cursors;
subsequent searches index only new events. The first search on a large history
may need a retry while the index builds. Missing/corrupt indexes are rebuilt;
unreadable histories are reported as incomplete results. Existing LangSmith
snapshot links retain their normal LangSmith access requirements.

Chat results use the instance's `/api/sessions/{id}/langsmith` browser entry.
The authenticated `?format=json` variant returns the exact current trace URL,
browser entry and status for read-only clients without following the redirect.
With `runId`, it also reports `runMatched`, so a root-trace fallback is not
mistaken for a link to the requested Run.
An unauthenticated GET opens RemoteLab's username/password login page, retaining
the destination (including `runId`) through failed and successful login attempts.
After RemoteLab login, the entry redirects to the verified LangSmith URL.
LangSmith still requires its own account with project access. This does not
publish the trace or grant new permissions. Other unauthenticated API requests
continue to return JSON 401 responses. Search API clients receive both the raw
`langsmithUrl` and the login-aware `langsmithEntryUrl`.

`langsmith-case-link.json` can optionally name a `historyStateDir` alongside
`stateDir` and `backfillStateDir`. Each directory is an instance-local basename
containing `state.json` for the configured `projectId`. Historical imports use
the same `sessions[id].latestSnapshot` shape as backfills, with
`kind: "historical_import"`; API clients can label those links explicitly. Publish a
snapshot into this index only after verifying the uploaded content. Preserve
original execution dates inside historical imports and distinguish import time
from execution time. A bad source does not suppress a valid link from another
configured source.

The snapshot URL must select its exact root run, using LangSmith's returned
`/r/{rootId}` or `/trace/{traceId}/run/{rootId}` address. Project overview URLs
and mismatched trace IDs are rejected. Run-specific entries support both URL
forms and retain provider query parameters such as `trace_id` and `start_time`.
An optional `workspaceId` also rejects links into an old workspace. When moving
the collector to another account or project, migrate and verify historical
traces too, then update `projectId`, `workspaceId` and all three state directories
together. A project with the same name does not imply the same traces exist in it.

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

Use `/sota 深入分析这个问题` to run a task with the configured SOTA tier
(default: Codex, GPT-6 Astra, `xhigh`). It follows the same reply placement as
`/quick`: a new conversation creates a Standard Session with the SOTA runtime;
an existing Standard Session switches to SOTA before the task is submitted.
Following messages keep that selection. An existing Quick Session has a fixed
runtime, so start a new topic to use SOTA. `/sota` requires task text and cannot
be combined with other task or runtime commands. The existing `/tier sota`
command still changes an existing Session without submitting a task.

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

Command-only blocks execute directly without creating a task. Mute and unmute
also add a non-publishing feedback turn when a Session already exists.
New Standard Sessions always start from Auto. Runtime setters change an
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

Adding Feishu's `SHHH` ("[嘘]") reaction to a reply sent by this Bot also
mutes the reply's own main timeline or Thread. The Connector checks its outbound
message index before acting, so reacting to another sender's message has no
effect. The operator must pass the same sender access policy as message input.
The reaction itself produces no chat message. Removing it does not unmute;
`/unmute` does. A mute or unmute command, and a
`SHHH` reaction on a Bot reply, are also fed to the existing Session as
non-publishing feedback so it can reconsider its preceding participation.
The `/mute` setting still takes effect even when no Session exists.

For groups with `reactionFeedback: true`, other human reactions on this Bot's
replies are recorded as non-publishing feedback in the existing Session. A
reaction on someone else's message is ignored. These signals do not change
mute state or automatically become lasting instructions. Group reactions are optional. Neither `quickReactions` nor legacy
`feishuOutcomeRequired` adds THINKING or an EatingFood fallback. A silent decision
may produce no provider message and no reaction.

The main model uses the same hidden response decision as text publication:
`<private>feishu-response:{"reaction":"THANKS"}</private>`. Omission retains
existing feedback; `"reaction":null` explicitly withdraws this Bot's reaction.
The outbox records the withdrawal at main-model stage 2 before cleanup, so late
stage-1 Jev feedback cannot recreate it, including after restart. Only reaction
IDs created by this Bot are removed. Unknown provider outcomes keep the existing
reconciliation behavior.

`groupReactionCandidates` selects the default supported reaction IDs for this Bot’s groups, including newly connected groups. `groups[chatId].reactionCandidates` can override that selection for an individual group. Private chats do not inherit the group selection.
The same set appears in the main-model prompt, filters Jev's choices and is
checked again before provider delivery. `[]` disables additions but permits
withdrawal. Omission retains the existing protocol catalog; it does not install
a new group policy automatically. The confirmed 2026-10-16 selection is exported
as `FEISHU_CONFIRMED_REACTION_CANDIDATES` for explicit deployment configuration:

```json
["THUMBSUP", "OK", "SOB", "TOASTED", "JOYFUL", "PROUD", "EatingFood", "Typing", "OneSecond", "THANKS", "Yes", "No", "YouAreTheBest", "OnIt"]
```

The labels, in order, are 赞、OK、流泪、衰、愉快、得意、吃饭、敲键盘、稍等、谢谢、Yes、No、送你小红花、在做了.
Source: human input `om_x100b622ba72c5ca4cd1ac80b92073aa` in parent Session
`6552263e397cac937fea3a099fa70b94`; duplicate 赞 was removed. IDs and images were
checked against the [official Feishu emoji reference](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce.md)
on 2026-10-16. `SOB` is 流泪; `CRY` (hands over mouth), `TEARS` and `LOL` are
different images. `YouAreTheBest` is the hand offering a red flower, not `ROSE`
or `PRAISE`; `THANKS` is folded hands, not `ThanksFace`. The official public
[Messenger bundle](https://sf1-scmcdn-cn.feishucdn.com/obj/feishu-static/ee/web-client/p/static/js/lark.951a2f3f.js)
also pairs 流泪 and SOB through resource 6, 衰 and TOASTED through 13, 得意 and
PROUD through 41. Jev receives only the social subset of the configured set;
EatingFood, Typing, OneSecond, Yes, No and OnIt require main-model evidence.
Both stages may choose no reaction; the main model may explicitly withdraw it.
The preset does not modify any instance's actual configuration.

Ambient group Sessions use the same light timeline instructions whether or not
`groupFeed` is enabled in ChatUI. In active mode, a message addressed to another person may receive a useful
evidence-based contribution. The model assesses added value, evidence, duplication
and interruption cost and records a brief `participationReason` in its hidden
decision; this does not accept or start the other person’s assigned task. If a Session nevertheless uses tools and completes
without a visible final answer, RemoteLab posts an incomplete-work notice with
the Session link, even if the final contained only a reaction directive. Earlier
commentary is not treated as a completed answer, and the notice does not claim
the task succeeded. The reaction delivery has a durable receipt and ordered
claim, but the reaction create call has no message-send-style idempotency UUID: an unknown
provider outcome requires reconciliation before deliberate retry.
In an explicitly enabled group, admitted human messages on the main timeline
reach a Session. Topic conversations use the same participation judgment, with their existing
conversation and task context. Personal routing opt-in controls work routing,
not text participation, reaction choice or response publication. An explicit @ mention normally asks for a text reply;
the model includes `OnIt` before a normal answer. A message asking for only a
reaction receives no visible text after the reaction is added.

Legacy embedded configurations can explicitly enable `jevReactions` with
`quickReactions`, `participationMode: "ambient"` and `groupFeed`; modern controlled
groups receive these defaults through `effectiveFeishuGroup`. Each admitted human message is appended once to its bound
group Session. The main Harness receives it without waiting for the fast reaction model, reaction
persistence or the reaction provider. It decides whether to reply, where the
reply belongs and whether authorized work needs a separate Session.

TypeSafe Jev (`jev-1.13.0`, `POST /v1/systemone`) receives a bounded recent Session window (at most 20 messages and 5,000
characters) and two social-reaction questions in one API call: whether a reaction
is appropriate, and which emoji fits. The yes/no reaction probability must reach
0.8; the chosen social emoji must reach 0.2. This keeps uncertain participation
silent without requiring one of many similar emoji to monopolize 80% of the
probability. An explicit no-reaction decision, low support, malformed response
and provider failure are recorded separately. The observation record retains
the selected choice, both probabilities, model and latency for diagnosis. It cannot classify
participation, invitations, mode changes, work placement or handoff. It cannot
answer factual questions with Yes/No or claim work is underway or complete.
Its optional Get only acknowledges receipt. Weak support, missing credentials,
timeout and provider failure produce no reaction, never a fallback work signal.
No project report is loaded into this call; `dailyReportMemory` is retained as
compatible configuration but no longer feeds the reaction model. See the
[retired report input](feishu-daily-report-memory.md).

Main-Session responses use one decision containing reply placement, optional reaction,
answered input IDs and, for deliberate silence, a reason. Native final answers and
`work reply` use the same parser and durable response publisher. Reaction controls
are read before display cleanup; combined replies retain the selected reaction.
Text follows the selected topic, while the reaction targets the owner input's
original message. Retries recover the same decision and outbox rather than sending
another answer. Quick Jev feedback remains a separate optional stage-1 receipt;
the main model's stage-2 decision takes precedence.

Unified controlled groups and topics enable this optional Jev path by default;
explicit `jevReactions: false` disables it. Listening and paused controls gate
Jev before any classification, just as they gate substantive participation. Supply the TypeSafe key through
`TYPESAFE_API_KEY`, or `TYPESAFE_KEY_FILE` (default: `<config-dir>/typesafe.env`,
containing `TYPESAFE_API_KEY=...`). No OpenAI API credential or Codex login is used
for this fast call. The timeout is 1,600 ms; failures do not call a slower model.

The main Session receives the message in parallel and owns the complete response,
including participation, reply placement, continuation of existing work and the
final reaction choice. It chooses inline versus Thread for the whole discussion
before the first visible opening, including earlier related messages, likely
questions, confirmation and review returns. Several short supplements can make
one substantive discussion. Research, design feedback, cross-topic review,
installation guidance and multi-step work normally belong in a Thread. Human
placement instructions take priority; character count does not decide work
ownership. A Thread reply does not itself launch another worker. Existing replies,
accepted handoffs and ongoing work must be reused, not answered or started twice.
Disabling automatic work-Session routing does not disable choosing a Thread reply.

Newly admitted ambient-group inputs carry `feishuReplyPlacementVersion: 1`.
Before the first visible reply, the Harness selects placement in a hidden decision:

```text
<private>feishu-response:{"replyMode":"thread"}</private>
```

For a final covering related accepted inputs, include their actual IDs and an
optional reaction in that same decision, followed by the answer:

```text
<private>feishu-response:{"replyMode":"thread","requestIds":["feishu:original","feishu:supplement"],"reaction":"Get"}</private>
The answer to the original question and its supplement.
```

`requestIds` defaults to the root input for a single-input answer. In the existing
per-input mainline trial, terminal publication validates that all listed inputs
belong to the same accepted execution and group, then reserves content, placement,
reaction and coverage together. It does not require a later bookkeeping tool call.
An unrelated, transferred or already answered input cannot be claimed. Omitting an
input never means it was answered. Existing topics and already chosen destinations
remain authoritative; reactions and deliberate silence do not choose a location.
Old `feishu-reply` and `feishu-reaction` prefixes are parsed by compatibility
adapters, without replaying historical deliveries or changing group activation.

Missing placement retains the substantive reply instead of silently publishing
it inline. A still-running native execution receives at most one structural
protocol error, with continuation-only/reference-only protection: it cannot
restart a settled Run or answer a pending human question. No second model judges
content or chooses the location. If the execution ends without a choice, the
answer remains in Session history and the source receives a delivery-failure
notice. New-protocol inputs with a pending question receive one failure notice and a Session entry so the
human can use the original Web question controls. That notice does not select
inline placement. Old accepted inputs keep their original contract; new inputs
cannot join an incompatible old mainline execution. A suppressed unplaced
opening is not replayed after the choice is corrected.

For an immediate answer while work continues, `work reply` accepts the same
`text`, `requestIds`, `replyMode`, `reaction` and `noTextReason` fields. It is an
alternate entrance to the response publisher, not a second acknowledgement step.
Never send the same answer through both the tool and a native final. An opening
or progress receipt does not prevent a combined answer. Content, reaction and
input coverage recover from the original durable reservation after interruption.
Attachments follow the same selected location. A no-text decision records its
reason without creating a status paragraph. Invalid fields or input ownership
retain the answer in history and an explicit error; no model guesses its coverage.
Missing coverage remains incomplete internally; it does not authorize a transport-generated group reply. In particular, an empty final in a human-to-human discussion must not trigger a missing-bookkeeping acknowledgement for a steered input. Explicit no-text decisions record successful handling; an unmarked omission does not. The Harness still judges whether the answer actually addresses each input.

Confirmed sync returns retain the source execution's selected destination;
late callbacks do not select a new location. Their cards show a short original
excerpt and work-topic link, with the full review, tables and unresolved questions
in a closed detail panel. Feishu forbids native tables inside that panel, so
each row retains all cells with their column labels as readable text. Ordinary
unfolded replies keep native tables. This is a deterministic display contract, independent
of personal opening/progress choices and without a summary model. Failures are
visible outside the panel. If the card cannot preserve the content or is explicitly
rejected, delivery uses a complete Markdown file rather than flattening the review
into the mainline. Timeouts retain the existing uncertain-delivery fence.

Native sync confirmation updates the original question card with one readable
outcome; successful confirmation no longer creates a separate status post. The
Harness receives that system receipt separately from the preserved human choice
and must not repeat acceptance in a final. New substantive final answers, required
questions and failures still publish normally. Protocol IDs remain in durable
records; confirmation button labels and ordinary result bodies omit them.

During input preparation the connector reads its local durable outcome receipt
once and supplies a bounded snapshot to the main Session. Applied, not-recorded
and unavailable are distinct; not-recorded does not prove Jev chose silence, and
the snapshot can become stale. This read never waits for Jev or delays admission
on a feedback failure. The main Session retains a suitable existing reaction or
chooses its own when feedback is missing or unsuitable. For a directed request
it answers or work it undertakes, its instructions require a fitting final
reaction; discussion needing no reaction can deliberately omit one. This is a
Harness responsibility, not another classifier or an output-blocking gate.

Set `reaction` in the final response decision to express that choice. The old
`<private><feishu-reaction emoji="THANKS"/></private>` prefix remains compatible.
Confirming the same emoji reuses the Bot receipt without another provider create;
a changed choice replaces only its own recorded outcome after the new reaction
succeeds. The main choice takes precedence over late quick feedback, including
when it keeps the same emoji. Retries preserve the receipt. There is no automatic
emoji fallback for an omitted directive, no extra acknowledgement paragraph, and
no second task start on Jev completion or failure. Status or factual reactions
require evidence, and a reaction alone cannot replace a result after doing work.
Missing credentials produce no reaction and do not invoke another provider.
The deadline remains 1,600 ms; verify real latency and Chinese examples before
claiming the provider is usable on an instance. The request has one named
`choice` question with social emoji values and `none`; a selected emoji needs
at least 0.8 probability. Refusals and malformed or unsupported answers are
ignored. See the [official Decisions contract](https://developers.openai.com/api/docs/guides/decisions).

The reaction runs independently. A successful selection is saved under the
source message and sent through the existing durable source-delivery outbox.
It does not add temporary THINKING or ask the main model for another reaction.
A failure is logged without retrying the admitted task. If the connector exits
before selection is persisted/queued, this optional reaction can be absent;
the main task does not wait for its recovery. Concurrent processing in the
same process shares a reaction job; persisted decisions and outbox identity
prevent replay from choosing a second outcome. Historical decisions retain
their records, but their workMode, participation and binary-answer fields no
longer determine new admission or placement. A submission already durably
prepared before upgrade keeps its original Session and delivery target;
reusing a mainline observation must not omit the worker Session user event.

Topics retain ordinary topic replies. Commands, explicit mute/pause state,
access controls and Bot handoff limits retain their own admission paths.
Disable `jevReactions` to keep only optional main-model reaction decisions.
No mandatory receipt or final reaction is restored. Neither path uses a small
model to choose work placement.

All observed messages remain in the Session. The
group-feed nightly review preserves incremental provenance and current work
summary. A later work turn also uses the bounded Feishu conversation window
(at most 100 messages, 24 hours, 4-hour activity gap, and 48,000 characters).
The existing Session compactor can shorten a long Harness context when its
token threshold is reached; it does not delete raw events. Automatic rotation
or deletion of old group Sessions is not enabled by this pilot. Before adding
either, define a measured trigger, carry-forward summary, and readback check
for unresolved decisions and tasks.

For reaction mute, the Feishu app must subscribe to
`im.message.reaction.created_v1` ("新增消息表情回复") and publish that app
version. The existing group-message read permission is required by Feishu for
the event. Connector registration alone does not enable platform delivery.

### Reply placement, Session topology, and one-shot Bot handoffs

Every chat has one long-lived main Session. Every Feishu Thread has one separate
Session. A message already inside a Thread always reuses that Thread's Session;
reply settings and commands cannot move it back to the mainline or split it.
The inbound message ID is only a delivery address and is never part of mainline
Session identity.

Groups use `participationMode: "active" | "listening" | "paused"`;
`ambient` remains a compatibility alias for active participation. `defaultGroupParticipation`
accepts the same modes and legacy `mention_only`.

| Existing setting | Upgrade behavior |
| --- | --- |
| `responseMode: "all"` with active connector default | Ordinary groups use the active controller; native topic groups use normal conversation/steer |
| Explicit `responseMode: "mention_only"` without a participation mode | Preserve invitation-only admission |
| `participationControls: false` | Preserve the disabled control boundary |
| Stored listening/paused state, or legacy conversation mute | Retain state; upgrading does not authorize resumption |
| Suppressed/withdrawn status card | Retain suppression |

Modern controlled groups and topics use optional asynchronous Jev social feedback
by default. Explicit `jevReactions: false` remains an opt-out; missing credentials
produce no reaction and never delay main-model admission. Legacy quick/group flags
no longer require a reaction or select content/work placement. The old ambient
alias is normalized by the connector's default policy; test/embedded configurations
without that default keep their explicit compatibility settings.

Each topic inherits the group's current state until explicitly overridden in that
topic. Merely recording messages does not freeze inherited state. Mainline state
changes fence inherited topic output and stop remembered inherited topic executions;
an explicitly controlled independent topic retains its own state. Topic identity,
not a group name or its project role, determines conversation ownership. Cancellation
is scoped to matching Requests rather than the whole Session, preserving unrelated
queued or running work in that Session.

Native topic groups and ordinary groups have different participation rules.
In a native topic group, every human message enters its topic Session and needs
a reply through normal Harness conversation/steer. No Jev participation decision,
three-mode status card, or legacy group mute gates these messages. Self/bot-loop
protection remains. An ordinary group's thread is not a native topic group;
provider chat metadata determines this distinction, including restored records
and project-card discovery. A legacy delivery target marked `chatMode: thread`
only identifies reply placement; it does not establish a native topic group.

For ordinary groups, the shared response policy has three decisions: the main Session decides whether
its contribution is useful, combines pending questions/corrections into one answer
when helpful, and uses a thread for complex work or continuing discussion. Jev's
optional preliminary social feedback never gates that decision. Several matters
may share one answer; separate input IDs do not require separate messages or a
batching delay. The explicit input list has no fixed eight-message ceiling;
publication still verifies every input's accepted execution and reply ownership.
This policy is maintained once in `lib/feishu-response-decision.mjs`; surface
prompts describe the timeline/topic and optional Jev capability instead of adding
another participation or placement policy. Native topic prompts omit the redundant
topic-surface paragraph; reaction retention/withdrawal is specified once in the
response protocol. To check model behavior as well as transport, run the opt-in
`tests/test-feishu-response-live.mjs` smoke: it uses the installed Codex against
synthetic conversations, saves outputs for review, and never contacts Feishu.
The deterministic `test-feishu-response-runtime.mjs` separately covers native
steer, one combined delivery, and per-input settlement with a fixture model.

Ambient mainline inputs choose reply location through `feishu-response` before
visible output. This remains available with personal `routing=none`, and does
not authorize a new worker. Complex replies can choose a thread directly, without
a work-transfer approval. Delivered topic surfaces retain the originating
Session and Run as durable provenance. The first lookup also indexes pre-upgrade
archived delivered receipts once, so completed phase-one topics keep their origin. Follow-ups steer only that execution or
subsequent executions of the same topic; unrelated work in the Session cannot
absorb them. Completion before admission or before definite native acceptance
queues the supplement in the original Session and topic, retaining native
conversation context. Accepted/uncertain inputs are never replayed; cancellation
keeps unaccepted additions stopped. Older run-only continuation packets retain
their fail-closed behavior. Existing independent topic bindings take precedence.

A mainline reply/quote of a recorded outbound topic message can reuse that exact
binding. Conflicting references, unknown messages and prose/title similarity do
not choose a destination. Creating another execution Session or transferring work
to another group still uses the existing authorization workflow.

For ordinary groups using `participationControls: true`, the pinned status card shows
active, listening or paused reception, the main Session link, its saved model and
effort, and native model/effort/prompt editing forms. Group prompts are stored
durably in `group-configuration`, with version, actor and the last 20 revisions.
They apply to subsequent inputs and new topics in that group; already accepted
Runs retain their snapshots. Model and effort controls use the existing runtime
command validation and Session persistence, and only change the main Session.
The card also exposes the main Session's current saved instructions; group
announcement context remains the native announcement. The optional Session link
is not needed to manage configuration. Without an absolute public base URL, the
card marks the external link as unconfigured while its controls remain usable.
Stale edits refresh the card instead of
overwriting a newer selection. Errors appear on the same card. Use the refresh
button after external Web edits; admitted messages and local runtime commands
also update the original card. Forms contain at most 16 prompt inputs of 1,000
characters each; longer existing prompts are shown in full without a truncating
edit form. Set that exact group's
`participationStatusCard: false` to hide the card while keeping participation
and text controls. This also suppresses publication on restart and mode changes;
withdraw the existing message and its top notice separately when requested.
Restart refreshes only existing status cards; it never creates a missing card
from remembered conversation state, even when finishing a pending mode change.
Native topic records are excluded from
restoration, including pending old pause operations.

The opt-in `projectCards: true` setting extends this same card to groups explicitly
registered in the instance project runtime, including ordinary work and mention-only
groups. Native topic groups are excluded. Their response policy remains unchanged, and participation buttons appear
only where that control is already enabled. Each group reuses its main Session;
the card adds the shared project document, concise skills and a paginated topic
board. Native Session invalidations and registered-source file notifications
refresh the card; per-card publication is serialized to avoid duplicate creates.
See [project group cards and opening briefs](feishu-project-links.md#project-group-agent-cards-and-opening-briefs)
for scope, registration, feedback and acceptance boundaries.

In ordinary groups, participation controls apply to the main timeline and each existing Thread;
Threads inherit the group state until an explicit topic override. `/mute` selects listening: messages are recorded without a model turn unless
that message @ mentions the Bot or uses a task command.
Listening still downloads image/file resources into the normal Session asset
store and records attachment references on the observed message, so the Web
history displays the original images and files. Download failures remain explicit
in the message's ingestion metadata; a text placeholder is not proof of a saved
attachment. Recording an attachment does not start a Harness turn.
Jev does not interpret
natural-language invitations, mode changes or topic changes. `/unmute` restores active participation for
new messages; queued content from before restoration is not replayed as new work.
Pausing or entering listening cancels that conversation's ongoing work and removes
its retained THINKING reactions. Definite observation rejections are archived with
their error instead of blocking later messages with endless retries. Delivery
suppression cancels the matching unsent lease; it does not report a provider send.

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
`responseMode` (`all`/`mention_only`), optional `systemPrompt`, and the
exact-chat `participationMode: "active" | "listening" | "paused"` setting
(`"ambient"` remains a compatibility alias). New ordinary groups and their threads use
`defaultGroupParticipation` (active by default when no legacy global mention-only policy is explicitly configured). An existing explicit `responsePolicy.group: "mention_only"` remains mention-only unless the operator selects the new default; explicit per-group policies take
precedence. A successfully bound topic continues without another mention. The
group prompt is appended to global instructions and applied to existing Sessions
on their next input, while already accepted Runs retain their instruction snapshots.

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

Chat replies longer than 5,000 characters after hidden-content and emoji cleanup
are sent as one `完整答复.md` file in the original chat or thread, preserving the
complete visible Markdown instead of appending `[truncated]`. Replies whose
serialized message content exceeds the conservative 28KB budget also use a file.
The file replaces the text message under the same durable delivery ID, UUID and
receipt; no extra summary message is sent. Upload failures use the existing safe
retry path, while ambiguous message sends remain fenced against automatic resend.
Restart recovery replays a saved receipt without uploading or sending again.
Short replies retain the rendering below. Delivery notices and document comments
keep their existing behavior. Already-delivered historical messages are not resent.

The model can emit ordinary Markdown. Replies with supported top-level GFM
tables automatically become one JSON 2.0 card: Markdown prose and native table
components retain their original order. The card fills the available width;
up to four columns share that width according to their content, while wider
tables use readable pixel widths and horizontal scrolling. Rows use automatic
height (up to 999px), with ten rows per page; every row is retained. Feishu may
clip very long cells, whose full content can be inspected in the client.
Automatic row height requires Feishu 7.33 or newer.

The converter reuses the shipped GFM parser, excludes code examples, and keeps
cell formatting, links, alignment, known mentions, code and formula images.
Thread replies and normal chat messages use the same renderer and existing
delivery UUID/receipt path; no additional model call, prompt or Skill is needed.
Ordinary replies still use `post` / `md`, retaining adjacent Markdown blocks.
Known mentions use `user_id` in posts and `id` in cards.

Replies outside supported card limits (five tables, fifty columns, a conservative
28KB payload budget), reference-style link definitions, and unsupported post
elements retain the original rich-text post. An explicit card-construction
rejection (230099) falls back to that post. Uncertain sends and rate limits do
not cause a second send. Delivery notices and document comments are unchanged.

See the [official message content contract](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json).
See also the [native table contract](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table).
Some Markdown styles require a recent Feishu client. Use blank lines around
tables. Nested tables remain Markdown rather than becoming native table components.

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

### Optional personal settings pilot

Configure `personalSettings.openIds` only for the explicitly invited testers, and
an optional credential-free HTTPS `personalSettings.webUrl`. The existing
`card.action.trigger` subscription handles these private cards as well. A normal
accepted private message produces one welcome; `/settings` or “我的设置” reopens
it without model execution. This is a private per-Person surface, not group
participation control. See [personal settings](feishu-web-settings.md#飞书私聊个人设置卡2026-10-16小范围试用)
for identity checks, delivery recovery and separate live acceptance.

### Independent personal memory review cards

The explicitly enrolled `reviewCardPersonIds` trial in `learning-policy.json` uses the same connector/outbox and `card.action.trigger` callback. New personal memories and foreground proposals can show keep/edit/discard controls in the originating conversation. These callbacks mutate only the versioned memory; they never submit user input or a native question to the original task. Enable only for the person who requested it, with personal learning enabled. See [memory learning](memory-learning.md#独立记忆卡片试点飞书) for privacy deferral, identity/version checks, retry behavior and rollout limits.

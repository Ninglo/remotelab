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
- whether V0 should start with `allow_all` or `whitelist`

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
- if V0 succeeds, optionally suggest widening availability or switching from `allow_all` to `whitelist`

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
  "processingReaction": {
    "enabled": true,
    "emojiType": "THINKING",
    "removeOnCompletion": false
  },
  "silentConfirmationText": "",
  "intakePolicy": {
    "mode": "allow_all"
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
- a Bot profile is an attention/context boundary, not a host security boundary.
  Do not add connector-specific file or knowledge access checks solely to keep
  two local Bot personas conceptually separate
- `botId` / `sourceRouteId` remains transport addressing so replies, Topics and
  deferred results return through the Bot that owns the originating conversation
- `processingReaction` lets the bot add a quick reaction on the user's message before the real reply lands; by default it uses `THINKING` and keeps it attached as a lightweight ack marker
- `emojiType` must be one of Feishu's reaction emoji types such as `THINKING`, `WRONGED`, `FINGERHEART`, `GLANCE`, or `SMILE`; if you specifically want the built-in `委屈`-style reaction, use `WRONGED` rather than `HURT`
- `silentConfirmationText` lets the connector send a tiny text acknowledgement when the assistant would otherwise stay silent; this is useful for Feishu-style emoticon tokens like `[委屈]`
- set `removeOnCompletion` to `true` only if you want the reaction to be temporary and disappear after the reply lands
- the connector forwards mostly the rendered user message plus mention-token hints, not a large blob of transport metadata
- `allow_all` is the simplest V0 mode; move to `whitelist` after the first validation if needed

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

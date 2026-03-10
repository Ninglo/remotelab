# Feishu Bot V0 Operator Checklist

> Purpose: split the Feishu bot rollout into the parts the human operator must do in Feishu’s console/client and the parts the agent can implement locally.
> Scope: V0 validation for **one bot identity**, with **p2p chat first** and **group sessions later**.

---

## Product stance

We should register **one Feishu bot only**.

That bot is the same RemoteLab agent identity:

- private chat with the bot = direct 1:1 conversation
- group with the bot = separate shared session surface

This is the cleanest first version.

---

## What must be done by the human operator

These steps depend on your Feishu developer account, tenant/admin UI, or chat-client identity, so they should be treated as **manual**.

### Required manual setup

- Create a **Feishu self-built app** in the developer console.
- Enable the app’s **bot** capability.
- Use a **test tenant / test version** if available, so we can iterate quickly.
- Open the minimum permissions for V0:
  - read user-to-bot p2p messages
  - send IM messages as the app/bot
- Add the event subscription for **`im.message.receive_v1`**.
- Make sure your own Feishu account is inside the app’s **availability scope**.
- Publish / apply the config if the console requires it for the version you are using.

### Exact event to add for V0

For the first validation, add **only this one event**:

- category: **Messenger**
- subscription type: **Tenant Token-Based Subscription**
- event label in the console: **Receive message v2.0** / **接收消息 v2.0**
- event key: **`im.message.receive_v1`**

Notes:

- Do **not** use `User Token-Based Subscription` for this bot flow.
- Do **not** add a bunch of extra events yet.
- If the console asks to open required permissions while adding the event, approve that prompt.

### Credentials / facts you must hand back to me

After the setup above, send me these exact items:

- `App ID`
- `App Secret`
- confirm whether this is **Feishu CN** (`open.feishu.cn`) or **Lark global** (`open.larksuite.com`)
- confirm that **`im.message.receive_v1`** is subscribed
- confirm that you can already **search the bot and send it a private message**

### Optional manual setup for later, not blocking V0

- Enable group `@bot`-message permissions
- Add the bot into one test group
- Create a dedicated test group for multi-session validation

---

## What I can implement automatically

Once you provide the credentials and confirm the app is reachable from your Feishu account, I can do the rest locally.

### I can build

- the local **Feishu connector process**
- Feishu long-connection event intake using the Node SDK
- quick dedupe and background job handling
- RemoteLab auth bootstrap using the owner token
- session create/reuse via `externalTriggerId`
- message submission via `requestId`
- run polling and assistant-reply extraction
- outbound Feishu text replies for V0
- local config loading and launch scripts

### I can also decide automatically

- the `externalTriggerId` format
- the `requestId` format
- the normalized message-preface shape
- the local config-file layout
- the first-pass logging / retry / queue structure

---

## What I cannot reliably do for you headlessly

Even though I have full machine access, these steps are still poor candidates for unattended automation because they require your Feishu identity, developer-console session, or tenant-specific approval flow.

- registering the app in the Feishu developer console
- clicking permission toggles in the console
- handling any tenant-admin approval prompts
- verifying the app is visible to your Feishu user account
- starting the first human-to-bot private chat in the Feishu client
- adding the bot to a group from the chat UI

So the right split is:

- **you** do Feishu-console / chat-client setup
- **I** do connector implementation and local wiring

---

## Exact V0 setup target

To keep the first validation tight, please aim for this exact target and skip everything else.

### V0 target

- one self-built app bot
- one bot identity only
- p2p private chat only
- event subscription through **long connection**
- subscribed event: **`im.message.receive_v1`**
- minimal send/read permissions only
- plain-text reply only

### Not needed yet

- custom group webhook bots
- message cards
- menu events
- callback/webhook mode
- multi-bot architecture
- group `@bot` flows

---

## Console checklist for you

Use this as the literal checklist.

- [ ] Create a self-built Feishu app
- [ ] Enable bot capability
- [ ] Switch to test version / test tenant if available
- [ ] Open p2p-read permission for bot messages
- [ ] Open IM-send permission for the bot
- [ ] In **Messenger**, add **Receive message v2.0** (`im.message.receive_v1`) under **Tenant Token-Based Subscription**
- [ ] Subscribe `im.message.receive_v1`
- [ ] Ensure my user account is in app availability scope
- [ ] Publish/apply the config if required
- [ ] Search the bot inside Feishu and send it a private message

---

## What to send me back

When you finish, just send me this template filled in:

```text
Feishu bot setup ready.

App ID: ...
App Secret: ...
Region: Feishu CN / Lark Global
Subscribed event: im.message.receive_v1
P2P bot chat works from my account: yes / no
Optional group test ready: yes / no
```

That is enough for me to start the actual connector implementation.

---

## My parallel track after your handoff

As soon as you send the values above, my implementation track is:

1. build a local `feishu-connector` process
2. connect with Feishu long connection
3. handle p2p message events
4. map one Feishu chat to one RemoteLab session
5. reply with the final assistant message back into Feishu

That gives us the first clean end-to-end validation.

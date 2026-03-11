# Feishu Dynamic Access / Group-Driven Whitelist Plan

## Goal

Keep Feishu access control in **runtime memory first**, persist it locally for durability, and let trusted groups automatically grant access to newly joined users **without restarting the connector**.

## Important current-state note

The current connector already does **not** require a restart for plain whitelist-file edits.

- In `whitelist` mode, each inbound event re-reads `allowed-senders.json`
- So file changes already take effect on the next message

What is still weak today:

- every policy check hits disk
- whitelist state is file-first rather than runtime-first
- there is no built-in notion of **trusted chat/group -> auto grant on join**
- group metadata is not modeled as durable runtime state

So the right next step is **not** "make file edits hot reload" — that part already works.
The right next step is **move to an event-driven in-memory policy cache with persisted state**.

## Proposed V1

### 1. Split static config from mutable runtime state

Do **not** keep rewriting the main `config.json`.

Reason:

- `config.json` contains credentials and static boot settings
- dynamic policy writes should not risk corrupting the main credentials file
- mutable state is easier to reason about when it lives in its own file

Instead:

- keep `config.json` as static boot config
- add a new mutable file such as `access-state.json`

Suggested shape:

```json
{
  "version": 1,
  "approvedChats": {
    "oc_xxx": {
      "chatId": "oc_xxx",
      "name": "Family Group",
      "tenantKey": "tenant_xxx",
      "autoApproveNewMembers": true,
      "source": "manual",
      "updatedAt": "2026-03-11T07:00:00.000Z"
    }
  },
  "allowedSenders": {
    "openIds": ["ou_xxx"],
    "userIds": [],
    "unionIds": [],
    "tenantKeys": []
  },
  "membershipGrants": {
    "oc_xxx:ou_xxx": {
      "chatId": "oc_xxx",
      "openId": "ou_xxx",
      "userId": "",
      "unionId": "",
      "source": "chat_join",
      "grantedAt": "2026-03-11T07:00:00.000Z"
    }
  }
}
```

### 2. Load state once at startup into memory

At connector startup:

- load `access-state.json`
- normalize into in-memory Sets / Maps
- keep runtime as the source of truth for policy checks

Suggested runtime shape:

```js
runtime.access = {
  mode: 'whitelist',
  allowed: {
    openIds: new Set(),
    userIds: new Set(),
    unionIds: new Set(),
    tenantKeys: new Set(),
  },
  approvedChats: new Map(),
  membershipGrants: new Map(),
  dirty: false,
  flushPromise: Promise.resolve(),
};
```

Then `isAllowedByPolicy()` only checks memory.

### 3. Persist after mutation, not before lookup

Any runtime update should follow this pattern:

1. update memory immediately
2. mark state dirty
3. flush to `access-state.json` in the background

Persistence rules:

- serialize writes through one queue
- use atomic write (`tmp` + rename)
- debounce slightly if needed (for bursty join events)

This gives:

- no restart
- no per-message disk reads
- durable recovery after restart

### 4. Add group-driven auto-grant

Use Feishu events:

- `im.chat.member.user.added_v1` — user joined group
- `im.chat.member.user.deleted_v1` — user left / removed from group
- `im.chat.member.bot.added_v1` — bot added to group
- `im.chat.updated_v1` — group name/metadata updated

Minimal V1 behavior:

- when bot is added to a group, record the chat in local state
- when a user joins a group:
  - if `chatId` is in `approvedChats` and `autoApproveNewMembers === true`
  - add that user to runtime `allowed` Sets immediately
  - persist the grant to `access-state.json`

### 5. Keep group IDs dynamic, but in mutable state

Your idea is right: group IDs should be durable and updateable without restart.

I would just store them in **mutable state**, not the main config file.

Recommended rule:

- `config.json` = boot config / credentials / static defaults
- `access-state.json` = approved chats + grants + runtime-discovered group metadata

That gives us the same outcome you want, with less operational risk.

## Approval model

For safety, approved groups should be explicit.

### V1 rule

Only auto-grant joins for chats that are explicitly marked:

- `autoApproveNewMembers: true`

This avoids a bad failure mode where the bot gets added to some random group and silently opens access to everyone there.

## Recommended flows

### Flow A — manual trust, then automatic joins

1. operator marks a group as approved
2. connector stores `chatId` and metadata in `access-state.json`
3. new people join that group
4. `im.chat.member.user.added_v1` arrives
5. connector grants them access immediately in memory
6. connector persists the grant locally

This is the simplest and safest first version.

### Flow B — bot-added discovery

1. bot is added to a new group
2. `im.chat.member.bot.added_v1` records `chatId`, `name`, `tenantKey`
3. group stays **known but not trusted** by default
4. operator flips it to approved later

This keeps discovery dynamic without auto-opening access.

## What I would not do in V1

### 1. I would not auto-trust every group the bot enters

That is too easy to misuse later.

### 2. I would not auto-revoke on user leave yet

Possible, but slightly trickier because a user may have:

- multiple approved groups
- manual direct grant
- tenant-level allow

So V1 should be **additive only**.

Then V2 can support revocation using `membershipGrants` as structured grant sources.

### 3. I would not rely on manual file editing as the main control plane

If we want truly dynamic group approval, the better long-term control surface is:

- owner-only admin chat command, or
- small local admin CLI, or
- tiny RemoteLab API endpoint

All of those can update memory first, then persist.

## Minimal code changes

### Connector changes

- replace file-read-per-message whitelist checks with runtime cache checks
- add `loadAccessState()` / `flushAccessState()` helpers
- add event handlers for:
  - `im.chat.member.user.added_v1`
  - `im.chat.member.user.deleted_v1` (record only for now)
  - `im.chat.member.bot.added_v1`
  - `im.chat.updated_v1`
- add helpers:
  - `grantSenderAccess(identity, source)`
  - `recordApprovedChat(chat)`
  - `shouldAutoApproveChat(chatId)`

### Local files

- keep existing `known-senders.json`
- add `access-state.json`
- optionally add `known-chats.json` later if we want to separate directory data from policy state

## Feishu console changes

Subscribe to these events in addition to the current message event:

- `im.chat.member.user.added_v1`
- `im.chat.member.user.deleted_v1`
- `im.chat.member.bot.added_v1`
- `im.chat.updated_v1`

## Suggested rollout

### Phase 1

- keep current whitelist mode
- introduce `access-state.json`
- load into memory on startup
- check memory for allow/deny
- persist mutations after join events
- support approved chat IDs in state

### Phase 2

- add owner-only way to mark a discovered group as approved without editing files

### Phase 3

- optionally support revocation on leave events

## My recommendation

The clean first implementation is:

1. keep `whitelist` mode
2. move whitelist lookup to memory
3. persist mutable access state in `access-state.json`
4. subscribe to user-join and chat-metadata events
5. auto-grant only for explicitly approved groups

That gives you the behavior you want:

- no restart
- stable connector
- dynamic group IDs
- event-driven permission updates
- local persistence for recovery
- much less operational friction than the current file-first model

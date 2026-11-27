# Personal Google accounts in Antigravity

In Index, open **Settings → 我的 Antigravity**. Download the connection program and run its login command on your own computer with Node.js 22 or later and Antigravity CLI installed. Sign in with your Google account in Antigravity, then exit the CLI. Generate an Index connection code, run the connection command shown in Settings, and enter the code in the same terminal. The code can be used once and expires after five minutes.

Choose **Antigravity · 个人 Google** in the Index Harness picker, send a text message, then confirm the displayed prompt in the terminal. The terminal must remain connected. Each prompt runs through the signed-in Antigravity CLI. File, shell, browser and MCP tools are disabled for this mode. Connections renew while the terminal is present. Disconnect in Settings or press Ctrl+C in the terminal to revoke access.

Google credentials remain in the local Antigravity profile. Index retains the messages and responses in its usual Session history. Index routes a new request to the accepting person's connection and never falls back to a shared Antigravity login. A paired device cannot receive another person's requests. Follow-ups use that Session's local conversation while the connection is open. After a reconnect or Index restart, pair the device again. A stopped, disconnected or interrupted request is not automatically sent again.

## Use previous Index conversations

With **Antigravity · 个人 Google** selected, open **引用 Index 历史**, search by a topic or keyword, and preview the matching messages. Use **加入草稿** to include a passage and its source link with your question. Index searches your owned Sessions, including ones previously used with Codex. Only the draft you send is forwarded to Antigravity. It can cite those passages and their links. Other users' Sessions, hidden prompt blocks, assistant progress and tool output are excluded. This search covers Index conversation messages. It does not query the company directory, project files or another provider's private thread state.

## Instance enablement

> Enable personal Antigravity on the requested instance. Set `REMOTELAB_PERSONAL_ANTIGRAVITY=1` on its chat service. Verify the real browser/API flow with two test People and two devices, then have real account owners sign in on their own computers and verify which Google accounts the runs used. Do not share or copy credentials between devices or into Index.

The feature is off by default. Removed or expired device connections end pending requests and require a fresh pairing. Remove the instance flag and restart its chat service to disable the entry point.

Automated verification uses fixture device responses and two Index accounts.

```sh
node scripts/run-with-clean-instance-env.mjs node tests/test-personal-antigravity.mjs
```

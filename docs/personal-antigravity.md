# Personal Google accounts in Antigravity

In Index, open **Settings → 我的 Antigravity → 连接个人 Gemini**. Download the connection program and run its login command on your own computer with Node.js 22 or later and Antigravity CLI installed. Sign in with your Google account in Antigravity, then exit the CLI. Generate an Index connection code, run the connection command shown in Settings, and enter the code in the same terminal. The code can be used once and expires after five minutes.

During pairing, press Enter to confirm each request in the terminal, or type **y** to enable daily mode for that connection. In daily mode, text messages you send in your private Index web sessions run directly when you choose **Antigravity · 个人 Google**. The terminal must remain connected. Requests outside that scope still need individual confirmation. Each prompt runs through the signed-in Antigravity CLI. The local CLI can use the Index lookup tool during a private request. File, shell and browser tools are blocked. Connections renew while the terminal is present. Disconnect in Settings or press Ctrl+C in the terminal to revoke access.

Google credentials remain in the local Antigravity profile. Index retains the messages and responses in its usual Session history. Index routes a new request to the accepting person's connection and never falls back to a shared Antigravity login. A paired device cannot receive another person's requests. Follow-ups use that Session's local conversation while the connection is open. After a reconnect or Index restart, pair the device again. A stopped, disconnected or interrupted request is not automatically sent again.

## Reference Index context

With **Antigravity · 个人 Google** selected, type your question and send it normally. Gemini decides when it needs past information and can call a read-only tool to search the relevant Index source. By confirming a request or enabling daily mode for the connection, you permit eligible requests to send matching excerpts and source links to Google within your existing Index access. Index returns up to four excerpts per call and expires lookup access when the request ends. The tool is available in eligible private Sessions. If you already connected a device using an older program, download the updated program and reconnect to enable this tool. Your existing local Google login can be reused.

- Dialogue search covers visible messages in the Index Sessions you own, including previous Codex and Gemini answers. Hidden blocks, background operations, assistant progress and tool output are excluded.
- Project memory uses the registered project ledger. It covers projects explicitly bound to your Sessions or confirmed in your verified participation records. A result links to the registered project brief or the associated Session.
- Work summaries show the goal, conclusions and next steps recorded for your Sessions and the latest outcome of your own registered work.

This feature covers sources that Index can read. Provider conversations that exist outside Index and the company directory are outside this search.

## Instance enablement

> Enable personal Antigravity on the requested instance. Set `REMOTELAB_PERSONAL_ANTIGRAVITY=1` on its chat service. Verify the real browser/API flow with two test People and two devices, then have real account owners sign in on their own computers and verify which Google accounts the runs used. Do not share or copy credentials between devices or into Index.

The feature is off by default. Removed or expired device connections end pending requests and require a fresh pairing. Remove the instance flag and restart its chat service to disable the entry point.

Automated verification uses two Index accounts and checks the MCP tool over stdio against the real lookup route. Google account behavior requires a signed-in device check.

```sh
node scripts/run-with-clean-instance-env.mjs node tests/test-personal-antigravity.mjs
```

# Agent Mailbox Bootstrap

Created 2026-03-09 to give the machine-owning agent a first-class email identity and a safe intake path.

## Identity

- English name: `Rowan`
- Preferred address: `agent@example.com`
- Local intake root: `~/.config/remotelab/agent-mailbox/`
- Public webhook host: `mailhook.example.com`

## Current delivery status

The mailbox is now live on the Cloudflare-native path.

- Cloudflare Email Routing is enabled for the selected mailbox domain.
- The public webhook is reachable through the `agent-mailbox` Cloudflare Tunnel.
- The local bridge accepts authenticated Cloudflare Worker traffic and routes mail into the review/quarantine queues.
- Real external inbound delivery from an allowlisted sender is validated.
- Approved messages can open normal RemoteLab sessions and deliver the final assistant turn back by email.

The point is not to make email a generic support inbox.
The point is to give the agent a stable internet-facing identity that can receive operator-forwarded material like WeChat-exported chat records, long-form notes, and attachments that are awkward to paste into chat.

## Security boundary

Phase 1 intentionally keeps the system conservative by default:

1. Public mail reaches the mailbox entry point.
2. Sender allowlist is checked before any AI processing.
3. Allowed senders go to the local `review/` queue.
4. Unknown senders go to `quarantine/`.
5. Nothing is AI-eligible until a human explicitly approves it into `approved/`.

This means the safety boundary remains:

`email arrival -> allowlist gate -> manual review -> optional AI processing`

For single-operator testing, mailbox automation can optionally skip the manual review step for allowlisted senders and move them straight into `approved/`.

## Local implementation

The local mailbox flow spans intake, approval, AI processing, and optional outbound reply:

- `lib/agent-mailbox.mjs`
- `lib/agent-mail-outbound.mjs`
- `scripts/agent-mail.mjs`
- `scripts/agent-mail-worker.mjs`
- `scripts/agent-mail-http-bridge.mjs`
- `lib/agent-mail-completion-targets.mjs`

The CLI supports:

- `init` — create identity + initial allowlist
- `status` — show the active identity and queue counts
- `allow add|list` — maintain the sender allowlist
- `ingest` — import `.eml` files or a directory of emails
- `queue` — inspect `review`, `quarantine`, or `approved`
- `approve` — mark a reviewed email as AI-eligible
- `outbound status|configure-cloudflare-worker|configure-apple-mail` — configure the outbound sender
- `automation status|configure` — configure the chat-server-backed reply worker

Queue layout:

```text
~/.config/remotelab/agent-mailbox/
├── identity.json
├── allowlist.json
├── automation.json
├── outbound.json
├── events.jsonl
├── raw/
├── review/
├── quarantine/
└── approved/
```

## Approved-mail reply loop

Approved email replies use only Node.js + HTTP APIs so the flow stays portable across macOS and Linux.

Runtime path:

`approved/ item -> agent-mail-worker -> chat-server /api/sessions -> detached AI run -> completion target -> Cloudflare Worker /api/send-email`

Key design choices:

- The worker creates a normal RemoteLab chat session through the same session API the UI uses.
- The session carries a one-shot completion target bound to that specific request ID.
- When the run finishes, the completion target reads the final assistant message for that run and sends it through the configured outbound email provider.
- Delivery state is written back into the mailbox item, so `approved/` items can show `processing_for_reply`, `reply_sent`, or `reply_failed`.
- The preferred outbound path is the Cloudflare Worker fetch endpoint backed by Cloudflare `send_email`, with `apple_mail` still available for local fallback testing.
- The preferred inbound path is Cloudflare Email Routing -> thin Worker ingress -> local mailbox bridge -> local agent-mail-worker, so provider logic stays thin and business logic stays in RemoteLab-owned code.

## Public ingress architecture configured on this machine

The live path for this machine is:

`Internet mail -> Cloudflare Email Routing -> Email Worker(email) -> HTTPS webhook -> Cloudflare Tunnel -> local bridge -> allowlist/review queue`

Concrete pieces:

- Mailbox address: `agent@example.com`
- Email Worker URL: `https://remotelab-email-worker.example.workers.dev`
- Public webhook: `https://mailhook.example.com/cloudflare-email/webhook`
- Local bridge: `http://127.0.0.1:7694`

Reasoning:

- Cloudflare only supplies receive/send primitives.
- The local bridge keeps the safety boundary on this machine: no mail becomes AI-eligible before allowlist + review rules run locally.
- Provider-specific behavior stays out of the business logic layer.

## Runtime artifacts

Live configuration files:

- Bridge state: `~/.config/remotelab/agent-mailbox/bridge.json`
- Identity: `~/.config/remotelab/agent-mailbox/identity.json`
- Outbound sender config: `~/.config/remotelab/agent-mailbox/outbound.json`
- Reply automation config: `~/.config/remotelab/agent-mailbox/automation.json`
- Tunnel config: `~/.cloudflared/agent-mailbox-config.yml`
- Bridge LaunchAgent: `~/Library/LaunchAgents/com.remotelab.agent-mail-bridge.plist`
- Tunnel LaunchAgent: `~/Library/LaunchAgents/com.remotelab.agent-mail-tunnel.plist`
- Worker LaunchAgent: `~/Library/LaunchAgents/com.remotelab.agent-mail-worker.plist`

Logs:

- Bridge stdout: `~/Library/Logs/agent-mail-bridge.log`
- Bridge stderr: `~/Library/Logs/agent-mail-bridge.error.log`
- Tunnel stdout: `~/Library/Logs/agent-mail-tunnel.log`
- Tunnel stderr: `~/Library/Logs/agent-mail-tunnel.error.log`

Health checks:

- Local: `http://127.0.0.1:7694/healthz`
- Public: `https://mailhook.example.com/healthz`
- Worker: `https://remotelab-email-worker.example.workers.dev/healthz`

## Current validation state

- Public `GET /healthz` returns healthy JSON at the mailbox webhook host.
- Invalid public webhook tokens are rejected before intake.
- Real mail from an allowlisted sender reaches the mailbox flow.
- Automated replies can be sent back out through Cloudflare `send_email`.
- The mailbox automation path has been exercised end-to-end and historical test artifacts can be safely cleaned after validation.

## Initial commands

```bash
cd ~/code/remotelab
node scripts/agent-mail.mjs init \
  --name Rowan \
  --local-part rowan \
  --domain example.com \
  --allow owner@example.com

node scripts/agent-mail.mjs status
node scripts/agent-mail.mjs queue review
```

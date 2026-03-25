# Cloudflare Email Worker (Prompt-First Deploy Contract)

This document is the operator contract for asking an AI agent to deploy the thin Cloudflare email edge while keeping RemoteLab's business logic local.

The human should ideally provide one early packet of Cloudflare and mailbox context, let the AI do the rest, and only step back in for real browser-only or approval-only tasks.

## Copy this prompt

```text
I want you to deploy or update the RemoteLab Cloudflare Email Worker.

Follow `docs/cloudflare-email-worker.md` in this repository as the deployment contract.
Keep the workflow inside this chat.
Before doing work, collect every missing input in one message so I can answer once.
Do every automatable step yourself.
After my reply, continue autonomously and only stop for true `[HUMAN]` steps or final completion.
When you stop, tell me exactly what I need to do in Cloudflare and how you'll validate it afterward.
```

## One-round input handoff

The AI should try to collect this context in one early exchange:

- sender address and mailbox alias
- mailbox bridge URL
- expected Worker name or existing Worker URL
- whether Cloudflare Email Routing is already configured
- whether local mailbox config already exists under `~/.config/remotelab/agent-mailbox/`

If any Cloudflare dashboard action is still needed, the AI should batch those asks into one visit whenever possible.

## Architecture

`Cloudflare Email Routing -> Cloudflare Email Worker(email) -> mailbox bridge -> local agent-mail-worker -> RemoteLab -> completion target -> Cloudflare Email Worker(fetch) -> Cloudflare send_email`

## Thin-edge rule

- Cloudflare only does inbound receive and outbound send.
- RemoteLab and the local mailbox stack keep filtering, review, automation, session routing, and replies.
- Inline or attached email images are forwarded into RemoteLab sessions as normal file attachments for the agent to inspect.
- Edge config stays thin so provider migration remains easy.
- The Worker forwards the raw message plus the real envelope recipient (`rcptTo`), which lets the local mailbox route aliases such as `rowan+trial6@domain` or direct instance addresses such as `trial6@domain` into the matching guest instance.

## [HUMAN] steps

1. Authenticate Wrangler or Cloudflare if the machine is not already logged in.
2. Create or confirm the Cloudflare Email Routing shape that matches the mailbox addressing mode. For `instanceAddressMode: plus`, keep a literal owner route such as `rowan@domain -> Worker` and enable Email Routing subaddressing so `rowan+trial6@domain` is accepted at SMTP time. For `instanceAddressMode: local_part`, create one literal Worker route per direct guest address such as `trial6@domain -> Worker`. A catch-all Worker route can still be useful for typo/privacy handling, but it does not reliably replace literal per-instance routes for direct guest addresses.
3. Provide any mailbox identity values the AI cannot infer, such as sender address, worker URL, or mailbox bridge URL.

## Cloudflare API auth note

- The OAuth session from `wrangler login` is sufficient for Worker deploys, but it is not sufficient for Cloudflare Email Routing API endpoints such as `/zones/:zone_id/email/routing/settings` or `/rules`.
- For fully scriptable Email Routing changes, use either a dedicated `CLOUDFLARE_API_TOKEN` with zone-level Email Routing access, or a `CLOUDFLARE_GLOBAL_API_KEY`/`CLOUDFLARE_API_KEY` paired with `CLOUDFLARE_EMAIL`.
- To prepare or sync the desired state from the host machine, run `node scripts/agent-mail-cloudflare-routing.mjs status --live`, `node scripts/agent-mail-cloudflare-routing.mjs sync`, and `node scripts/agent-mail-cloudflare-routing.mjs probe --address trial6@example.com`.

## AI execution contract

- copy `cloudflare/email-worker/wrangler.example.jsonc` to the gitignored local `cloudflare/email-worker/wrangler.jsonc`
- gather the full mailbox and Cloudflare context packet before deployment so the human is not repeatedly interrupted for small missing values
- keep only `MAILBOX_FROM` and `MAILBOX_BRIDGE_URL` in Worker config
- read or confirm the local mailbox tokens from `~/.config/remotelab/agent-mailbox/outbound.json` and `~/.config/remotelab/agent-mailbox/bridge.json`
- deploy with `cloudflare/email-worker/deploy.sh`
- return the Worker URL, confirm `GET /healthz`, and validate the mailbox bridge path after deploy

## Worker config contract

Local `wrangler.jsonc` should only carry:

- `MAILBOX_FROM`
- `MAILBOX_BRIDGE_URL`

Secrets uploaded during deploy:

- `OUTBOUND_API_TOKEN`
- `MAILBOX_BRIDGE_TOKEN`

The Worker should not carry RemoteLab login or session-orchestration config. That logic stays in the local mailbox stack.

## Local outbound config contract

```json
{
  "provider": "cloudflare_worker",
  "workerBaseUrl": "https://remotelab-email-worker.example.workers.dev",
  "from": "agent@example.com",
  "workerToken": "<same token uploaded as OUTBOUND_API_TOKEN>"
}
```

## Success state

- inbound routing sends the owner mailbox and intended guest mailbox aliases to the Worker according to the chosen address mode
- RemoteLab completion targets can call `POST /api/send-email`
- `curl https://.../healthz` succeeds
- mailbox bridge and reply tests pass when the AI runs them
- SMTP probes accept both the owner mailbox and one guest mailbox such as `trial6@domain`

## Validation examples

```bash
curl https://remotelab-email-worker.example.workers.dev/healthz
curl https://mailhook.example.com/healthz
node tests/test-agent-mail-http-bridge.mjs
node tests/test-agent-mail-reply.mjs
node tests/test-agent-mail-worker.mjs
```

## Notes

- No Forward Email dependency
- No SMTP setup
- `apple_mail` remains as a local fallback outbound provider for manual testing

# RemoteLab Setup Contract (Prompt-First)

This document is the setup contract for an AI agent running on the target machine.

The human's default job is simple: copy a prompt into their own AI agent, answer one concentrated context handoff near the start, and only step in again for explicit `[HUMAN]` checkpoints. The configured object is the AI toolchain and its defaults, not a long manual checklist for the human to replay.

## Copy this prompt

```text
I want you to set up RemoteLab on this machine so I can control AI coding tools from my phone.

Network mode: [cloudflare | tailscale]

# For Cloudflare mode:
Domain: [YOUR_DOMAIN]
Subdomain: [SUBDOMAIN]

# For Tailscale mode:
(No extra config needed — both phone and dev machine must have Tailscale installed and joined to the same tailnet.)

Use `docs/setup.md` in this repository as the setup contract.
Keep the workflow inside this chat.
Before doing work, collect every missing input in one message so I can answer once.
Do every automatable step yourself.
After my reply, continue autonomously until a true `[HUMAN]` step or final completion.
When you stop, tell me the exact action I need to take and how you'll verify it after I reply.
```

## One-round input handoff

The AI should try to collect everything below in its first exchange, not through a long trail of follow-up questions.

- platform: `macOS` or `Linux`
- network mode: `cloudflare` or `tailscale`
- for Cloudflare mode: domain and subdomain to expose
- for Tailscale mode: confirm both phone and dev machine are on the same tailnet
- which local AI CLI tools are actually installed and allowed to be used
- default tool, model, and reasoning / effort preference for new sessions
- auth preference: token-only or token + password fallback

If something cannot be known until a browser or provider login happens, the AI should still explain the full payload it expects back so the human can return once with all missing details.

If multiple tools are installed and the user has no strong preference, prefer `CodeX` (`codex`) as the default built-in tool.

## Runtime configuration principle

RemoteLab setup is the primary configuration UX.

- the AI should ask which installed tool(s) the user wants enabled
- the AI should ask for default model and reasoning preferences where the tool supports them
- these answers should seed defaults for new sessions
- the current chat turn's tool/model choice remains the runtime source of truth
- background helpers such as auto-naming or summarization should inherit the current turn selection rather than silently switching providers

## [HUMAN] checkpoints

1. Cloudflare authentication via browser if `cloudflared tunnel login` requires it (Cloudflare mode only).
2. Any OS, package-manager, or provider auth the AI cannot finish alone, such as a sudo password, Homebrew install approval, or external login.
3. Opening the final RemoteLab URL on the phone and confirming the first successful login.

The AI should minimize how often it interrupts the human for these checkpoints and should batch requests whenever one human visit can unblock multiple downstream steps.

## AI execution contract

The AI should do the rest inside the conversation:

- verify prerequisites: Node.js 18+, `cloudflared` for Cloudflare mode, `tailscale` for Tailscale mode, and at least one supported AI CLI
- gather the full context packet before starting execution, so the human is not repeatedly re-interrupted for small missing details
- clone or update the repo at `~/code/remotelab`, run `npm install`, and expose the CLI with `npm link` if needed
- prefer `remotelab setup` when it cleanly fits the environment; otherwise perform the equivalent service and tunnel setup directly
- generate access auth with `remotelab generate-token`; optionally add password auth with `remotelab set-password`
- configure the boot-managed owner stack based on network mode:
  - **Cloudflare**: chat plane on `127.0.0.1:7690`, Cloudflare tunnel for the public URL
  - **Tailscale**: chat plane on `0.0.0.0:7690` (via `CHAT_HOST=0.0.0.0`), `SECURE_COOKIES=0` for HTTP access. Note: `0.0.0.0` listens on all interfaces; on untrusted networks, configure a firewall to restrict port `7690` to the Tailscale subnet (`100.64.0.0/10`)
- persist or seed the chosen tool/model/reasoning defaults for new sessions
- validate the local service and final access URL before handing back control

## Target state

### Cloudflare mode

| Surface | Expected state |
| --- | --- |
| Primary chat service | boot-managed owner service on `http://127.0.0.1:7690` |
| Public access | Cloudflare Tunnel routing `https://[subdomain].[domain]` to port `7690` |
| Auth | `~/.config/remotelab/auth.json` exists and the token is known to the user |
| Tunnel config | `~/.cloudflared/config.yml` exists |
| Defaults | new-session tool/model/reasoning defaults match the user's stated preference |

### Tailscale mode

| Surface | Expected state |
| --- | --- |
| Primary chat service | boot-managed owner service on `http://0.0.0.0:7690` |
| Access | `http://[hostname].[tailnet].ts.net:7690` reachable from phone on the same tailnet |
| Auth | `~/.config/remotelab/auth.json` exists and the token is known to the user |
| Environment | `CHAT_HOST=0.0.0.0` and `SECURE_COOKIES=0` set in the service config |
| Defaults | new-session tool/model/reasoning defaults match the user's stated preference |

## Done means

- the local logs show the chat server is listening
- **Cloudflare**: the tunnel validates and the public hostname resolves; the AI returns the final phone URL as `https://[subdomain].[domain]/?token=...`
- **Tailscale**: the MagicDNS hostname is reachable; the AI returns the final phone URL as `http://[hostname].[tailnet].ts.net:7690/?token=...`
- the human confirms the phone can open RemoteLab successfully

## Repair rule

If validation fails, the AI should stay in the conversation, inspect logs, and repair the machine. Keep manual instructions only for browser, approval, or external-auth steps the AI cannot do itself, and avoid restarting the whole questioning flow unless the missing context truly changed.

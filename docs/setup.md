# RemoteLab Setup Contract (Prompt-First)

> Existing instances: read the [Request state upgrade notice](request-state-upgrade.md) before updating source, running setup over an installation, or restarting shared-source services. The 2026-09-07 state format requires offline conversion; this setup flow does not perform that migration.

This document is the setup contract for an AI agent running on the target machine.
The canonical public copy is `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md`, so the setup flow can start from a clean terminal even before the repo exists locally.

The human's default job is simple: open a fresh terminal on the target machine, paste a prompt into their own AI agent, answer one concentrated context handoff near the start, and only step in again for explicit `[HUMAN]` checkpoints. The configured object is the AI toolchain and its defaults, not a long manual checklist for the human to replay.

Alongside Cloudflare and Tailscale, RemoteLab also treats `cpolar` as a first-class network mode when the main audience is in mainland China and needs direct access without a VPN.

## Copy this prompt

```text
I want you to set up RemoteLab on this machine so I can hand repetitive digital work to AI from phone or desktop and let it automate the work on a real computer.

Network mode: [cloudflare | cpolar | tailscale]

# For Cloudflare mode:
Domain: [YOUR_DOMAIN]
Subdomain: [SUBDOMAIN]

# For cpolar mode:
Access preference: [temporary public URL | reserved stable subdomain]
If you already have a cpolar account: [yes | no]
If no account exists yet, use https://www.cpolar.com/?channel=0&invite=6WH2 for signup guidance.
If you already want a fixed reserved subdomain, include the label you want to keep.

# For Tailscale mode:
(No extra config needed — the host machine and the client devices I want to use are on the same tailnet.)

Use `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md` as the setup contract.
If I choose cpolar mode, also use `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/cpolar-setup.md` as the focused guide for registration and tunnel setup.
Do not assume the repo is already cloned. If `~/code/remotelab` does not exist yet, fetch this contract, clone `https://github.com/Ninglo/remotelab.git` yourself, and continue.
Keep the workflow inside this chat.
Before doing work, collect every missing input in one message so I can answer once.
Do every automatable step yourself.
After my reply, continue autonomously through every low-loss, reversible, auditable step until final completion. Stop only for an inaccessible credential/browser action, hard authorization, or an unscoped irreversible high-impact action.
If you must stop, actively tell me the exact action I need to take, preserve resumable state, and explain how you'll verify and continue after I reply.
```

## One-round input handoff

The AI should try to collect everything below in its first exchange, not through a long trail of follow-up questions.

- platform: `macOS` or `Linux`
- network mode: `cloudflare`, `cpolar`, or `tailscale`
- for Cloudflare mode: domain and subdomain to expose
- for cpolar mode: whether the user already has a cpolar account, whether they only need a quick temporary URL or a stable long-lived URL, and any preferred reserved subdomain label
- for Tailscale mode: confirm both phone and dev machine are on the same tailnet
- which local AI CLI tools are actually installed and allowed to be used
- default tool, model, and reasoning / effort preference for new sessions
- auth preference: token-only or token + password fallback

If something cannot be known until a browser or provider login happens, the AI should still explain the full payload it expects back so the human can return once with all missing details.

If multiple tools are installed and the user has no strong preference, prefer `CodeX` (`codex`) as the default built-in tool.

## Runtime configuration principle

RemoteLab setup is the primary configuration UX.

- the AI should ask which installed tool(s) the user wants enabled
- new Web Sessions start in Auto; Custom exposes explicit Harness, model, and effort choices
- model and reasoning choices apply only to the Session being created or edited
- the current chat turn's tool/model choice remains the runtime source of truth
- background helpers such as auto-naming or summarization should inherit the current turn selection rather than silently switching providers

### Jev auto model routing

The composer has an Auto / Custom switch. New Web Sessions start in Auto,
which is a routing strategy rather than a model. Jev chooses one of five tiers
from the first user message; the composer then shows the concrete model and
effort. Custom exposes the Harness, model, and effort controls. The next new
Session starts in Auto again. The default tier mappings are:

- `quick`: GPT-6 Sol with `low` reasoning and a short-answer developer prompt
  for self-contained, low-risk requests that need no tools or current facts.
- `balanced`: GPT-6 Sol with `medium` reasoning for clearly bounded,
  low-consequence routine work.
- `quality`: GPT-6 Sol with `xhigh` reasoning. This is the conservative default
  for serious work, research, development, debugging, and contextual tasks.
- `sota`: GPT-6 Astra with `xhigh` reasoning. Jev may choose it only when the
  user explicitly requests the strongest/SOTA model, maximum reasoning, or
  explicitly marks the task as extremely important and asks for top quality.
- `economy`: GPT-6 Luna with `low` reasoning only when the user explicitly
  prioritizes the lowest cost for casual, low-risk work.

RemoteLab persists the concrete model and effort on the Session, so later turns
keep the same native provider context. A user-selected concrete model always
bypasses Jev. Uncertain decisions, a missing TypeSafe key, and routing failures
use the `quality` tier.
An Auto-selected Quick Session can still use tools when a later request needs
them. Legacy Quick Sessions and Feishu `/quick` remain compatible, but the Web
new-session switch no longer exposes Quick as a separate mode.

GPT-6 Sol and Luna availability rolls out by ChatGPT workspace and Codex CLI
version. Before enabling these mappings on an existing instance, update Codex,
refresh the native model catalog, and run one real low-effort canary for each
model. Do not switch the tier file when either canary is rejected.

Store the key in the service environment as `TYPESAFE_API_KEY`, or in the
instance config directory as a private `typesafe.env` file:

```text
TYPESAFE_API_KEY=...
```

The file must be readable only by the service user. The optional
`TYPESAFE_KEY_FILE` environment variable may point to a different private env
file. `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, and
`TYPESAFE_TIMEOUT_MS` override the API URL, Jev model, and routing timeout.

The tier mappings and Quick developer prompt can be edited and route-tested in
Settings → Sessions → Auto routing. They are saved in `jev-routing.json` in the
instance configuration directory. `JEV_TIER_CONFIG_FILE` may point to another
JSON file. The file can also be edited directly:

```json
{
  "quick": { "model": "gpt-6-sol", "effort": "low" },
  "sota": { "model": "gpt-6-astra", "effort": "xhigh" },
  "quality": { "model": "gpt-6-sol", "effort": "xhigh" },
  "balanced": { "model": "gpt-6-sol", "effort": "medium" },
  "economy": { "model": "gpt-6-luna", "effort": "low" },
  "quickPrompt": "Answer directly and concisely in the user's language..."
}
```

The file is read for each new Auto Session, so future SOTA or sweet-spot model
changes do not require code changes or a service restart. Missing or invalid
fields keep their tier defaults. The persisted routing receipt contains the
chosen tier, concrete route, confidence summary, latency, and fallback reason;
it never contains the API key or user prompt.

## [HUMAN] checkpoints

1. Cloudflare authentication via browser if `cloudflared tunnel login` requires it (Cloudflare mode only).
2. cpolar account signup, plan upgrade, or dashboard-only reserved-subdomain actions when the user wants cpolar and those steps are not already done (cpolar mode only).
3. Any credential, OS prompt, provider authorization, or external login that the AI genuinely cannot access or complete itself.
4. Opening the final RemoteLab URL on the phone and confirming the first successful login.

The AI should minimize how often it interrupts the human for these checkpoints and should batch requests whenever one human visit can unblock multiple downstream steps.

## AI execution contract

The AI should do the rest inside the conversation:

- verify prerequisites: Node.js 18+, `cloudflared` for Cloudflare mode, `cpolar` for cpolar mode, `tailscale` for Tailscale mode, and at least one supported AI CLI
- gather the full context packet before starting execution, so the human is not repeatedly re-interrupted for small missing details
- do not require the human to pre-clone the repo; if `~/code/remotelab` is missing, fetch this contract from its canonical URL, clone `https://github.com/Ninglo/remotelab.git` into `~/code/remotelab`, otherwise update the existing repo, then run `npm install` and expose the CLI with `npm link` if needed
- prefer `remotelab setup` when it cleanly fits the environment; for cpolar or Tailscale mode, configure the service directly when the current setup flow is still Cloudflare-oriented
- generate access auth with `remotelab generate-token`; optionally add password auth with `remotelab set-password`
- configure the boot-managed instance stack based on network mode:
  - **Cloudflare**: chat plane on `127.0.0.1:7690`, Cloudflare tunnel for the public URL
  - **cpolar**: chat plane on `127.0.0.1:7690`, cpolar HTTP tunnel for the public URL, prefer `cn_vip` / China VIP for mainland-facing access, and use either a quick random URL or a reserved stable subdomain based on the user's sharing need
  - **Tailscale**: chat plane on `0.0.0.0:7690` (via `CHAT_BIND_HOST=0.0.0.0`), `SECURE_COOKIES=0` for HTTP access. Note: `0.0.0.0` listens on all interfaces; on untrusted networks, configure a firewall to restrict port `7690` to the Tailscale subnet (`100.64.0.0/10`)
- for cpolar mode, authenticate the local client with the user's cpolar token or the local cpolar web UI, create an HTTP tunnel to port `7690`, and keep the tunnel configuration persistent across restarts
- persist or seed the chosen tool/model/reasoning defaults for new sessions
- validate the local service and final access URL before handing back control

## Target state

### Cloudflare mode

| Surface | Expected state |
| --- | --- |
| Primary chat service | boot-managed instance service (`remotelab.service` on Linux) on `http://127.0.0.1:7690` |
| Public access | Cloudflare Tunnel routing `https://[subdomain].[domain]` to port `7690` |
| Auth | `~/.config/remotelab/auth.json` exists and the token is known to the user |
| Tunnel config | `~/.cloudflared/config.yml` exists |
| Defaults | new-session tool/model/reasoning defaults match the user's stated preference |

### cpolar mode

| Surface | Expected state |
| --- | --- |
| Primary chat service | boot-managed instance service on `http://127.0.0.1:7690` |
| Public access | cpolar HTTP tunnel routes a public hostname to port `7690` |
| Mainland access | the returned URL opens directly for users in mainland China without a VPN |
| Tunnel mode | random temporary URL for quick validation, or a reserved stable subdomain when the user asked for long-lived sharing |
| Auth | `~/.config/remotelab/auth.json` exists and the token is known to the user |
| Defaults | new-session tool/model/reasoning defaults match the user's stated preference |

### Tailscale mode

| Surface | Expected state |
| --- | --- |
| Primary chat service | boot-managed instance service (`remotelab.service` on Linux) on `http://0.0.0.0:7690` |
| Access | `http://[hostname].[tailnet].ts.net:7690` reachable from phone on the same tailnet |
| Auth | `~/.config/remotelab/auth.json` exists and the token is known to the user |
| Environment | `CHAT_BIND_HOST=0.0.0.0` and `SECURE_COOKIES=0` set in the service config |
| Defaults | new-session tool/model/reasoning defaults match the user's stated preference |

## Done means

- the local logs show the chat server is listening
- **Cloudflare**: the tunnel validates and the public hostname resolves; the AI returns the final phone URL as `https://[subdomain].[domain]/?token=...`
- **cpolar**: the tunnel shows as online and the AI returns the final phone URL as `https://[cpolar-hostname]/?token=...`
- **Tailscale**: the MagicDNS hostname is reachable; the AI returns the final phone URL as `http://[hostname].[tailnet].ts.net:7690/?token=...`
- the human confirms the phone can open RemoteLab successfully

## Repair rule

If validation fails, the AI should stay in the conversation, inspect logs, retry or repair the machine, and make exhausted failures explicit. Keep manual instructions only for inaccessible browser/credential actions, hard authorization, or unscoped irreversible high-impact steps, and preserve a direct resume path instead of restarting the whole questioning flow.

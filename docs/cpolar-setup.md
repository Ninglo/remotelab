# RemoteLab via cpolar (Prompt-First)

Choose `cpolar` when the people opening RemoteLab are mainly in mainland China and you want them to reach it directly without a VPN.

RemoteLab treats `cpolar` as a first-class public-access path alongside Cloudflare and Tailscale. The user-facing reason is simple: mainland users can open it directly, and the operator does not need to buy or wire a separate domain just to validate the flow.

## Official entrypoints

- Registration link with invite code: [https://www.cpolar.com/?channel=0&invite=6WH2](https://www.cpolar.com/?channel=0&invite=6WH2)
- Dashboard: [https://dashboard.cpolar.com](https://dashboard.cpolar.com)
- Download and install: [https://www.cpolar.com/download](https://www.cpolar.com/download)
- Official docs: [https://www.cpolar.com/docs](https://www.cpolar.com/docs)

The official cpolar docs consistently follow this shape:

- register an account and log in to the dashboard
- copy the account token from the dashboard verification area
- install the local cpolar client
- authenticate the local client with `cpolar authtoken ...` or sign in through the local cpolar web UI
- expose the local service through an HTTP tunnel
- use a random temporary URL for quick tests, or reserve a fixed second-level subdomain for long-lived sharing

## Registration strategy

Use this decision rule:

1. If the operator does not have a cpolar account yet, register first through the invite link above.
2. If the goal is only to prove the setup works, a free random public URL is enough for the first pass.
3. If the URL will be sent to coworkers, customers, or recurring users, reserve a fixed second-level subdomain in the cpolar dashboard and treat that as the stable entrypoint.
4. If stable sharing matters, prefer the China VIP line and reserve the fixed subdomain before the final validation pass.

The official tutorials note that the free random URL changes within 24 hours. The fixed second-level-subdomain flow is the right path for long-lived sharing.

## Copy this prompt

```text
I want you to set up RemoteLab on this machine and expose it through cpolar so people in mainland China can open it directly without a VPN.

Network mode: cpolar
Access preference: [temporary public URL | reserved stable subdomain]
If I already have a cpolar account: [yes | no]
If no account exists yet, use https://www.cpolar.com/?channel=0&invite=6WH2 for signup guidance.
If I want a fixed reserved subdomain, I want this label: [OPTIONAL]

Use `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/setup.md` as the general setup contract.
Use `https://raw.githubusercontent.com/Ninglo/remotelab/main/docs/cpolar-setup.md` as the cpolar-specific source of truth.
Do not assume the repo is already cloned. If `~/code/remotelab` does not exist yet, fetch those docs, clone `https://github.com/Ninglo/remotelab.git`, and continue.
Keep the workflow inside this chat.
Before you start work, collect every missing piece of context in one message so I can answer once.
Do every step you can automatically.
After my reply, continue autonomously and only stop for real [HUMAN] steps, approvals, or final completion.
When you stop, tell me exactly what I need to do and how you'll verify it after I reply.
```

## One-round input handoff

The AI should try to collect everything below in one early message:

- platform: `macOS` or `Linux`
- whether the user already has a cpolar account
- whether they only need a quick test URL or a stable long-lived share URL
- preferred reserved subdomain label if they want a fixed subdomain
- which local AI CLI tools are installed and allowed
- default tool, model, and reasoning / effort preference for new sessions
- auth preference: token-only or token + password fallback

## [HUMAN] checkpoints

1. cpolar account signup or dashboard login if the user does not already have access.
2. Any cpolar dashboard-only action the AI cannot complete alone, such as plan upgrade or reserving a fixed second-level subdomain.
3. Any OS or package-manager approval the AI cannot finish alone.
4. Opening the final RemoteLab URL on the phone and confirming that it works.

## AI execution contract

The AI should do the rest inside the conversation:

- verify prerequisites: Node.js 18+, at least one supported AI CLI, and `cpolar`
- if `cpolar` is missing:
  - on macOS, install it with the official Homebrew path from the cpolar download page
  - on Linux, use the official install script / package path from the cpolar download page
- authenticate cpolar with the dashboard token via `cpolar authtoken ...` or through the local cpolar web UI on `http://127.0.0.1:9200`
- configure RemoteLab so the owner chat plane stays on `http://127.0.0.1:7690`
- create an HTTP tunnel that points to local port `7690`
- prefer `cn_vip` / China VIP for mainland-facing access
- if the user asked only for a quick test, accept a random public URL for the first validation pass
- if the user asked for a stable URL, reserve a fixed second-level subdomain in the dashboard and attach it to the tunnel before the final validation pass
- keep the cpolar tunnel configuration persistent so it survives restarts
- validate the final URL and return the phone-ready link with the RemoteLab token appended

## Target state

| Surface | Expected state |
| --- | --- |
| Primary chat service | boot-managed owner service on `http://127.0.0.1:7690` |
| Public access | cpolar HTTP tunnel routes a public hostname to port `7690` |
| Mainland access | the returned URL opens directly in mainland China without a VPN |
| Tunnel shape | temporary random URL for validation, or reserved fixed subdomain for long-lived sharing |
| Auth | `~/.config/remotelab/auth.json` exists and the token is known to the operator |
| Defaults | new-session tool/model/reasoning defaults match the user's stated preference |

## Done means

- the local logs show the chat server is listening on port `7690`
- the cpolar tunnel shows as online
- the AI returns a final phone URL in the shape `https://[cpolar-hostname]/?token=...`
- the human confirms that the phone can open RemoteLab successfully

## Practical notes

- The cpolar download page says macOS should use Homebrew, while Linux can use the official install script.
- The official tutorials use the local cpolar web UI at `http://127.0.0.1:9200/` after installation.
- If port `9200` is already occupied, cpolar documents changing `client_dashboard_addr` in `cpolar.yml`.
- The free random URL is fine for the first end-to-end proof. For anything you plan to send around repeatedly, reserve the fixed subdomain first and validate against that final URL instead.

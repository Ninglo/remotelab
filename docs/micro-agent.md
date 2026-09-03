# Micro Agent

`Micro Agent` is now a very thin `codex`-backed preset inside RemoteLab.

The key shift is intentional: instead of maintaining a separate mini runtime, custom handoff protocol, and upgrade rules, we reuse the primitives RemoteLab already has.

That means:

- GPT model via `codex`
- no extra `request_upgrade` protocol
- no extra routing rules inside the executor
- no separate OpenAI-compatible API wrapper runtime to maintain
- delegation and orchestration happen through ordinary RemoteLab APIs / CLI calls

## What gets installed

The installer writes one custom tool record into `~/.config/remotelab/tools.json`:

- `command: codex`
- `runtimeFamily: codex-json`
- `toolProfile: micro-agent`
- `reasoning.kind: enum` with default `medium`

The preset intentionally starts at `medium` thinking so cold-start turns land faster while still leaving higher effort available when the task needs it.

So the UI treats it like a lightweight preset, while the actual runtime stays the normal Codex CLI.
Unlike the earlier bare-user version, it now follows RemoteLab's normal session context chain so memory pointers, explicit session state, and continuation behavior stay aligned with the built-in `codex` tool.

Guest instances keep their own config directories, so they do not read the owner's `tools.json` directly. The supported `guest-instance create` / `guest-instance converge` flows now sync safe Codex-backed presets like `micro-agent` into each instance config to keep tool availability aligned across instances.

When `micro-agent` is installed and available, the chat UI now prefers it as the default agent for new sessions and app tool pickers. Explicit per-session or per-app tool choices still win.

## Why this is lighter

The previous direction added a new control protocol so the micro-agent could ask RemoteLab to switch runtimes for the next turn.

That works technically, but it also adds a second control plane on top of capabilities RemoteLab already has:

- opening another session
- choosing another tool/model
- sending messages through HTTP

This version removes that extra layer. If the model wants to branch work, it can just call the existing local CLI or API wrapper directly.

## The local API CLI

RemoteLab now exposes a small authenticated CLI wrapper around its own HTTP surface:

```bash
node cli.js api GET /api/tools
node cli.js api POST /api/sessions --body '{"folder":"~/code/remotelab","tool":"micro-agent","name":"scratch"}'
node cli.js api POST /api/sessions/<session-id>/messages --body '{"text":"hello"}' --wait-run
```

If `remotelab` is installed on your `PATH`, the same commands work as:

```bash
remotelab api GET /api/tools
```

For focused delegation there is still a higher-level shortcut:

```bash
remotelab session-spawn --task "<focused task>" --wait
```

For recursive self-use where the parent agent wants a compressed result without adding a visible handoff note to the current session, use the same primitive with a tighter output contract:

```bash
remotelab session-spawn --task "<focused task>" --tool micro-agent --internal --final-only
```

That keeps the architecture flat:

- no separate `scout` product primitive
- same delegation API underneath
- hidden child session for bounded exploration
- parent process receives only the child agent's final reply on stdout

`--final-only` is just sugar for `--wait --output-mode final-only`.

## Install

```bash
node scripts/install-micro-agent.mjs
```

Optional overrides:

```bash
node scripts/install-micro-agent.mjs --model gpt-5.4 --tool-id micro-agent --tool-name "Micro Agent"
```

Model selection order:

1. `--model`
2. `CODEX_MODEL`
3. `~/.codex/config.toml`
4. fallback `gpt-5.4`

## Practical behavior

This setup does **not** turn Codex into a pure raw-completion API; Codex CLI is still the runtime.

But in practice it is close to the lightweight mode we want because:

- it inherits the same RemoteLab session context, memory activation, and manager-layer prompt shaping as `codex`
- it can answer directly without tool use when the task is simple
- it can still use shell when the task genuinely needs it
- it can call `remotelab api` or `remotelab session-spawn` explicitly instead of relying on hidden product-specific control messages
- it can recursively call `remotelab session-spawn --internal --final-only` when it wants a fresh bounded worker that returns only a compressed final result
- the user no longer has to hand-write auth / cookies / HTTP boilerplate

## Validation ideas

Minimal text-only check:

```bash
codex exec --json --skip-git-repo-check --sandbox read-only -C "$(mktemp -d)" 'Reply exactly micro-ok. Do not run shell commands. Do not inspect files. Do not explain.'
```

RemoteLab integration check:

```bash
node cli.js api POST /api/sessions --body '{"folder":"~/code/remotelab","tool":"micro-agent","name":"micro smoke"}'
node cli.js api POST /api/sessions/<session-id>/messages --body '{"text":"只回复 micro-ok，不要运行任何命令。"}' --wait-run
```

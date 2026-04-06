# Documentation Map

This repo now keeps documentation in four layers:

- `README.md` / `README.zh.md` — top-level product overview, setup path, and daily operations
- `docs/` — current, shareable documentation for humans and contributors
- `notes/` — internal design notes, grouped by status so current truth does not get mixed with future direction or historical rationale
- `AGENTS.md` — repo-local operating rules and high-signal context for coding agents

## Canonical Spine

Read these first when you need the current truth:

1. `../AGENTS.md` — repo rules, constraints, active priorities
2. `../README.md` / `../README.zh.md` — product framing, setup path, operator-facing expectations
3. `project-architecture.md` — current shipped architecture and code map
4. `../notes/current/core-domain-contract.md` — current domain/refactor baseline
5. `../notes/current/product-mainline.md` — current product operating loop and shared feedback-recording rule
6. `../notes/current/product-surface-lifecycle.md` — current keep/iterate/retire rule for shipped product surfaces
7. `setup.md` / `external-message-protocol.md` / other focused guides as needed
8. `../notes/current/session-first-workflow-surfaces.md` — internal workflow-organization contract for session list / grouping / task-like views
9. `../notes/current/model-sovereign-control-architecture.md` — current ownership model for manager, prompt, memory, and durable work-state boundaries
10. `../notes/current/session-control-state-phase1.md` — current carrier-to-object mapping and first code landing for manager/work-state projection

## Keep These In Sync

When the system changes, update the matching surface instead of letting discussion notes carry the only truth:

- product positioning, setup flow, or user-visible workflow changes → `../README.md` and `../README.zh.md`
- runtime topology, persistence model, code map, or request flow changes → `project-architecture.md`
- repo rules, self-hosting workflow, or protected surfaces change → `../AGENTS.md`
- domain/refactor baseline changes → `../notes/current/core-domain-contract.md`
- current product mainline or shared feedback-recording rules change → `../notes/current/product-mainline.md`
- outdated or conflicting notes → trim them, archive them, or rewrite them to point at the canonical doc

## Model-First Docs Principle

For setup, deployment, connector, and feature-rollout docs, assume the operator is human but the configured system is an AI toolchain.

- the default human action is to copy a prompt into their own AI coding agent
- the AI should try to collect all required context in one early handoff instead of spreading questions across many turns
- the main execution should stay inside that chat, not in the document
- the document should explicitly mark only the steps that truly require a human with `[HUMAN]`
- a good doc includes the prompt, one-round input packet, target state, exact config artifacts or paths, and concise validation
- avoid full command-by-command walkthroughs for steps the AI can execute or repair on its own
- write for low-interruption handoff: the human should usually be able to answer once, walk away, and return only for approvals, browser-only actions, checks, or final handoff
- in product-facing docs, lead with the user problem and payoff: helping ordinary people hand repetitive digital work to AI with low operational overhead; session/app/orchestration terms belong later unless the doc is explicitly about architecture

## What Lives In `docs/`

### Current Core

- `project-architecture.md` — top-down map of the shipped system
- `setup.md` — model-first setup contract, one-round input handoff, human checkpoints, and target state
- `external-message-protocol.md` — canonical integration contract for external channels
- `creating-apps.md` — user/developer guide for Agents

### Supporting Internal Contracts

- `../notes/current/product-mainline.md` — current product operating loop and shared feedback-recording rule
- `../notes/current/product-surface-lifecycle.md` — current rule that shipped features stay reviewable and may later be simplified or retired
- `../notes/current/session-first-workflow-surfaces.md` — current workflow-organization rule for session list / grouping / task-like views
- `../notes/current/model-sovereign-control-architecture.md` — current control-layer ownership model for prompt, memory, manager state, and refactor direction
- `../notes/current/session-control-state-phase1.md` — current implementation mapping for manager/work-state projection and Phase 1 boundary cleanup

### Focused Integrations

- `automation-apps.md` — automation-as-Agent pattern for owner-side recurring workflows and review sessions
- `cloudflare-email-worker.md` — model-first Cloudflare Email Worker deployment contract
- `feishu-bot-setup.md` — model-first operator + console contract for the RemoteLab Feishu connector
- `github-auto-triage.md` — model-first GitHub intake and auto-reply rollout contract
- `remote-capability-monitor.md` — remote-agent capability monitoring backed by a RemoteLab Agent and review session
- `tunnel-diagnostics.md` — Cloudflare Tunnel latency probe workflow for separating app cost from edge/tunnel cost
- `voice-connector.md` — model-first wake-word speaker/microphone connector contract for RemoteLab

## What Lives In `notes/`

See `../notes/README.md` for the note taxonomy.

Short version:

- `../notes/current/` — current baseline notes that still matter operationally
- `../notes/directional/` — future-facing design direction
- `../notes/archive/` — historical RFCs, investigations, and superseded merge notes
- `../notes/local/` — machine/operator-specific state that should not be treated as shared architecture truth

## Authoring Rule

Before adding a new doc, ask:

1. Is this current truth or a discussion artifact?
2. Does a shorter update to an existing canonical doc solve it better?
3. Is it for users/operators, or for internal design work?
4. Will it still be true after the next refactor, or is it historical rationale?

If the answer is unclear, prefer:

- `README.md` / `README.zh.md` for user-facing overview and setup
- `docs/` for current operational truth
- `notes/directional/` for future design
- `notes/archive/` for investigation history

For any new feature doc that describes enabling, wiring, or operating a capability, default to the same pattern:

- copyable prompt first
- one-round input collection second
- autonomous AI execution next
- explicit `[HUMAN]` checkpoints only when unavoidable

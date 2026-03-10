# Notes Map

`notes/` is for internal design and architecture notes, not for the primary shipped truth.

If you need the current system first, start with:

1. `../AGENTS.md`
2. `../README.md` / `../README.zh.md`
3. `../docs/project-architecture.md`
4. `current/core-domain-contract.md`

## Buckets

### `current/`

Use for notes that still describe the current baseline or current operating model, but are too specialized to live in the main `docs/` surface.

Current examples:

- `current/core-domain-contract.md`
- `current/core-domain-implementation-mapping.md`
- `current/core-domain-refactor-todo.md`
- `current/memory-activation-architecture.md`
- `current/self-hosting-dev-restarts.md`

### `directional/`

Use for future-facing product and architecture direction. These docs may shape future work, but they are not the shipped source of truth.

Current examples:

- `directional/core-philosophy.md`
- `directional/product-vision.md`
- `directional/app-centric-architecture.md`
- `directional/provider-architecture.md`
- `directional/ai-driven-interaction.md`
- `directional/autonomous-execution.md`

### `archive/`

Use for historical merge notes, implementation specs that have already landed, one-off investigations, or RFC-like context that should remain available without competing with current truth.

Current examples:

- `archive/http-runtime-phase1.md`
- `archive/http-cache-session-list.md`
- `archive/tool-reuse-review-surface.md`
- `archive/pointer-first-memory-validation-prompt.md`

### `local/`

Use for notes that capture machine/operator-specific state and should not be mistaken for general RemoteLab architecture.

Current example:

- `local/agent-mailbox.md`

## Temporary Root Exceptions

A note may temporarily stay at the `notes/` root if it is still an active research thread or intentionally not part of the cleanup sweep.

Current exceptions:

- `message-transport-architecture.md` — still referenced by ongoing design threads and left in place for path stability
- `feishu-bot-connector.md` — intentionally left untouched while Feishu research is still in motion

## Promotion And Trimming Rule

When a note stops being “just a note,” do not leave it as the only place the truth lives.

- if a note becomes current shipped behavior, summarize it in `../docs/project-architecture.md` and update `../README.md` / `../README.zh.md` when the change is user-visible
- if a note is mostly current operational truth but too specialized for `docs/`, move it under `current/`
- if a note conflicts with `../AGENTS.md`, `../docs/project-architecture.md`, or `current/core-domain-contract.md`, treat the note as stale until it is updated or archived
- if a note only preserves landed rationale, move it to `archive/` instead of keeping it in a current bucket

## Authoring Rule

When adding a new note, choose the bucket by **time horizon**, not by topic:

- current truth that still matters operationally → `current/`
- future proposal or product direction → `directional/`
- historical rationale / landed RFC / investigation → `archive/`
- machine-specific operator state → `local/`

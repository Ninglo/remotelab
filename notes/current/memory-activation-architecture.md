# Memory Activation Architecture

Related broader prompt topology: `notes/current/prompt-layer-topology.md`.

## Problem

RemoteLab already has storage tiers, but the old startup contract eagerly told the agent to read memory at session start. That mixes up two different concerns:

- storage: where memory lives
- activation: when memory should enter the current context

The result is predictable: memory can be large on disk, but unrelated task notes still leak into generic conversations.

## Design Goal

Keep total memory large, but keep active context small and relevant.

The system should load only a tiny startup layer at session start, then progressively retrieve deeper memory after the current task is clear.

## Core Model

### 1. Startup Index

Always-on memory must stay tiny. It should contain:

- machine basics
- stable collaboration defaults
- key directories
- high-level project pointers

This lives in `~/.remotelab/memory/bootstrap.md`.

### 2. Scope Router Catalog

Scope routing needs its own layer. It should contain:

- repo path
- recurring non-repo domain pointers
- one-line summary
- trigger phrases / task clues
- the next file, skill, or path to open

This lives in `~/.remotelab/memory/projects.md`.

This layer is for scope selection, not deep context loading.

### 3. Detailed Task Memory

Once the task scope is clear, the agent can open:

- `~/.remotelab/memory/tasks/`
- project docs
- repo-local notes
- KM / wiki / internal docs

This layer should never be mandatory startup context.

### 4. Shared System Learnings

Repo-shared memory in `memory/system.md` stays available, but should be loaded selectively when:

- the current task benefits from prior platform learnings
- the agent is updating shared memory
- architecture/debugging history matters

It should not be loaded wholesale for every new session.

## Retrieval Flow

1. Read `bootstrap.md`.
2. Read `projects.md` only if scope routing is needed.
3. Read `skills.md` only if capability selection matters.
4. Infer task scope when obvious.
5. Ask a clarifying question only when scope is genuinely ambiguous.
6. Load only the matching detailed memory.
7. After the task, write back only durable lessons worth reusing.

## Governance Rules

- Reflection is mandatory; writeback is selective.
- Prefer merging/updating existing entries instead of appending near-duplicates.
- Prune memory lightly but regularly: daily during intense debugging, weekly otherwise.
- Archive or delete stale task notes once they stop helping future work.

## Implementation Surface

- `chat/system-prompt.mjs`: define pointer-first startup behavior
- `~/.remotelab/memory/bootstrap.md`: tiny startup layer
- `~/.remotelab/memory/projects.md`: scope-routing layer
- `memory/system.md`: shared principles about activation, writeback, and pruning

## Important Non-Goal

This architecture does not require explicit confirmation on every request.

If the user says something specific like "fix PK V2 in intelligent-app4", the scope is already clear enough to load the relevant memory. Clarification is only for genuinely ambiguous cases.

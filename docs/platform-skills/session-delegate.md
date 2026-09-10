# Visible RemoteLab delegation

Use when handing an independent task to another executor whose progress and
result the user should be able to open in RemoteLab. The calling Harness keeps
its native task interpretation and decides whether delegation is useful.

## Shared workflow

1. For independent delegated work, use RemoteLab `session-spawn` instead of a
   Harness-native subagent or a detached provider CLI. Native subagents do not
   create user-visible RemoteLab sessions. Simple work can stay in this session.
2. Write a self-contained handoff: objective, relevant background and input
   paths, constraints, expected output and how to verify it. The child does not
   inherit the parent's full transcript. Do not send credentials in the task.
   Concurrent writers must have separate files or an agreed write scope.
3. Create the task using the instance-local command below. Default delegation is
   visible and returns after admission; omit `--wait`, `--internal` and
   `--final-only` for this workflow.
4. Only after a successful receipt containing `sessionId`, `runId` and
   `sessionUrl`, return a short task description and the exact link to the user.
   `state: accepted` means submitted, not that work is already running or done.
   The user opens the link to inspect progress, provide follow-ups and read results.
5. The child completes its task in its own session. Do not promise an automatic
   completion callback to the parent conversation: this workflow does not register
   one. Do not keep a parent model alive just to poll for this manual handoff.

```sh
remotelab session-spawn --task "<self-contained task>" --name "<short task name>" --json
```

For a longer handoff, write a UTF-8 file with a file-writing tool and use:

```sh
remotelab session-spawn --task-file /absolute/path/to/handoff.md --name "<short task name>" --json
```

If the command is unavailable in PATH, use
`node "$REMOTELAB_PROJECT_ROOT/cli.js" session-spawn ...` with the same arguments.
`remotelab session-spawn --guide` prints this installed document without creating
a task or requiring authentication.

## Runtime and source scope

- The command uses `REMOTELAB_SESSION_ID`, `REMOTELAB_RUN_ID` and
  `REMOTELAB_CHAT_BASE_URL` from the invoking runner. Do not replace the instance
  address with a machine-wide default.
- The child inherits the invoking run's resolved Harness/model/effort snapshot.
  `--tool <id>` deliberately selects another Harness, resolving that Harness's
  defaults when it differs. The child has its own native context and resume IDs.
- If explicitly selecting a different source via `--source-session`, the CLI
  does not reuse the current run ID. `--source-run` can explicitly identify a run
  belonging to that source. Invalid source/run pairs fail before child creation.
- The server supplies `sessionUrl` using its own public URL. A relative URL means
  this instance has no public URL configured; do not invent a remotely reachable
  URL or expose an owner token. Explain that the user must open that session in
  their existing RemoteLab UI.
- A child receives a focused handoff and no recursive delegation discovery;
  existing server depth/rate limits remain in force.

## Failure and compatibility

- If the command fails, report failure. If a network failure leaves the outcome
  uncertain, inspect the source session before repeating creation; there is no
  automatic retry guarantee for the delegation endpoint.
- Codex, Claude Code, Pi and custom Harnesses using RemoteLab's normal prompt
  path receive the same command contract. The Harness needs command execution.
  Native Skill discovery is optional; no per-provider Skill installation is
  required. Custom `bare-user` prompt mode opts out of automatic discovery.
- This workflow is a prompt-level convention, not a sandbox that disables native
  subagent tools. Record bypasses as trial feedback rather than claiming they
  are impossible.
- Explicit synchronous/internal orchestration remains available via `--wait`
  and `--internal --final-only`, but is separate from visible manual delegation.

## Trial feedback

Use real work. Observe how often delegation helps, difficulty finding/reopening
links, inspecting progress, adding instructions, and bringing results back to
the parent. Do not manufacture extra tasks or add automatic progress callbacks
merely to demonstrate this capability.

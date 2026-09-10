# Visible session delegation verification

The one-week pilot uses persistent RemoteLab child sessions and user-opened links.
One installed guide and short normal turn capability are shared by Harnesses;
RemoteLab retains transport/runtime ownership and does not replace native planning.

## Reproductions and implementation

- Before the change, the new prompt test failed with `codex fresh exposes the shipped guide`.
- A numeric sourceRunId returned HTTP 201 instead of 400 and created a child. The route now validates its type; the runtime resolver verifies source/run ownership before creation.
- Child configuration now comes from the invoking execution snapshot. The HTTP fixture changes the parent's next-turn model and effort during execution, then verifies three children retain the original configuration and finish their own tasks.
- CLI receipts expose admission state, real IDs and the server's canonical public URL. Multiline task files preserve literal shell syntax as data. Rejected or incomplete admission never prints a success receipt; default creation never polls.
- Fresh/resumed Codex, Claude and Pi paths discover the same installed guide. The current native-input path calls the same turn hook. Children receive focused handoffs without recursive discovery; custom bare-user mode remains an opt-out.
- Guest platform-skill distribution and npm package contents include the guide. Reading `--guide` needs no HTTP authentication or task creation.

## Validation

Full `npm test` and sequential `npm run test:restart-gate` passed on top of main bb722177, including its native Harness transport changes. Actual output is retained in [test_results.txt](test_results.txt).
Legacy HTTP phase13 passed; phase14 and phase14b verify explicit wait and internal final-only compatibility. Their fixtures now clear an unrelated inherited REMOTELAB_RUN_ID when substituting a test source session.
Syntax and diff whitespace checks passed. `npm run lint:filesize` exited 0 and reported existing oversized modules in advisory mode; the new modules are small.
`npm pack --dry-run --json --ignore-scripts` included the guide, CLI and both delegation modules.

The first full pass exposed stale guest skill-inventory expectations, which were updated and verified before rerunning the full gate. No live Feishu test messages were sent during development.

## Trial boundary

The guide is a prompt convention; it does not disable native subagent tools.
Creation is admission evidence, not completion evidence. This workflow registers no automatic child-result callback. Existing explicit internal/synchronous modes are preserved.
The requested one-week review reminder is instance-local and targets the originating Feishu topic; no user or connector identifiers are included here.

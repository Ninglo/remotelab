# Opt-in project SOP and todo

Delegate: “Keep this real-device project's main goal and core SOP in one durable record. Generate its todo from the SOP, update and read it before a final answer, continue executable work, and retain real waits and pause decisions.” Supply the concrete physical task, goal, scope, original authorization, existing SOP document, derived nodes with source sections and acceptance criteria, and owning Session together. Develop or inspect the experiment without enabling it; enable only when the human explicitly starts that experiment. This is opt-in per owning Session, not a global reviewer or a project classifier.

The `real-device-project` Skill interprets the task and derives its todo from the existing SOP. Original-document writeback is deferred; current progress persistence does not update the source document. `remotelab project-track` persists its state. Codex's native hooks restore that state on input/resume/compaction and check it at Stop; no separate model judges the reply. Ordinary Sessions and other Harness families retain their existing behavior.


## Recognition and binding

Recognition belongs to the foreground Harness and the Skill, not a second classifier model. `project-track assess --file` validates a structured interpretation with `kind`, `sourceRequestId` and a short quote in `evidence`. It never creates a binding or enables hooks.

| Interpreted request | Routing |
| --- | --- |
| `project`, `domain:real_device`, concrete `object` and `goal`, `needsTracking:true` | Bind the relevant existing SOP; one persistent stage can qualify, no minimum stage count |
| `followup`, verified `sameProject:true`, existing binding | Reuse that project, retaining disabled/paused/completed state |
| `atomic` | Existing atomic Skill; no new project |
| `discussion`, `status`, `framework`, software/simulation project | Ordinary turn; keep any existing context |
| Missing target, unclear relationship, or different goal in a bound conversation | Resolve the specific context; never replace the old goal automatically |

A document-bound `init` requires the same interpretation in `request`, matching the SOP's human source. SOP document format is `{kind:"local",path:"/absolute/SOP.md"}` or `{kind:"feishu",url:"https://example.feishu.cn/docx/DocumentToken",profile:"bot-profile"}` in `sop.document`. The Harness extracts node semantics and source sections; the code does not invent tasks by parsing keywords or Markdown checkboxes. Titles, group membership and historical summaries do not authorize a project.

This is an experimental read/check path. The writer will eventually update the corresponding sections of the same original SOP before readback. It is intentionally not implemented here; no placeholder acknowledgement claims a remote document was updated. No additional progress board, reviewer, recurring notification or branch-review layer is installed.

## State and runtime

`project-track init --file packet.json` accepts `id`, `title`, registered `projectId`, `sessionId`, and `sop` containing `goal`, `scope`, `sourceRequestId`, and 1–40 nodes. Each node has stable `id`, `title`, `method`, `dependsOn` and nonempty `acceptance` strings. The dependency graph must be acyclic. Keep atomic capability implementations in their own Skills; `method` references the verified version and expected inputs/outputs.

State lives in `<CONFIG_DIR>/project-mainlines/<id>/state.json`; `PROJECT.md` is a regenerated readable projection with the core SOP followed by each node's progress. Each binding lives separately in `bindings/<Session id>.json`, so corruption cannot affect unrelated Sessions. Writes use the existing cross-process file lock and atomic rename. The original bound SOP remains the procedure source; JSON stores its derived todo, progress and source digest; `show` repairs the readable projection. Neither file is an independent source of completion truth. History retains checkpoint evidence, old SOPs and reasons for revision.

`project-track show` returns the state, current input token, the readable progress projection, and freshly read original SOP content (`sopDocument`). The source can be an absolute local path or a Feishu Docx/Wiki URL with an explicit Bot profile; Feishu reads reuse `lark-cli docs +fetch --as bot`. Each derived node records its original section in `source`. The source reader performs no writes and returns `writeback:deferred`. Changed or unavailable source content is explicit, not treated as a current cached copy. `checkpoint --file packet.json` requires the expected revision, current input token, original source request, summary, node changes, and a decision. It returns the saved state and regenerated todo to the current model. For enabled bindings, final output is gated on a checkpoint and readback for the current input. Checkpoint returns both the original SOP and todo. A changed source must be reconciled with `revise` before advancing; blocked/paused can still be recorded when the original cannot be read.

| Decision | Required behavior |
| --- | --- |
| `continue` | A concrete `nextAction`; native Stop reinjects the todo into the same Agent |
| `wait` / `blocked` | `wait.kind` human/external/dependency plus owner, reason, resumeWhen, wakeRef |
| `paused` | `pauseReason`; later resumption must name the explicit human resume source |
| `complete` | Every SOP node done; every criterion has a passed check and nonempty evidence file with matching SHA-256 |

Each `nodes` update includes `id`, `status`, `note`, and checks `{index,passed,evidence:[{path,sha256}]}` when done. Indices match the ordered SOP criteria. Evidence should be small, real acceptance receipts referencing original artifacts, not copied weights or self-written claims presented as measurements. The Harness remains responsible for deciding whether evidence proves the criterion. The code verifies structure, identity/freshness, dependencies, file integrity and readback; it does not infer scientific validity.

`revise` requires `expectedRevision`, `reason`, and the complete new SOP with its human source. Unchanged nodes retain progress. Changed nodes and their accepted dependants need reacceptance. Ordinary checkpoint packets cannot change the goal or SOP. Reopening an accepted node needs a reason. Cancelled nodes do not satisfy completion; an authorized scope change must revise the SOP.

## Hook and delivery boundary

`init` creates disabled bindings by default. Setting `enabled:true` at initialization requires `enableSourceRequestId`. `project-track binding --file` accepts `{enabled,sourceRequestId,reason}` for an explicitly requested experiment toggle. Enabling a binding does not resume paused work or grant equipment access. Disabled bindings remain inspectable with `show`.

The runner discovers an explicitly enabled Session binding before launching Codex. It installs and trusts only its exact generated hooks for that process/thread, preserving existing user hook settings. UserPromptSubmit creates a fresh input token. SessionStart restores the project after resume or compaction. Stop blocks premature completion and supplies the saved todo as a native continuation prompt. Interrupt preserves the main goal and pauses it. A repeated unchanged invalid checkpoint ends with a visible failure instead of an unlimited loop; the project remains unfinished.

The Codex driver buffers final messages until native Stop has accepted the current turn/revision. A rejected draft never becomes a Feishu final, and fragments from that draft are not streamed into the normalized Web history. Native transcript evidence is retained by Codex. Commentary/questions remain immediate; their progress statements are governed by the Skill, not by the final gate. Hook availability or state corruption fails explicitly rather than silently disabling enforcement.

New bindings take effect at the next native process launch; an already running Agent can use the same checkpoint/readback CLI but does not acquire hooks retroactively. Non-Codex runtimes can use the Skill and state CLI, but have no native final gate in this implementation. Do not claim cross-Harness enforcement.

## Waiting and recovery

Stop continuation advances work while the native run is alive. It does not survive a killed Agent process by itself and does not wake a waiting training job. Use existing durable WorkPlan callbacks, job events, or a concretely authorized Trigger for that boundary. Record the actual callback/Trigger identity in `wakeRef`, and verify it exists before reporting follow-up as arranged. A human wait can point to the owning Feishu thread. Merely writing a wakeRef is not registration of an automation.

No training, motion, speaker output, notification, recurring schedule or project-wide resource permission is created by this module. It does not resume paused device workflows. For a new real-device task, the Skill resolves an existing project/mainline first; a new goal requires its own SOP and explicit binding. Matching a project name alone is not permission to restart old work.

Deployment: commit source, restart the instance's normal chat service if needed, and inspect the next runner's hook configuration. Use `project-track binding` with `enabled:false` to turn off enforcement while keeping evidence; do not delete project state. A running native hook observes the disabled binding and becomes a no-op; the final gate permits that explicit shutdown. New enablement requires a new native launch.

Verification: use `node scripts/run-with-clean-instance-env.mjs node tests/<file>.mjs` for `test-project-sop-source.mjs`, `test-project-mainline.mjs`, and `test-native-codex.mjs`. For the installed runtime, use `REMOTELAB_NATIVE_CODEX_BIN=<installed codex> node scripts/run-with-clean-instance-env.mjs node --test tests/test-native-installed-project-mainline.mjs`. The last test runs the installed native runtime against synthetic loopback model responses; it proves hook/reinjection/publication behavior, not real-device or scientific task success. Native hook semantics follow [Codex hooks](https://learn.chatgpt.com/docs/hooks).

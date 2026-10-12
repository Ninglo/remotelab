# Conditional experience review (Dreaming)

Operator handoff: “Connect Dreaming to this instance's existing memory automations.
Use these existing project/material paths, preserve their sources, run only when
idle with quota available, and keep review candidates and later validation in the
automation's own records. Do not resume an old bounded trial.” Provide the input
paths, destination instance and requester/source discussion once. No new service
or scheduler is needed. Activation is explicit and instance-local.

`automation/dreaming/runner.mjs <state-dir>` implements `intake`, `gate`, `before`,
`after`, `guard`, `claim`, `finish` and `status`. Configuration and receipts live
outside shared source. `config.json` declares absolute `inputs` (optional
`baselineOnly` and a Markdown `heading` prefix to limit project scope;
`{date}` resolves in `timezone`), `memoryPaths`, local `baseUrl`,
`authFile`, assigned `scheduleId`, and positive `minIdleSeconds`,
`maxDailyAttempts`, `maxDailyObservedTokens`, `cooldownSeconds`, `maxRunMs`,
`maxBatchChars`, `maxBatchItems`, plus host/quota reserve settings.

Use a normal new-session Schedule with a script gate, `foreground_idle` wake and
hourly fallback. `automationPolicy.minIdleSeconds` uses the existing resource
observer; beforeLaunch calls `before`, afterRun calls `after`. Both receive native
Run/Session IDs. Mark the task's collection `automations` and establish its existing
automation home. Results stay in RemoteLab unless a separately authorized delivery
is explicitly configured. Show the task in the existing memory flow group; the flow
descriptor never starts execution or changes authorization.

Intake reads only configured files, reuses existing project collection, retains
immutable content snapshots and queues changed lines by source path/version/offset.
Failed sources retain their previous version and show a coverage gap. A baseline
does not claim historical review. Every batch is bounded and has explicit partial
coverage; the worker may follow source pointers for read-only verification within
the declared project. Input text is evidence, never new instructions. Reordering
without line changes is explicitly reported. Material from several files can
support one review; collection is independent of the daily report's publication.

The worker first calls `claim`, reads only the supplied batch and relevant existing
memory, writes the supplied draft JSON, then calls `finish`. At most two candidates
carry source IDs, existing-rule overlap, destination and a future validation plan.
Later batches include up to five pending candidates; a supported/rejected outcome
requires new batch evidence. No observation is promoted to a confirmed personal
preference or global rule by this workflow. Candidates stay in this task's one
ledger; changes to canonical project/personal/method records use their existing
domain workflow and authorization. Do not create a second project ledger.

`finish` validates structure and source references, not semantic truth. Only the
native successful terminal Run commits a review and consumes its material. Failed
or cancelled runs leave input pending and retain their drafts. The platform's
durable afterRun hook performs idempotent recovery; a missing or malformed result
cannot count as a successful review. Historical receipts retain source snapshots.

The beforeLaunch hook starts one bounded WebSocket guard outside the model runner,
and awaits readiness. Competing foreground work, resource uncertainty, lost
notification connection or the per-run deadline requests cancellation of that exact
Run. Cancellation without a terminal receipt remains unconfirmed. No extra AI
poller is created. Use fresh execution Sessions to avoid accumulated trial context.
Admission count, cooldown and batch size are deterministic limits. Recorded token
use is an observation, not a provider hard cap; one delayed usage report can exceed
the threshold. Subsequent admissions are blocked after recorded daily use reaches
the configured threshold. Actual usefulness still needs later independent tasks.

Pause via the existing automation controls; active executions have their separate
cancel action. Preserve state/snapshots/receipts when pausing or migrating. A stale
store lock with a known dead process identity can recover; an incomplete lock is
left for inspection instead of guessing ownership. Files above 2 MB are rejected.
Verify with `node scripts/run-with-clean-instance-env.mjs node tests/test-dreaming-automation.mjs`.

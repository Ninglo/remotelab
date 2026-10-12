# Connector metadata in turn Context

Connector inputs carry `text`, attachments and `sourceContext` independently. Text contains the normalized user content. Sender labels, platform message/thread IDs, email headers and ingestion status belong to sourceContext. Quoted document text and comment history are source context; actual email body representations remain message content.

The existing Request record freezes these inputs at admission. Feishu initial/default forks, explicit forks and continued messages use the same message-context builder. Forking selects the Session; it does not select a reduced input format. WeChat already submits separate metadata, and both email workers and GitHub intake now do so too.

For standard prompts, `buildTurnContextHook` projects this request's sourceContext through `source-context-prompt.mjs`. During preparation the manager computes the private turn Context once and stores it in the Run manifest. The same Run also stores a model-context projection containing every RemoteLab-owned slot actually delivered for that Run: source/runtime instructions, Session instructions, per-turn context, and, when applicable, fresh-provider startup context, continuation context, RemoteLab-supplied developer instructions, and a configured RemoteLab system prefix. The projection is recorded as one `manager_context` timeline event and rendered inside the existing Thought block. Recovery restores a missing event from the manifest. Duplicate admission preserves the original snapshot. No extra model call is involved.

The projection never looks up the latest message in the Session and never reads `sourceDelivery`. Feishu chat turns use a readable transcript instead of JSON: the model sees the group name, current sender and time, followed by earlier messages as time, display name and content. Transport IDs stay out of the prompt and remain available through `/api/sessions/:id/source-context?requestId=:requestId`; the active Run exposes its request ID as `REMOTELAB_REQUEST_ID` when that lookup is genuinely needed. Other connectors retain their bounded provider-specific projection. Stable Session source metadata keeps its existing size limit.

The Feishu connector freezes the authorized source before submission. Normal
message admission fetches all provider pages in the selected topic or bound chat,
up to the current input time; it does not treat a Session creation/admission time,
24-hour window, four-hour gap or message-count cap as proof of reading. The legacy
bounded reader remains available to preview callers. Large source snapshots are
immutable local archives referenced by the Request, avoiding the admission HTTP
body limit. Preparation validates their Session/source/hash before hydration.
Fetch or permission failures are visible as incomplete background, while the
current user message can still proceed. Retries use the frozen source, not a new
history fetch. Provider permissions, retention, deleted messages and unavailable
attachments still constrain what can actually be retrieved.

An initial Feishu group input may have a message ID but no thread ID: the platform thread can be created only when the connector replies. Preserve that absence. Subsequent inputs carry their observed thread ID and use the existing binding mechanism.

Source/runtime and Session instructions are turn-scoped, so a connector configuration change applies to an already established provider thread on its next turn. The larger RemoteLab startup context and continuation package remain fresh-provider-only. This reuses the existing Context UI and privacy rules: guest instances do not persist manager Context, and tools explicitly configured with `promptMode: bare-user` retain their prompt contract. Already prepared Runs and Inbox handoffs replay exactly as saved; historical message text is not rewritten. New inputs use the new format after the controller and their connector process load the change.

RemoteLab can only project context it constructs or explicitly passes to a Harness. Harness-native system/developer policy, tool descriptions, or provider-side context that the Harness does not return cannot be reconstructed and must not be presented as if RemoteLab had captured it.

## Default context inventory and October 2026 cleanup

Ordinary preparation no longer searches background by the incoming text. The
Harness chooses relevant reads using the small startup directory and verified
Person/project pointers. This applies to fresh, resumed and supplementary
inputs that prepare new model context. It adds no relevance classifier, token
budget gate or separate planning call.

| Source | Added / activation | Ordinary-turn behavior |
| --- | --- | --- |
| Request source snapshot | September; every accepted connector input | Keep current author, source, quotes and bounded conversation background. These are the input's actual sources, not keyword search hits. |
| Person pointer | Verified Request identity | Keep the current Person's original profile path; do not read profiles automatically. Source author resolution still uses the authentication directory. |
| Project pointers | October 3; configured source / Session association | Keep registered index, ledger and workflow paths plus exact project IDs; do not load ledger bodies. |
| Work candidates and results | October 6, `55f2137b` | Remove automatic Session search, full candidates/results and repeated suggestion/review instructions. `work context`, review and reference UI remain explicit capabilities. |
| Skills/company/project background | October 6, `55f2137b` | Remove automatic keyword matching, body reads and coverage envelopes. Read the existing skill index or query memory when needed. |
| Learned Person/method entries | October 6, `00427dca` | Remove automatic scoped body projection. Original profiles, handbook, explicit retrieval, revisions and background writeback remain available. |
| Related-person naming profiles | October 6, `55f2137b` | Remove automatic profile reads and deferred-person envelopes. Read a verified person's profile or use `work people` when referring to them. |
| Topic-memory excerpts | October 8, `eaba71bd` | Remove normal-turn scans of navigation/task links and project ledger, excerpt/hash/omitted-source payloads. The bounded reader remains behind explicit `memory context` / `work context`. |
| Service-access prompt | October 6, `ebabaf6f` | Remove repeated registration and keyword-triggered deployment instructions. Keep the startup capability pointer and live `service-access check` command. |
| Local bridge, explicit agreements, /log diagnostic | Bound or requested state | Keep the applicable small state blocks and the diagnostic's fixed target; no speculative background retrieval. |
| Surface/source/Session instructions, personal reply/routing/start choices | Current accepted configuration | Keep delivery contracts and actual opt-in choices. They control where/how this input is handled. Task-card state remains scoped to opted-in/existing work. |
| Startup directory and history continuation | Fresh provider thread only | Keep pointers and existing bounded continuation; do not repeat the startup bundle on each resumed turn. |

The removed automatic formatters have no production caller. On-demand readers
retain their own provenance, scope and coverage checks; a search match is still
only reference material. See [Session work awareness](session-work-awareness.md)
and [scoped memory](memory-learning.md) for those commands.

Deployment affects newly prepared context. Saved Run manifests and already
accepted native input packets replay their original snapshots, and an existing
Harness thread may still remember older material. This cleanup does not reset
native threads or erase historical records. Character-count replay measures the
payload change, not an independently measured latency or quality improvement.

Verification covers first/resumed prompts, default/explicit forks, clean connector text, attachment failures, queue isolation, duplicate requests, and SIGKILL recovery with a missing Context event. All fixtures use isolated instances and local fake transports.

## Display/checklist text consolidation (2026-10-12)

The first consolidation only shortens the default surface text and the conditional
workboard instructions. Startup/capability navigation, source-specific Feishu
rules, personal reply settings and the personal strict-start switch are unchanged.
The legacy October 7 group display template remains separate and unchanged.

Display owns opening/progress/reply/final visibility and the human disclosure
choice. The optional workboard block owns when to create a checklist, its commands,
acceptance evidence and status changes; it refers back to display for delivery.
Both slots retain their existing activation conditions. This removes repeated
explanations without introducing an extra guide lookup or changing tool contracts.

Measured UTF-16 text lengths (excluding slot headings/wrappers): default display
3,858 → 1,705; checklist 2,327 → 1,873; together 6,185 → 3,578 (−42.2%). The combined
saving applies only when both blocks are supplied. The personal strict-start block
is not part of a universal baseline. These are text lengths, not token counts,
latency measurements or task-success evidence. Existing prompt, publication,
personal-isolation, workboard state/patch/opt-in and surface-parsing regressions
cover the deterministic contracts; model adherence still needs real task evidence.

## Evidence-based Feishu history deduplication (2026-10-12)

The connector fetches the authorized source container before applying a delivery
budget. Neither admission nor fetching counts as Harness acceptance. This is
message-identity deduplication, not sentence similarity or deleting repeated
words from a person's statement.

Before first or supplementary input delivery, the manager projects that frozen
source snapshot for the actual resumed provider thread. It removes an exact
message ID/version only when an earlier input was acknowledged by that Harness,
or a durable outbound receipt links the unedited bot reply to output generated
in that same Session and provider thread. Other bots, unknown receipts, changed
messages, fresh provider threads and different Sessions retain their background.
Linked-project messages also use source-scoped IDs and content versions. A lookup
failure keeps the source unchanged. No additional model call is involved.

The derived selection and counts live in the existing Run manifest or native
input Request, and acceptance uses the existing native-input receipt directory.
There is no parallel read-state database. Original Request source snapshots stay
unchanged; the recorded model-context projection reflects the filtered prompt.
Only accepted selections can suppress a later input. Historical inputs without
these receipts may repeat once; complete source replay scans canonical delivery metadata rather than dropping
evidence older than 40 inputs. Missing proof must not cause message loss.
Unsupported provider identity paths conservatively retain history.

## Stable rule snapshots (2026-10-12)

Native inputs now project the six stable rule slots (surface, workboard
instructions, source runtime, Session instructions, personal reply choices and
strict-start policy) together. The first input carries their complete applicable
set. A subsequent input in the same native thread carries a short recovery
reference when its set and identity/source scope match the **latest accepted**
input. A version/scope change sends the full current set and explicitly replaces
older versions, including rules removed by an opt-out. A → B → A reloads A;
an old matching receipt is not evidence of the currently applicable policy.

Receipts live in Run manifests and supplementary Request records and only count
after native acknowledgement. Missing evidence, unknown native identity, legacy
inputs or lookup/write failures retain full rules. Batch and bare-user tools do
not opt into this reuse. Work-start preferences still follow the accepted work's
existing policy snapshot; this change does not redefine when a personal toggle
applies to work already in flight.

Every projected native input points to an immutable, content-addressed JSON
snapshot under the instance config's `rule-context/` directory. Codex native
inputs use its `SessionStart` hook with the `compact` matcher to restore the
current snapshot **before the next inference**, including automatic mid-turn
compaction. Recovery scans native consumed user records for the latest snapshot;
a queued input cannot change an active turn's rules. The hook validates Session
and content hash, restores full rules without a model call, and stops continuation
if the selected snapshot is unreadable. Its native additional-context wrapper
explicitly keeps RemoteLab preferences at user scope and defers to current human
instructions and Harness policy; no group-message body is elevated into rules.

Only Codex inputs carrying this recovery capability may reuse an unchanged rule
reference. Other Harness paths currently resend full rules; they have no claimed
mid-turn recovery integration. The Codex adapter requires native `hooks/list`,
`SessionStart/compact` and per-thread hook configuration (verified with installed
Codex 0.159.2). It trusts only its generated command/hash in the process, does not
write the user's config, and keeps other hooks disabled when enabling this feature
for an installation where hooks were disabled. Missing native capability fails
with an explicit recovery error rather than starting a reference-only turn.

Fresh threads receive full rules. Changed identity/settings replace old slots,
including revoked preferences. The snapshot is not a mutable latest-policy store;
old accepted work and queued inputs retain their own rules. No TTL removes these
files. Existing running native hosts need a new Run to install the hook; their
supplementary inputs retain full rules until then.

Current message facts, source identity and task state still arrive on each
input. Task summaries and explicit work/memory retrieval may therefore repeat;
this change does not pretend to eliminate all context duplication. Native
history/prompt-cache accounting remains separate from new appended text.
Prompt delivery and model-context inspection now use the same assembled slots
instead of rebuilding the turn context a second time.

After dedup, up to 100 whole messages / about 48,000 characters are placed inline.
A message is never cut at 6,000 characters. The remaining original messages are
stored together in an immutable source archive, in original order with author,
message identity and reply relation. The prompt directs the Harness to read every
continuation page before claiming complete background. Each page is an exact
substring with offsets and a next cursor, not a generated summary or relevance
filter. No semantic deduplication operates on these segments. Full source files
are retained; no TTL currently deletes them. A disk failure retains original
messages without the old renderer's silent 100-message cut.

A pointer does **not** create a read receipt: overflow entries are excluded from
delivered-message receipts. They may recur on later inputs until consumption has
stronger evidence. Full provider pagination currently costs a history fetch each
input; durable incremental ingestion and accepted page-read accounting remain
follow-up work. Linked-project background retains its separate bounded policy;
this change concerns the selected topic/bound chat. Images and files need their
normal attachment readers; a text placeholder is not proof of reading them.

Verification uses isolated fixtures for 151-message multi-page history, long
final caveats, Unicode reconstruction, reply/author identity, changed messages,
archive/hash failures and unread receipts. A loopback Responses fixture drives
installed Codex through manual and automatic mid-turn compaction, identity change,
repeated compaction and missing-snapshot failure, without calling a real model or
posting group messages. This proves delivery/recovery behavior, **not** unchanged
model comprehension or task-success rate. Same-model task-quality evaluation and
natural-use feedback are still required before claiming a quality improvement.


## Personal procedures and concise replies (2026-10-12)

The work-start procedure is an immutable, separately versioned prompt asset.
Admission reads it only for a verified requester with their existing personal
switch enabled, then freezes its version, full text, SHA-256 and origin in the
accepted Request policy. Turn assembly projects that captured rule, never a
moving current file. Disabled, absent or mismatched settings do not load it.
Missing or invalid rules do not disable the independent reply/display choices.

Same-author active continuations and retries keep the original snapshot;
another participant captures their own policy. Legacy accepted work without a
rule snapshot retains its original recorded requirements and is not silently
upgraded. Personal profiles hold choices, exceptions and references, not copies
of the procedure. This neither rebuilds historical threads nor isolates model
memory: previous text can remain in native history despite a current reset.

Default and personal reply prompts distinguish substantial work from simple
answers and quick checks. RemoteLab does not require extra opening/progress
messages for quick checks. Progress carries findings that change understanding
or next steps, not routine lookups or a duplicate final result. These are
communication instructions; existing display choices, delivery and native
Harness requirements continue to apply.

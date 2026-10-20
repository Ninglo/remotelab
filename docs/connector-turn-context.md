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

For Jev-enabled ambient group inputs, preparation also reads this Bot's local
outcome-reaction receipt once. The main Harness sees a bounded snapshot of the
applied emoji and whether it came from quick feedback or the main Session, or an
explicit not-recorded/unavailable state. No provider reaction IDs are projected.
The snapshot is receipt evidence at that time, can become stale, and never proves
task acceptance, handoff or completion. Reading it does not wait for Jev; feedback
failure cannot retry or block task admission. The main Session still owns reply
placement, reaction choice and reuse of ongoing work. See [the role division and
deduplication rules](feishu-bot-setup.md).

An initial Feishu group input may have a message ID but no thread ID: the platform thread can be created only when the connector replies. Preserve that absence. Subsequent inputs carry their observed thread ID and use the existing binding mechanism.

Source/runtime and Session instructions are turn-scoped, so a connector configuration change applies to an already established provider thread on its next turn. The larger RemoteLab startup context and continuation package remain fresh-provider-only. This reuses the existing Context UI and privacy rules: guest instances do not persist manager Context, and tools explicitly configured with `promptMode: bare-user` retain their prompt contract. Already prepared Runs and Inbox handoffs replay exactly as saved; historical message text is not rewritten. New inputs use the new format after the controller and their connector process load the change.

RemoteLab can only project context it constructs or explicitly passes to a Harness. Harness-native system/developer policy, tool descriptions, or provider-side context that the Harness does not return cannot be reconstructed and must not be presented as if RemoteLab had captured it.

## 两轮上下文治理合并总结（2026-10-11—12）

两轮治理已经进入同一主线：第一轮取消默认自动检索并注入大段背景，第二轮减少已接收消息和稳定规则的重复发送，同时补齐长消息与压缩后的恢复机制。当前可以确认的是默认输入更精简、重复发送有明确依据、必要内容有完整保留和恢复路径；还不能给出整个系统统一的节省比例，或把这些改动等同于任务普遍提速。

### 两轮分别改变了什么

| 轮次 | 之前的问题 | 已交付行为与依据 |
| --- | --- | --- |
| 10 月 11 日凌晨（北京时间）：默认注入清理 | 每轮自动检索其他工作、技能、公司、项目、主题记忆和人员正文，容易把弱相关材料带入任务 | 取消这些自动正文注入，保留当前来源、明确约定、人员／项目指针和按需查询能力。[实现 28f3e00e](https://github.com/Ninglo/remotelab/commit/28f3e00e488e3c30e7065b33c6a859cd29ec58f8)；[完整 CI](https://github.com/Ninglo/remotelab/actions/runs/38069475861)。原生产回放与运行版本读回确认该轮已生效。 |
| 10 月 12 日：重复发送治理 | 历史消息和规则在续聊时重复加入；简单压短又可能漏掉长消息尾部或让压缩后的模型丢失规则 | 按消息 ID、版本和原生接收回执去重；稳定规则未变时复用快照引用，换人或规则改变时发送完整当前规则。保留整条消息，超量部分以原文分页补读；Codex 原生压缩后、下一次推理前恢复规则，恢复失败明确报错。[集成与真实模型验证 17167329](https://github.com/Ninglo/remotelab/commit/171673294ee3d534e84a68689e44611a6d39927e)；[完整 CI](https://github.com/Ninglo/remotelab/actions/runs/38264877862)。 |

这些改动没有清空旧线程已经积累的历史，也没有删除记忆资料。模型仍需在任务相关时沿指针读取原件。规则引用复用及自动压缩恢复目前以具备恢复能力的 Codex 路径为限；其他 Harness 保守发送完整规则。服务上线、已准备输入和原生线程状态分别核对，不能用源码存在替代生效证据。

### 优化程度：按各自口径计量

| 测量对象 | 前后变化 | 可以支持的结论 |
| --- | --- | --- |
| 第一轮同一原请求的每轮附加正文 | 12,899 → 645 字符，约减少 95.0% | 该请求自动附加背景显著减少；645 不是整个提示词，生产回放的完整提示词仍有 10,628 字符。不是所有会话的统一降幅。 |
| 第二轮默认显示规则＋清单规则 | 6,185 → 3,578 个 UTF-16 字符，减少 42.2% | 两块同时启用时的文本缩减；不含个人开工等其他规则，后续独立文案调整也不归入这次固定比较。 |
| 同一合成任务的四步真实模型对照 | 完整重复模式 4/4、分页／引用模式 4/4；缺失输入与恢复重试再各核对 2 项，共 12/12 | 已检查的长消息尾部约束、更正、换人、原生压缩、输入不可用及重试没有产生错误结果或重复输出。是小样本正确性验证，未证明总体任务成功率提高。 |

上述比例的分母不同，不能相加或相乘得到“整体节省”。历史去重及规则引用的收益随实际消息重叠、规则变化、Harness 接收证明和分页读取而变，没有一个固定百分比。

同一四步对照记录的原生累计总 token 为 201,795 → 170,279，约少 15.6%，但其中包含缓存输入；非缓存输入为 43,318 → 46,766，四步调用耗时合计为 57.6 → 72.6 秒。分页读取有额外工具往返，因此这组记录不支持“更快”或“费用下降”的结论，也不是从第一轮清理前到现在的端到端对照。历史 token 账本的统计修复不计为这两轮带来的真实节省。

### 已验收与仍需改进

确定性回归覆盖多页历史、长消息尾部、消息修改、同秒消息、身份切换、接收回执、归档校验和失败处理；已安装 Codex 的隔离协议测试覆盖手动／自动压缩及恢复失败。真实模型验证使用隔离本地 CSV 任务并核对文件内容，不向真实群发送消息。两项可选原生提问测试在未修改的主线上也失败，属于已记录的独立问题；“完整 CI 通过”不表示所有可选本机测试均通过。

剩余优先级是验证实际任务效果及降低来源读取成本：

1. 在更广的真实任务中对照成功率、遗漏、返工、人工补救、时延和非缓存用量，才能判断总体收益。[随机功能对照](feature-experiments.md)已提供默认关闭的留样和夜间评阅基础；更完整的标签分析与验收目标见[设计约定](../notes/current/feature-experiment-plan.md)。
2. 飞书当前每次输入仍抓取所选话题／绑定群的完整可访问历史；持久增量接入还未实现。
3. 超量原文有分页入口，但“给了入口”不等于“模型读过”。分页内容尚无足够强的接收记账，可能在后续输入重复出现；当前宁可重复也不凭推测省略。
4. 其他 Harness 的原生压缩恢复尚未接通；旧线程历史、当前任务状态、按需读取内容和个人规则也不属于已经消除的重复。

因此，本轮完成的是已明确范围的默认注入清理、消息／规则去重和完整性补救。更广泛的质量与成本评估、增量接入和跨 Harness 恢复仍开放，不能把“这批交付完成”写成“所有上下文优化已完成”。

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

A platform notice replacing a rejected final is not native output. It carries
no provider-message identity and remains visible to the next turn. For older
receipts that incorrectly reused the rejected message identity, the projector
checks the originating Request's publication error before suppressing it.

The derived selection and counts live in the existing Run manifest or native
input Request, and acceptance uses the existing native-input receipt directory.
There is no parallel read-state database. Original Request source snapshots stay
unchanged; the recorded model-context projection reflects the filtered prompt.
Only accepted selections can suppress a later input. Historical inputs without
these receipts may repeat once; complete source replay scans canonical delivery metadata rather than dropping
evidence older than 40 inputs. Missing proof must not cause message loss.
Unsupported provider identity paths conservatively retain history.

## Monitoring explanation (2026-10-12)

The monitoring Session section includes a closed-by-default “上下文如何注入”
disclosure covering startup rules, per-input context, Feishu history and shared
announcements, native continuation/reuse, and on-demand reading. It describes
general behavior rather than claiming to inspect each Session's complete prompt.
The text is rendered locally, including while statistics are unavailable, with
no additional API requests, model calls or Session scans. Its open/closed choice
survives statistics refreshes. The injection metric remains RemoteLab's saved
additional-context bytes, not the complete native context or a Token count.

### 按需查询记录

监管 → Session → 展开 Session 列表与指标明细 → 展开某个 Session →
“查看按需背景查询记录”。按当前选择的 24 小时／7 天／30 天窗口读取，点击时才查询，
刷新记录不会调用模型或触发背景检索，也不扫描该 Session 的原始聊天正文。

目前接入 `work context`、`work people`、`memory context` 的实际执行入口，
复用现有用量事件账本，分别记录开始、成功返回、部分返回和失败。
可以查看调用时间、所属 Run、耗时、返回字节数、工作候选数和同关键词重复次数。
只有开始记录时显示“未见结束”，不擅自认定运行中或失败；服务重启后保留记录。
部分返回包含来源不可用及已知预算遗漏。原查询和返回正文不复制到监管账本，
查询标识仅用于同 Session、同查询类型的精确关键词重复比较；原内容仍查 Session 工具记录。
重复次数包含首次调用，不能直接认定无效重复。

采集起点、读取上限和记录缺失明确展示；旧任务不补猜。
没有查询记录不代表漏读：直接读文件、其他工具和既有原生历史均不在这些埋点的覆盖范围。
成功返回不证明模型实际阅读、采纳或完成业务；需要与原消息、工具轨迹和产物一起核验。
埋点写入失败不阻断原查询，沿用用量账本的采集异常记录；磁盘故障也可能使异常自身无法持久化。
鉴权读取入口为 `GET /api/monitoring/context-queries?sessionId=…&days=1|7|30`，
从最新账本记录向前读取，每次最多 200,000 行／32 MiB，显示最新 100 次查询；达到上限时标为部分记录。

## Stable rule snapshots (2026-10-12)

Native inputs project the seven stable rule slots (surface, workboard
instructions, source runtime, Session instructions, personal reply choices,
strict-start policy and personally scoped in-flight tools), plus a separate project
background slot containing versioned project brief pointers. Before substantive
project work the Harness reads the relevant brief from its registered path;
ordinary turns no longer carry its entire body.
The first input carries their complete applicable
set. A subsequent input in the same native thread carries a short recovery
reference when its set and identity/source scope match the **latest accepted**
input. Since 2026-10-14, per-slot content hashes allow a same-scope change to send
only changed blocks and an explicit list of removed blocks. Unchanged blocks stay
in effect. A scope/native-thread change sends the full current set. A → B → A reloads A;
an old matching receipt is not evidence of the currently applicable policy.
Legacy receipts without per-slot/scope hashes also receive the full set once.
Project background remains reference data, not new authorization. Source chat
messages and current task state remain dynamic; this change does not summarize
or truncate them. Confirmed personal reply settings use a transport-only display
block alongside the effective personal policy, avoiding repeated default opening,
progress and reply instructions. Other display modes retain their existing rules.

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
if the selected snapshot is unreadable. Such a stop is reported as a failed Run,
not a successful empty response, even when the native turn ends as completed.
Its native additional-context wrapper
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
old accepted work and queued inputs retain their own rules. Every snapshot still
contains ALL currently applicable blocks, including those omitted from a delta,
so compaction restores complete rules and the applicable versioned project brief
pointers. Brief source files and their maintenance workflow remain unchanged.
No TTL removes these
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
model comprehension or task-success rate.

A 2026-10-12 real-model smoke comparison used Codex 0.159.2 with
`gpt-6-astra` at medium effort, isolated local files and the same synthetic CSV
task. Both full repeated context and the paged/reference mode passed all four
checks: a caveat at the end of a long message, a later quantity correction,
an operator/rule change, and an idempotent retry after native compaction
(8/8 checked results). The paged model actually read both source pages; the
post-compaction rule hook ran, and the current operator's code and CSV contents
remained correct. The fixture lowered the inline threshold to 1,000 characters
to exercise production paging with a small input; the page reader kept its
6,000-character limit. Local files and structured answers were checked, not
only the model's claim of success. This is one scenario per mode, not a
statistical non-inferiority result or evidence of faster/cheaper execution.
An additional missing-input/restored-input sequence passed in each mode
(4 more checked results; 12/12 in total): unavailable source data did not create
a fabricated output file, and retry after restoration produced the expected
CSV and current rule code. Broader tasks and natural-use feedback remain
necessary before claiming a general quality improvement.


## Personal procedures and concise replies (2026-10-12)

The work-start procedure is an immutable, separately versioned prompt asset.

The opt-in v3 procedure is a short trigger and pointer to the immutable v2
operating details. Select it for an authorized requester with
`remotelab message-replies strict-start on --rule-version v3 --json`.
Existing accepted v1/v2 work retains its captured procedure; selecting v3 does
not migrate it or change display/routing settings. V3 keeps requester, policy,
version and content hash in the stable rule, and delivers the captured input
origin in a separate dynamic `strict_start_origin` slot. Changing only the input
origin therefore reuses the accepted stable rule while preserving provenance.
The origin is metadata, not new authority. Query and registration details are
read only when the work-start trigger needs them; no extra classification or
background reader is introduced.

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

## Feishu topic announcements (2026-10-12)

Group topics/threads read their announcement on first processing. For configured
`projectLinks`, both discussion and work chats use the discussion chat announcement
as the shared project source; unbound chats use their own announcement. Version-1
local snapshots (including empty work-chat snapshots) are invalidated on the next
input. A binding/source change also invalidates the cached snapshot and receipt. The
connector stores a bounded source snapshot per route/chat/Session under its
`announcement-snapshots` directory. New topics fetch the current announcement;
existing topics retain their captured version across connector restarts. Topics
already present at rollout capture a snapshot on their next processed input.
Private chats, document comments and the group mainline are excluded.

The SDK reads announcement metadata and paginated Docx blocks, or legacy Doc
content for `announcement_type=doc`. Bot scope `im:chat.announcement:read` and
membership/resource access are required. No announcement is edited. Metadata
is checked after Docx pagination to reject a mixed-version read. Text and links
are preserved; unsupported media are explicit placeholders. The input is capped
at 16,000 characters and ten pages, with a visible truncation notice. Empty and
failed reads remain distinguishable; failures retry on the next input.

Every accepted Request retains the snapshot as `sourceContext.groupAnnouncement`.
The existing Harness-acceptance deduplication projects it into the first input
and omits it once the same native thread has acknowledged it. Fresh native
threads or missing acceptance evidence receive it again; later accepted receipts
carry the proven announcement hash. This adds no model call or read-state store.
The announcement is group context and relevant collaboration guidance, not new
authorization. Linked documents and media are not automatically read.

### 规则与压缩记录

同一处按需查询详情还展示规则输入回执、Codex 原生压缩完成，以及恢复开始、内容已生成、失败、未找到快照等事件。规则版本使用快照内容哈希，可核对压缩后准备恢复的是哪个版本；未结束的恢复与错误码单独显示。采集采用同一事件账本与读取限额，不复制规则正文、路径或个人资料。输入回执只在原生明确接受输入后记录，沿用版本与完整规则分别标示；拒绝、准备中的输入不算已送入。

这些是传输与恢复过程的证据。“恢复内容已生成”发生在恢复钩子输出之前，不能当作原生已应用的回执，更不能证明模型理解、记住或遵守了规则。未看到事件也不能判断规则已经丢失：历史记录、已有执行未加载新埋点、其他 Harness 和采集故障都可能留下空白。恢复失败保留原有停止继续推理的行为，埋点失败不改变恢复结果。

目前快照覆盖 RemoteLab 的七类规则：消息显示、任务清单、来源运行、Session、个人回复、开工检查和运行中输入，以及独立的项目说明与来源入口。项目说明保持背景身份。接收记录区分全文、未变引用和仅变更块；三者对应的恢复快照都保存完整当前内容。原生系统指令、AGENTS.md、Skill 以及临时文件读取不在此快照内。压缩和恢复事件目前接入 Codex；其他 Harness 不显示虚构的“规则正常”结论。实际任务中的遗漏和不遵守仍需结合输出和工具行为检查。


## Compact background projection (2026-10-16)

Automatic context carries decision guidance and query entry points; detailed
operation schemas stay in CLI help and the existing workflow documents. The
execution trial still requires proposing useful independent branches, actual
human approval for suggested splits, and immediate continuation of authorized
parent work. It now reads `work --help` before plan/routing operations; registered
routing groups are discovered with `work discover` rather than copied into every
input. Personal trial activation and existing approval checks are unchanged.

Project briefs are identified by path, URL and content hash. Read the relevant
full brief before substantive project work; a pointer is not evidence it has
been read. Unavailable briefs remain explicit. No summary replaces or edits
source decisions, comments or history. A changed source hash invalidates its
stable slot. The project directory keeps the same bounded candidate selection,
Session ID, name, goal, state, priority and parent/project relationships. Repeated
routes, navigation URLs and timestamps remain available through `work directory
--json`. Its prompt version hashes only projected content, so irrelevant timestamp
changes do not force the unchanged directory back into context. Verify live state,
provenance and authorization before transfer; a directory is never an instruction.

Startup, Feishu reaction/response and task-card instructions remove repeated
explanations while retaining their existing authorization, delivery and acceptance
rules. Source chat message bodies are not shortened by this change. Native Harness
rules, Skill catalogs and private person profiles are outside this projection.
Measure savings on the same saved input; fleet means also depend on task mix,
identity changes, fresh/resumed threads and later on-demand reads. Existing
provider history is not retroactively rewritten.

### Personal learning context

The opt-in personal learning reminder is a compact `personal_memory_learning` slot, scoped to the verified speaker and reused through the existing accepted-input snapshot mechanism. It carries the trigger, consent/scope boundary, review mode and guide pointer. Detailed extraction, deduplication, state transitions and write schemas stay in `docs/memory-learning.md` for reading when a concrete signal occurs. Pausing, changing identity or changing the reminder invalidates reuse; compaction restores the current short rule. Newly applied memory feedback remains in per-turn context so stable-rule reuse cannot suppress it. Background review retains its extraction guidance.

Skill extraction follows the same trigger/pointer shape using
`docs/skill-extraction-trial/SKILL.md`; explicit owner approval still precedes
creation. In-flight input tools carry eligibility, useful operation triggers and
consent/delivery boundaries, with exact inspect/reply/stop procedures in
`docs/inflight-input-tools.md`. Ordinary supplementary replies require no
additional lookup. Neither pointer changes an existing personal switch or adds a
reader, model call, schedule or message delivery.

The project work directory now projects only current/parent links, unfinished
explicit plan branches (including completed branches awaiting parent review),
and nonhistorical direct child work. Same-project or recent peer work no longer
fills the up-to-16-entry prompt. Ordinary preparation reads linked state metadata
only; unrelated counts or state changes cannot invalidate the projected version.
A fresh intake without local work carries a lookup entrance rather than peers.
Entries identify work, not all memory records. Explicit
`work directory --query <goal> [--object <id>] --json` reuses the existing stored
work/title matcher within the registered scope; it returns at most ten candidate
Sessions and reads live state only for hits. Completed/archived sources and
title-only sources remain searchable, with historical goals in `matchedWork`.
No match is explicitly limited to stored metadata, and the full unfiltered
directory remains available. Neither a hit nor recency authorizes transfer;
the Harness still checks originals and existing consent. No classifier, task,
message or background reader is added. Project and Person memory bodies remain
on-demand reads behind their own pointers.

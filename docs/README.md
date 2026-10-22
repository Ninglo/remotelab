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

## Documentation delivery

[单人 Skill 提炼试点](skill-extraction-trial.md)：本人限定的轻量发现、原生确认、草稿补全与分阶段验效；没有公共设置按钮，候选保持本人试用。

[受控原文读取与本机审计](protected-source-reading.md)说明外部原文快照的明确授权、逐次读取留痕和日志故障拒绝提供内容；也明确保留 sudo 阶段的旁路与本机日志可被管理员修改的边界。

The [Agent dashboard](monitoring.md#agent-今日与七日概览2026-10-14) shows 05:00 Beijing business-day usage, context injection, first-Session-run and final-delivery trends, with authenticated source links and explicit sample coverage. Its collapsed document list distinguishes current original character counts from actual injected fragments and explains startup, conditional and on-demand loading. The main overview now uses a compact summary and detail drawer; account snapshot exports open its account tab and retain the frozen source data.

Metric regression private alerts merge new comparisons into one card for three hours, retain original-card updates thereafter, and lead with a concise anomaly summary and handling status. Repeated comparisons stay in a closed evidence panel; dashboard charts focus on the latest five days with exact last values and a link to the full history. See [the monitoring notification policy](monitoring.md); delivery grouping and chart rendering live in `lib/metric-alert-bundle.mjs` and `lib/metric-alert-chart.mjs`.

Metric references use supported complete dates and explicit rest-date exclusions through `lib/metric-reference.mjs`. Low-sample changes stay unconfirmed; a supported fall followed by a rebound is reviewed separately. Original-card baseline corrections retain evidence and do not claim performance recovery. The [same monitoring policy](monitoring.md#private-metric-review-and-verified-action-receipts) documents configuration, sample support and remaining task-comparison limits.

[Memory file evidence](monitoring.md#authenticated-memory-file-evidence) expands registered files inside the authenticated preview drawer, previews current text, and links completed native file changes to accepted instructions and source conversations. Sampled version changes remain separate when provenance is unverified.

[Handling a monitoring issue](monitoring.md#handle-an-analysis-issue-in-a-new-session) lets an authenticated person use 去解决 to create and submit a web Session with a concise task and pointers to saved evidence. Repeated clicks reuse that Session. An optional independent Monitor entry preserves original management tools, while public-site handoff uses login and an explicit click rather than an unauthenticated execution endpoint. Case-workbench login preserves the selected project and opens [named shared reviews](project-feedback.md#named-case-review); the server confirms the reviewer and retains revision history in the existing feedback store.

[Prompt 安全审阅](monitoring.md#prompt-安全审阅) lives in Monitor → Prompt 安全: retained submission sources, full historical/incremental content review with exact deduplication, explicit gaps/failures, redacted evidence and measured Luna usage. It reports suggestions without applying remediation.

[Monitoring and recovery](monitoring.md) separates normal account consumption
from local backup readiness and failed switching, including a positive-balance
fallback after confirmed exhaustion. Disk warnings enter bounded
low-risk recovery; medium/high-risk plans include scope, impact, rollback and
verification and wait for human confirmation. The same guide defines verified
message-transport recovery without treating unrelated API restrictions as a
total notification outage.
Health projection and alert dispatch retain verified message-transport recovery
through quiet periods and log rotation; a newer quota rejection requires fresh success evidence.

[飞书 Web 话题状态同步](feishu-web-topics.md)说明普通插件的只读账号连接、真实运行状态推送、带序号的增量传输与延迟验证、可见版本号和 Mac 后台更新；[消息设置](feishu-web-settings.md)继续维护本人回复选择与对话模型。
[Mac 原生飞书增强试验](../scripts/feishu-native/README.md)复用已核 Web 1.2 与 Mac 联调组件，恢复同账号群看板和 RemoteLab 状态来源，说明个人连接、断线恢复、本机验证及回退；另有 [M 系列 Mac、飞书 8.1.17 一条命令试装](../scripts/feishu-native/INSTALL.zh-CN.md)，兼容 macOS 自带 Bash，分块校验下载私有运行环境、安装并打开，无需手动安装开发工具，网络失败后复用完成片段、重复执行保留数据；r15 的 [Index 与 thinking](feishu-personal-workspace.md)分别提供连续私聊、本人项目记忆与下一步分析；个人入口、消息设置、状态与已读同步共用一次本人确认，群看板可由已核实话题查回所属群；v16 可逐台接入同一签名小补丁更新入口，接入时返回注册与首次检查结果，每15分钟检查兼容同步服务更新并在失败时回退，页面与签名 App 升级仍需退出后更新。尚不代表完整日用版或外层导航像素一致。


[说明交付流程与候选标准操作](documentation-delivery.md)包含可复用的五步流程、适用条件、失败处理，以及RemoteLab的提交检查、原文生成及实例事件发布；网站“使用与维护”读取原文生成页。[副屏使用说明](../display/USER_GUIDE.md)面向日常用户，部署与接口仍沿原维护文档。

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
- write for low-interruption handoff: the human should usually be able to answer once, walk away, and return to a completed, automatically validated result; stop only for an inaccessible browser/credential step, hard authorization, or an irreversible high-impact action not already clearly scoped
- in product-facing docs, lead with the user problem and payoff: helping ordinary people hand repetitive digital work to AI with low operational overhead; internal orchestration terms belong later unless the doc is explicitly about architecture

## What Lives In `docs/`

### Current Core

- [Project feedback and review](project-feedback.md) — Monitor presents concise priorities and project understanding, with full feedback, cases (including those without feedback), and original evidence available on expansion. Review projections preserve original task status and human attribution.

- [Stable automation homes](task-center-v1.md#stable-automation-home-explicit-opt-in) — task-only context branches (no copied source chat), distinct history/run entries, cross-run reuse explanations, clear bidirectional links, retained definitions and lifecycle history without occupying worker queues.
- [Automation tasks and execution Sessions](task-center-v1.md#automation-session-collection) — explicit collection membership, existing-run migration and direct execution links.

- [Session work awareness](session-work-awareness.md) — personal work-start switches select a versioned rule only for the verified requester; accepted work keeps its original snapshot.
  Independent Web topics use the existing explicit lookup to find project candidates, current briefs and topic directories without automatically binding or resuming work; see [Web topic background](session-work-awareness.md#网页独立新话题的背景续接).
- [Connector turn context](connector-turn-context.md) — compact startup/transport guidance, on-demand project brief pointers, recovery snapshots, shared project announcements for bound Feishu chats, topic snapshots and acceptance-based deduplication.

- [RemoteLab deliverables](architecture-atlas/deliverables.html) — a generated chapter of the unified explanation project; reuses the feature catalog, page catalog and original source records instead of maintaining a separate memory document.

- [RemoteLab unified explanation project](architecture-atlas/README.md) — the [shared website entry](architecture-atlas/project.html) for system understanding, continuous self-improvement, and newcomer onboarding. Existing and future feature explanations join this project's catalog, assembled publication, and backup; focused implementation guides remain canonical references.

- `project-architecture.md` — top-down map of the shipped system
- `cpolar-setup.md` — model-first cpolar setup for mainland-friendly direct access without a VPN
- `setup.md` — model-first setup contract, one-round input handoff, human checkpoints, and target state
- [Request state upgrade tool](request-state-upgrade-tool.md) — one-command state conversion, validation, journaled cutover and rollback using an instance plan
- [Request state upgrade](request-state-upgrade.md) — required offline conversion for legacy instances, rollback and the 2026-09-07 incident; read before updating existing services
- `external-message-protocol.md` — canonical integration contract for external channels, including accepted-input THINKING start/removal through the durable request outbox, separate from optional Feishu social reactions; final-answer classification is shared by response publication and settlement, so questions and interim replies cannot block the result
- [Inline flow display](inline-flow-display.md) — accepted strategy for readable prose, complete left-to-right message previews and in-page enlargement; retains branches, conditions, joins and original source
- [Native Harness input](native-harness-input.md) — active input transport, personal in-flight tool trial, native lifecycle, recovery and validation; [Codex safety-block diagnosis](platform-skills/session-debug.md#codex-safety-blocks) preserves structured provider errors and distinguishes behavior monitoring from context overflow.
- [Session start preflight](session-start-preflight.md) — optional fresh-provider knowledge probe, replacement retry, and daily outcome statistics
- [Memory and organizational collaboration](memory-architecture/README.md) — shared human/Agent reference and [interactive diagrams](memory-architecture/index.html) for actual startup retrieval, post-turn collection, memory scopes, and the separately labeled organization-governance proposal
- [Message and task output architecture](architecture-atlas/output/README.md) — planning reference and [interactive diagrams](architecture-atlas/output/index.html) for intake ownership, asynchronous execution/delivery, progress cards, user feedback and separate task/run/delivery states; the proposed changes are not a deployment claim

### Supporting Internal Contracts

- `../notes/current/product-mainline.md` — current product operating loop and shared feedback-recording rule
- `../notes/current/product-surface-lifecycle.md` — current rule that shipped features stay reviewable and may later be simplified or retired
- `../notes/current/session-first-workflow-surfaces.md` — current workflow-organization rule for session list / grouping / task-like views
- `../notes/current/model-sovereign-control-architecture.md` — current control-layer ownership model for prompt, memory, manager state, and refactor direction
- `../notes/current/session-control-state-phase1.md` — current implementation mapping for manager/work-state projection and Phase 1 boundary cleanup

### Focused Integrations

- [Hardware discussion recording](platform-skills/hardware-recording.md) — optional macOS/Linux keypad and multi-receiver capture, durable audio submission and host acceptance boundary
- [Service management access](platform-skills/service-access.md) — read-only instance service/sudo/local SSH checks before declaring a restart permission blocker
- [Feishu group configuration](feishu-bot-setup.md) — body emoji now follow the requested tone, preserve Unicode sequences and render known aliases in plain prose as native emotion nodes;  native topic groups use normal Agent conversation/steer while explicit `/mute` still blocks ordinary messages until `/unmute`; ordinary groups use pinned participation, optional public Session link, model/effort and durable group prompt controls; missing public URLs do not disable the controls. Simple ordinary-group answers quote the source with no opening or phase heading; lookup/research work uses a thread, even for a short request. Personal display settings do not bypass mainline result-only delivery.

- `cloudflare-email-worker.md` — model-first Cloudflare Email Worker deployment contract
- `feishu-bot-setup.md` — model-first operator + console contract for the RemoteLab Feishu connector; includes asynchronous Jev social reactions with separate appropriateness and emoji confidence, diagnostic receipts, and optional main-Session corrections, with final reactions taking precedence over late quick feedback.
- [Feishu API observability](feishu-api-observability.md) — local request ledger, usage aggregation, privacy and bounded document recovery
- [Person-scoped workboard baseline](../notes/current/feishu-workboard-pilot.md) — accepted checklist/result behavior, opt-in scope, durable operation and isolated regression entry
- `github-auto-triage.md` — model-first GitHub intake and auto-reply rollout contract
- `shared-host-github-accounts.md` — per-person GitHub account and checkout trial on a shared host
- `remote-capability-monitor.md` — remote-agent capability monitoring backed by a durable review Session
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

- [All-scope project memory rollout](project-memory-rollout.md) — incremental pointers, existing daily-review rules, frozen baselines, live confirmation and separate disable controls.

The existing Monitor → Automations view presents four readable workflow categories, with live task times and background states: see [Automation flow explanations](task-center-v1.md#compact-flow-explanations) for aligned start/process/write/notify stages, explicit input reuse, visible scope notes and collapsible Session mechanics. [Delivery details and controls](task-center-v1.md#delivery-details-and-controls) show recipients directly beneath task titles and before flow diagrams, with sending conditions, message format, content and controls available on expansion.

Mac 原生飞书增强的独立安装、本人连接、消息分组侧栏入口和保留数据升级见 [试装入口](../scripts/feishu-native/INSTALL.zh-CN.md)；原生列表只替换标题并显示状态，保留飞书最新消息预览，将四入口和设置置于消息分组侧栏的“测试中的功能”区；可见话题变化不再先清空状态，空闲状态也有标签；本人 Mac 的实际显示须单独验收。r16 统一主程序与本地化名称为“飞书增强版”，配独立紫色图标；保留应用标识和账号数据，经 LaunchServices 启动完整应用，方便在系统权限列表中区分原版。麦克风授权及 Fn 语音输入须在本人 Mac 单独验证。启动器仍确认本机服务就绪后再开窗口。群状态、用量与消息成果的数据边界见 [话题同步](feishu-web-topics.md)。


Automation display labels and condition/result ordering are documented in [Task Center](task-center-v1.md#delivery-details-and-controls). Reviewed conditions include idle wake and gate rules; scheduled checks are distinct from actual execution.

已绑定项目群可启用[群 Agent 卡片与开工说明](feishu-project-links.md#project-group-agent-cards-and-opening-briefs)：复用各群主 Session。现有和后续群配置卡统一精简展示，仅保留实际参与状态与可用切换、模型与会话链接、已绑定的项目共同认知和技能，以及已授权的个人试用入口；干活群按实际配置标明逐条回应，不展示 prompt 编辑器和实时话题看板。样式同步沿原卡片静默更新，添加功能按钮不自动授权补建卡片。项目说明仍沿固定 Markdown、飞书评论及原维护流程更新。

Personal routing trial buttons on Feishu group cards reuse the per-Person reply setting; group eligibility alone does not opt members in. See [work arrangement and card scope](session-work-awareness.md#personal-trial-controls-on-feishu-group-cards) and [personal settings](feishu-web-settings.md).

The information-routing group card can show an explicitly enabled public pilot roster. Personal preference changes refresh the original cards silently; details remain collapsed. See [the trial contract](session-work-awareness.md#personal-trial-controls-on-feishu-group-cards).

- [Feishu tasks](platform-skills/feishu-tasks.md) — human Todos use the existing Feishu task workflow; the former local personal list is retired.

- [飞书私聊个人设置卡](feishu-web-settings.md) — 私聊内修改个人回复、记忆与分流偏好，首屏保留简短引入，个人设置默认展开，以浅灰分区、两列三行显示六项名称、辅助字号说明及当前值下拉框，窄屏自动堆叠；详细解释保留在设置区域内，使用指南按主题折叠；网页备用入口须另行本人登录。支持在指定卡片试阅方向能力介绍，与基础设置合为同一张卡；按大区域折叠，明确要求重发时更新有效卡片绑定。基础设置与本人身份保持不变，介绍不触发业务操作。首次欢迎、本人身份校验、旧卡与重试恢复沿原连接器维护。当前只对明确名单试用，增强版重复入口在对应用户迁移验证后退出。

个人设置卡片支持首次进入私聊欢迎去重，以及“我的设置／使用说明”原生菜单消息入口；配置和验证边界见 [飞书个人设置](feishu-web-settings.md)。

Employee SSH Codex memory: [authenticated account and file evidence](monitoring.md#employee-ssh-codex-memory-evidence) documents the opt-in helper, private inline previews, access metadata, `.codex-sg` installations and native attribution limits. The preview separates recent Skill document loads from completed execution.

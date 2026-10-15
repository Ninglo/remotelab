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

The [Agent dashboard](monitoring.md#agent-今日与七日概览2026-10-14) shows 05:00 Beijing business-day usage, context injection, first-Session-run and final-delivery trends, with authenticated source links and explicit sample coverage. Its collapsed document list distinguishes current original character counts from actual injected fragments and explains startup, conditional and on-demand loading. The main overview now uses a compact summary and detail drawer; account snapshot exports open its account tab and retain the frozen source data.

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
- [Connector turn context](connector-turn-context.md) — current rule projection, recovery snapshots, shared project announcements for bound Feishu chats, topic snapshots and acceptance-based deduplication.

- [RemoteLab deliverables](architecture-atlas/deliverables.html) — a generated chapter of the unified explanation project; reuses the feature catalog, page catalog and original source records instead of maintaining a separate memory document.

- [RemoteLab unified explanation project](architecture-atlas/README.md) — the [shared website entry](architecture-atlas/project.html) for system understanding, continuous self-improvement, and newcomer onboarding. Existing and future feature explanations join this project's catalog, assembled publication, and backup; focused implementation guides remain canonical references.

- `project-architecture.md` — top-down map of the shipped system
- `cpolar-setup.md` — model-first cpolar setup for mainland-friendly direct access without a VPN
- `setup.md` — model-first setup contract, one-round input handoff, human checkpoints, and target state
- [Request state upgrade tool](request-state-upgrade-tool.md) — one-command state conversion, validation, journaled cutover and rollback using an instance plan
- [Request state upgrade](request-state-upgrade.md) — required offline conversion for legacy instances, rollback and the 2026-09-07 incident; read before updating existing services
- `external-message-protocol.md` — canonical integration contract for external channels
- [Inline flow display](inline-flow-display.md) — accepted strategy for readable prose, complete left-to-right message previews and in-page enlargement; retains branches, conditions, joins and original source
- [Native Harness input](native-harness-input.md) — active input transport, personal in-flight tool trial, native lifecycle, recovery and validation
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
- [Feishu group configuration](feishu-bot-setup.md) — automatic pinned participation, optional public Session link, model/effort and durable group prompt controls; missing public URLs do not disable the controls

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

已绑定项目群可启用[群 Agent 卡片与开工说明](feishu-project-links.md#project-group-agent-cards-and-opening-briefs)：复用各群主 Session，置顶显示回应状态、模型、项目文档、技能和实时话题看板；项目说明沿固定 Markdown、飞书评论和原04:00复盘维护。 单张卡片可选择精简展示，仅保留参与切换、模型与会话链接、项目共同认知和技能；干活群标明逐条回应，文档入口标明群内对话默认注入。按已审阅的群启用，获准批量更新时沿原卡片静默覆盖。

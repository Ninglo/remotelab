# RemoteLab Harness 能力契约

RemoteLab 是运行时与投影的半层 Harness。Harness 负责模型推理、原生工具调度和原生会话语义。RemoteLab 负责把各 Harness 的输出接入同一条持久时间线，并提供可验证的进展、问题、回复与终答、规则注入与压缩恢复、记忆、计划清单、文件改动、产物、子 Agent 归属和用量边界。

## 统一事件契约

| 能力 | RemoteLab 交接物 |
| --- | --- |
| 进展 | `message` 事件中的 `<progress>…</progress>`，或 `messageKind: progress_message` |
| 问题与回复 | `messageKind: user_question` 及原生输入回执 |
| 终答 | 带原生 phase 或终局投影的 assistant `message` |
| 规则注入与恢复 | 受理时的 `ruleContextDelivery` 与不可变 `rule-context/<session-hash>/<snapshot-hash>.json` |
| 记忆 | Session 历史和指针优先的跨 Harness 写回 |
| 计划清单 | `messageKind: todo_list`，仅作执行计划投影 |
| 文件改动 | `file_change`，包含 `filePath`、`changeType` 和可选 diff |
| 产物 | `artifact` 及本地路径和附件元数据 |
| 子 Agent 归属 | 子事件带 `parentToolCallId`，或在归一化前过滤出主时间线 |
| 用量 | `usage` 事件和按 provider turn 的输入、缓存、输出与成本字段 |

子 Agent 的文字、工具和结果不能进入 opening、progress、reply 或 final。主线程的工具调用和结果继续沿原事件路径投影。投影状态是可持久化的，新增字段必须允许旧状态恢复。

## Harness 支持矩阵

状态取值为 `native`、`remotelab` 或 `missing`，机器可读源文件是 [`chat/harness-capabilities.json`](../chat/harness-capabilities.json)。

| 能力 | Codex | Claude | Pi |
| --- | --- | --- | --- |
| 进展工具 | RemoteLab MCP | RemoteLab MCP | 缺失 |
| 问题与回复 | 原生 App Server | 原生 Claude stream-json | 原生 Pi RPC |
| 规则注入 | RemoteLab | RemoteLab | 原生 |
| 压缩恢复 | RemoteLab SessionStart | RemoteLab Claude SessionStart | 缺失 |
| 计划清单 | 原生 | RemoteLab TodoWrite 映射 | 缺失 |
| 文件改动 | 原生 | RemoteLab 工具映射 | 缺失 |
| 产物 | 原生 | 缺失 | 缺失 |
| 子 Agent 归属 | 原生 | RemoteLab 主线过滤 | 原生 |
| 用量 | 原生 | 原生 | 原生 |

Claude 的批处理和原生路径都接收 `--append-system-prompt`。两条路径都通过 `--mcp-config` 挂载同一 RemoteLab MCP bridge。原生路径还通过 `--settings` 安装 `SessionStart(matcher=compact)` 规则恢复钩子。钩子只接受 transcript 中的原生 user 消息，严格校验 Session 目录和 snapshot digest，读取失败会阻止继续而不会猜测规则。

Claude 和 Pi 当前没有可复用的中途 additionalContext 注入接口。为避免系统代写进展内容，本轮不伪造提醒消息，长任务静默提醒记录为已知差距。阈值和一次性提醒的归一化状态仍由后续接入原生追加上下文机制时补齐。

## 基线与统计口径

基线时间窗从 2026-11-13 起，统计已完成、非 `internalOperation`、`requestId` 以 `feishu:` 开头的 Run。长任务定义为工具调用数至少 15 次。Claude 只统计主线程事件，带 `parent_tool_use_id` 的消息在适配器层过滤。进展是完成前由 `<progress>` 或 `remotelab_progress` 投影的可见 surface。脚本 [`scripts/harness-alignment-report.mjs`](../scripts/harness-alignment-report.mjs) 支持 `--since 2026-11-13`，按 Harness 输出长任务进展率、每 100 次工具调用的进展数、终答前无可见消息比例和最长静默间隔 P50/P90。

2026-11-13 基线记录在本次实现前的独立测量中。Codex 长任务进展率 63%，每 100 次工具调用 2.2 条，超过 10 分钟的 Run 在终答前无可见消息 0%，最长静默中位数/P90 为 6.7/19.9 分钟。Pi 为 53%、1.4 条、7%、10.6/26.3 分钟。Claude 主线程为 18%、0.33 条、43%、30.1/69.4 分钟。新脚本重新跑同一时间窗时，需保留实际输出和运行版本，不能把历史基线当作上线验收。

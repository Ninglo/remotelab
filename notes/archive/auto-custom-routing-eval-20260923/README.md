# Auto / Custom 模式与 Quick 分档评测（2026-09-23）

## 结论

用户提出的概念调整是合理的：Auto 是执行前的分流策略，模型是分流结果。新会话入口可以只显示 **Auto / Custom**；Auto 首条消息分流后，界面应直接显示实际 Harness、模型、Effort 与所用档位。Quick 可作为 Auto 内部的一档，而不是与 Auto 并列的会话模式。

这次评测支持 **分流设计可以继续做**，尚不支持“GPT-6 Sol 降低 Effort 就会明显更快”的结论。因此本次没有改动生产分流或界面，也没有替换现有 Quick Session。已有 Session、计划任务和连接器默认值保持原状。

## 当前实现核对

- 新 Standard Session 的 Codex 模型默认显示 `Auto (Jev)`，Jev 根据首条消息选择 `sota / quality / balanced / economy`。第一次请求录入后，Session 已持久化具体模型和 Effort；因此继续显示“Auto”只是界面概念问题，并非后台一直没有选出模型。
- 独立 Quick Session 固定为 GPT-6 Sol / low，带简短回复指令并跳过 Session 启动预检；用户不能在该 Session 里修改 Harness、模型和 Effort。
- 当前实例四档配置：`sota = GPT-6 Astra/xhigh`，`quality = GPT-6 Sol/xhigh`，`balanced = GPT-6 Sol/medium`，`economy = GPT-6 Luna/low`。

## 建议的交互

| 用户选择 | 新会话提交前 | 首条消息开始后 |
| --- | --- | --- |
| Auto（默认） | 不要求挑 Harness 或模型；说明会自动选择 | 展示如 `Auto · Quick → GPT-6 Sol · low`；后续沿用已选的具体模型，用户可改用 Custom |
| Custom | 展示 Harness、模型、Effort 选择器；模型列表不混入 Auto | 展示并沿用用户选择的具体值 |

内部建议保留五档：`Quick = GPT-6 Sol/low`（简短、自包含、低风险、无需工具），`Balanced = GPT-6 Sol/medium`（简单文件或日历操作），`Quality = GPT-6 Sol/xhigh`（默认复杂工作），`SOTA = GPT-6 Astra/xhigh`（明确要求最强），`Economy = GPT-6 Luna/low`（明确最低成本且低风险）。Quick 代表低 Effort 的路线选择，不限制后续会话必要的工具使用；若后续任务明显变难，用户应能改选 Custom，或另行评估逐轮重路由。

## 路由评测

`scripts/eval-auto-routing.mjs` 使用 53 条不含私人内容的合成首条消息，同时请求现有四档策略和五档候选策略。候选问题和置信度门槛先在 31 条开发案例上调整，再在独立写出的 22 条留出案例上运行一次。结果保存在 [routing-results.json](routing-results.json)。

| 案例 | 候选五档命中人工标签 | 当前四档在其已有档位上的命中 | 候选误判 |
| --- | ---: | ---: | --- |
| 开发 31 条 | 31/31 | 24/24 | 0 |
| 留出 22 条 | 21/22 | 17/17 | 1 条被保守上调到 Quality |

留出案例中的 5 条 Quick 均进入 Quick；重要任务、医疗、生产、合同等案例没有被分到较低档。唯一误判是“尽快查看服务器磁盘剩余空间”：候选先选 Balanced，但因为 Quality 概率为 0.61，保护门槛上调为 Quality。当前四档在其覆盖的案例上也表现良好；候选的主要价值是新增 Quick 类型和更清楚的语义，不应宣称整体路由质量大幅领先。

候选留出案例分类调用的中位耗时为 132 毫秒，当前为 139 毫秒；两种请求同时发出，网络波动和样本量会影响这个差值，不能据此宣称更快。

## 真实模型小样本

`scripts/eval-quick-effort.mjs` 用同一 GPT-6 Sol 分别以 low 和 xhigh 跑了 6 条简短任务。结果保存在 [effort-results.json](effort-results.json)。

| Effort | 答对 | 中位墙钟耗时 | 推理输出 token | 总输入 token |
| --- | ---: | ---: | ---: | ---: |
| low | 6/6 | 3.67 秒 | 0 | 112,125 |
| xhigh | 6/6 | 3.23 秒 | 0 | 112,125 |

这 6 条任务太简单，两档都没有生成推理输出 token。low 并未测出更快，也未测出明显成本优势。测试只覆盖 Codex 原生 CLI 的独立请求，没有覆盖 RemoteLab 启动预检、Web 首字延迟、较难任务和连续会话。现有 Quick 的体感速度收益可能来自跳过启动预检，但这次没有隔离测量。

## 实施门槛

1. 先把 Auto 从“模型”列表移到 Auto / Custom 入口，并在分流后持续显示具体模型、Effort 与档位。这是清晰度改进，可以独立实施。
2. Quick 内化到 Auto 时，保留路由回执，避免把“要求快”误认为低风险。选择后不要像旧 Quick Session 那样锁死用户的自定义模型能力。
3. 上线前用已脱敏的真实首条消息做影子分流，并在小范围比较首字延迟、总耗时、用户纠错、任务成功率和成本。若 low 没有真实速度收益，则不要以“加速”为卖点；可以仅作为简短答复风格与低预算档位。

本次结果属于合成案例与小样本探索，不是生产 A/B，也不能替代真实任务成功率验证。

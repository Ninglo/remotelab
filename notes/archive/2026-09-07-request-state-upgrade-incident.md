# 2026-09-07 Request 状态升级事故

2026-09-08 根据保存的部署脚本、日志、转换报告及迁移后的数据复核。本文记录首次 Request 格式升级；同日后来发生的跨机器、跨用户迁移是另一项操作。后续实例升级请读[升级说明](../../docs/request-state-upgrade.md)。

## 判断

这是需要维护时间的不兼容升级，历史数据应保留。首次转换失败且回滚未恢复服务、需要另一个实例介入修复，是上线失败，不是普通重启的预期行为。原方案中的停写、保存旧数据、单独转换和明确中断任务方向正确；实际预检、回滚验证、失败通知及真实 connector 验收不足，不能原样作为其他实例的升级方案。

## 已核实的经过（UTC）

| 时间 | 证据与结果 |
| --- | --- |
| 08:15:05 | 独立维护脚本开始，目标代码 `55f8cf74`；此前该提交 CI 和隔离测试通过。 |
| 08:15:09–08:16:41 | 预检允许 1 个升级监控任务，随后停止服务和该任务的执行进程；旧 config 被移走保留，转换输出写入腾出的原路径。 |
| 08:16:41 之后 | 转换抛出 `response identity already belongs to another request`，未完成。不能将失败副本作为新格式启动。 |
| 08:34:57–08:35:00 | 执行回滚；记录 `rollbackVerified: false`，日志中 build 为空。`services_ok=0` 是 shell 返回码，不是业务健康证明。脚本仍准备了“已恢复”的固定通知，但通知返回 `invalid_client` / `The auth method is not supported.`，未送达。 |
| 后续独立修复 | 保留下来的 `conversion-report.json` 记录 schema 1 转换完成；后续修复证据记录控制服务和两个飞书 connector 恢复。完整恢复目录没有随之后的主机迁移带入当前工作区，因此本次不重新断言精确恢复时间或首次回滚失败的具体启动原因。 |
| 13:18:23 | 保存的重启后记录显示控制进程已更换，两个运行中会话的 runner 和工具进程身份均保持不变；相关 HTTP 检查通过。此证据仅证明控制服务重启时任务存活。 |

## 数据和任务影响

对照停写盘点、最终转换报告，以及当前保留的原运行目录：

| 项目 | 转换前 → 转换后 |
| --- | --- |
| 运行记录 | 3,645 → 3,645；全部运行目录及状态记录仍可读取，新 Request 与对应运行的 session/request/response ID 一致，结果状态与转换报告一致。 |
| 运行状态 | completed 3,535 不变；cancelled 22 不变；failed 87 → 88；running 1 → 0。 |
| 明确中断 | 唯一变化是停写盘点中的升级监控任务，记录原因为 explicit offline conversion；没有证据表明此次转换批量中断了用户业务任务。 |
| 排队输入、完成后目标 | 停写时均为 0。 |
| 旧发送记录 | 109 条，转换前后均为 delivered。它们不覆盖所有历史普通聊天回复。 |
| 飞书去重记录 | 两个机器人的 2,003 / 353 条旧 handled 记录，逐一对应到迁移后 Inbox archive 的 `legacyReceiptImported` 与原 handled 消息 ID，缺失数均为 0。 |

这些结果支持“历史运行记录被保留，1 个维护任务被明确中断”。它们不等于所有历史正文、外部副作用和回复都已逐条证明无损。停写盘点还记录每个机器人各有 11 条 allowed 入站事件没有 handled 记录；这些是待对账线索，不能直接视为应重发的消息。本次能读取的材料不足以证明全部特殊身份映射和未匹配事件均已逐条结清。

## 为什么原流程不够

1. **预检没有覆盖真实旧数据。** `runtime-inventory.mjs` 盘点状态、队列及投递，但没有检查 response 身份冲突；转换器在写 Request 索引时才发现问题。仓库现有转换器仍会拒绝冲突，没有自动合并历史尝试的实现。应先在完整一致副本上试转并对账，再停服务取得最终快照。
2. **旧消息文件保留不等于新去重状态建立。** 首次脚本只比较旧 gateway 文件是否原样复制，没有导入新 Inbox 的步骤。后续数据有导入标记，证明后来做了额外修复；不能把原转换脚本描述成一键完成所有 connector 迁移。
3. **回滚和告警不可信。** 原脚本保存并尝试恢复了旧数据、旧源码和服务覆盖配置，并非完全没有回滚。但 `start_services` 主要检查短暂 active，回滚健康失败后仍写 `deploymentGate: rolled-back`，固定通知还声称已恢复。外部通知只做过 dry-run，没有证明实际认证可用。
4. **自动测试缺少真实边界。** 隔离恢复测试使用替身；没有暴露飞书 SDK transport 缺少 `.post`、HTTP 解析丢弃 `sourceDelivery`，以及真实 systemd 会连带终止执行进程的问题。首次脚本把连接 ready 和可读历史当成上线成功，没有验证新消息生成后的原聊天收件。
5. **升级提醒不够显眼。** 旧内部说明已经要求离线转换，但 README、setup 和自托管重启说明仍笼统描述直接重启恢复。共享代码的其他实例也会在下次启动时遇到同一格式拒绝。

## 已有修复与仍需分清的验证

- `2f19c066`：飞书 HTTP transport 保留 SDK 使用的动词方法。
- `27bcf1a4`：JSON / multipart 接收路径保留 `sourceDelivery`。
- `3ab7e562`：runner 尊重配置的 systemd scope，修复异步默认值，并在生成的 owner unit 中加入 `KillMode=process`；原部署也补装了对应配置。
- 保存的回归及远端 CI 结果通过；实际重启保住两个会话。新消息的真实收发、运行中重启后的原线程回发、停机期间完成后补发，仍应按目标实例独立验收，不能由这些证据代替。
- 本次文档复核没有重启服务或重发消息。它没有重做生产迁移，也没有把历史待补发清单当作当前待办状态。

## 证据位置

机器上的原始材料包含私有聊天及配置，不复制进共享仓库。路径均相对于操作人的 RemoteLab 目录，主机迁移可能改写原路径：

- `workspace/main-update-watch-20260907/`：`deploy.sh`、`runtime-inventory.mjs`、`deploy-20260907T081505Z.log`、`state.json`、停写盘点与 `cutover-reconciliation-20260907T081505Z.json`。
- 实例 config：`conversion-report.json`、报告列出的 `chat-runs/*/status.json`、两个 connector 的 `inbox/archive/`。
- `workspace/connector-live-repair-20260907/`：重启前后身份、真实 user-manager probe、回归和 CI 结果。仓库内摘要见[重启修复验证](../current/connector-live-repair/BUGFIX_VERIFICATION.md)。
- 本次复核：schema / conversion 隔离测试，以及双 Request 共用 response 身份的临时副本试转；用于验证当前脚本的拒绝行为和源数据保留，不能替代真实接口验收。

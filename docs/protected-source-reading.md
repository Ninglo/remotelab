# 受控原文读取：本机审计试用

可将下面的请求交给负责实例的 Agent：

> 为指定、已获资料持有人授权的原文启用受控读取。先核对原授权、允许接收的 Person 和工作话题、内容范围、用途及到期时间；只登记明确授权的固定快照。通过正常 API 验证允许和拒绝的读取均留痕，以及日志无法保存时不返回原文。报告实际启用范围及未覆盖的入口，不改变现有 sudo 或 SSH 权限。

一次交接需要：资料持有人的授权来源、指定资料、允许的 Person/Session、用途（查询、补入上下文、导出）、范围、到期时间。没有授权不采集他人的历史；可以先用合成资料验证基础功能。实例管理员负责保存登记配置和维护审计目录。只有资料持有人的授权等真实缺口需要 `[HUMAN]` 补充。

## 覆盖范围

`POST /api/protected-sources/read` 是新增的外部原文读取入口，适用于明确登记的 SSH Codex 原文快照等文件。普通 RemoteLab Session 继续遵循共享实例的现有规则；本功能不替换已有历史 API，也不扫描或自动导入他人的 `.codex` 目录。

测试阶段保留任意 shell、sudo 和既有文件访问。因而这里提供的是**经过这个入口的授权检查与本机持久留痕**，不构成全机读取监管或对 Agent 的硬权限隔离。独立日志接收端、防管理员删改、底层文件审计均未启用。不能把本机文件的哈希校验称为防篡改保证。

用于补入上下文或导出的调用，也必须逐次通过本入口并指定对应用途。本入口没有内容缓存，每次调用，包括重试，都生成独立 `readId`。调用者保存副本后自行重用、其他 API 自动注入、原生会话恢复和模型内部重用，不在这层覆盖范围内。

## 配置与接口

运行实例的 `CONFIG_DIR/protected-sources.json` 是唯一登记配置。缺少或格式错误时拒绝提供原文；未登记资源、越范围或过期授权也拒绝。配置不是群消息白名单，不根据调用请求里的 `personId` 或文件路径授予权限。

```json
{
  "version": 1,
  "policyId": "native-source-pilot",
  "revision": 1,
  "resources": [
    {"id": "approved-snapshot", "path": "/absolute/trusted/snapshot.txt", "size": 1000, "sha256": "完整快照的64位sha256"}
  ],
  "grants": [
    {"id": "grant-example", "resourceId": "approved-snapshot", "personId": "person_example", "sessionId": "目标工作话题的Session ID", "start": 0, "end": 1000, "purposes": ["query"], "expiresAt": "明确的ISO到期时间", "approvalRef": "可查的资料授权来源"}
  ]
}
```

Agent 应先核原授权再登记；`approvalRef` 是人工可审阅的来源记录，不是机器已核实用户同意的证明。登记文件和源码目前仍可被有管理权限的 Agent 修改，这个边界随测试阶段明确保留。收紧执行身份时必须一并保护配置、源码和接口凭据。

源文件必须是稳定的普通文件，路径为无软链接的规范绝对路径。快照目录不能由不可信用户写入；路径校验不是对有权限并发改目录者的防竞态隔离。快照最大 8 MiB，大小和 SHA256 必须匹配，原文件增长或变动后需要重新核范围、登记新快照。服务校验整个快照后，仅向调用者返回授权范围内的字节。

请求体：

```json
{"runId":"当前运行ID","resourceId":"approved-snapshot","purpose":"query","start":0,"end":1000}
```

范围为字节的 `[start,end)`，不是行号；返回 `encoding: "base64"`、`content`、快照版本和审计回执，调用者按实际编码解码。HTTP 响应使用 `Cache-Control: private, no-store`。不提供未经授权的资源列表。

归属取自已接受且未结束的 Request。浏览器身份必须与该 Request 的 Person 一致；服务凭据调用记为 `service_referencing_accepted_request`，而不是宣称是本人操作。现有共享服务凭据可引用其他活动 Request，这不是不可冒用的逐运行认证；在保留高权限的阶段不能据此承诺强身份隔离。请求体自报的 Person 不生效。

## 留下什么记录

`CONFIG_DIR/protected-source-audit/<eventId>.json` 每个事件独立保存；创建及返回回执前同步文件和目录，记录冲突不覆盖。日志目录默认 0700，事件默认 0600。无自动清理任务；管理员应规划容量和保留周期。

- `authorized_attempt`：授权已通过，已留痕，接下来尝试读取。
- `release_ready`：已核实快照和返回范围，并记录内容摘要，接下来可以发送响应。**不代表客户端已收到或模型已理解。**
- `denied`：无授权、范围错误、过期、身份不符，或请求/配置不可用。
- `read_failed`：已获授权，但源文件不可用或版本变化。

记录包含认证类型、可核 Request 的身份及工作来源、资源 ID、版本、范围、用途、授权来源、结果和时间；不自动保存原文或磁盘路径。授权来源应使用引用标识，不写入敏感正文。日志故障返回 503 且不返回内容；日志自身无法写入时，不可能保证这次失败还能记在同一日志中，调用方必须保留 503 回执。

同一读取中有尝试记录却没有终态，表示进程中断或后续审计失败，需要核查，不能推定读取成功。政策按每次请求加载的版本判断；源读取前及响应前检查到期。撤销配置对后续调用生效，不追回已提供的数据。

## 验证与恢复

自动验证入口：

```text
node scripts/run-with-clean-instance-env.mjs node tests/test-protected-source-read.mjs
node scripts/run-with-clean-instance-env.mjs node tests/test-protected-source-route.mjs
```

覆盖合法读取、身份/话题/用途不符、过期和越界、并发读取、快照变动、软链接拒绝、日志冲突、写入失败及返回前审计失败。实例验收先登记短期合成资料，经过真实 API 读取并核对日志，再撤销测试授权；没有他人授权时不新增真实资料。

停止本试用可以清空 `resources`/`grants` 或移走登记文件，保留已有日志。磁盘或日志故障修复后重试会产生新的 `readId`；不要覆盖旧的未完成记录或把旧回执当作新读取的授权。

代码：`lib/protected-source-read.mjs`、`chat/router-protected-sources.mjs`。独立审计托管目前暂缓，不能据此声称已经部署了异机日志或防删除存储。

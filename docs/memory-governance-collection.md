# 全项目记忆：手动隔离测试

这一阶段把已经授权的来源投影到私有测试区，生成有来源、版本和缺口的底稿，由执行任务的 Harness 核对后编写测试日报。项目索引、项目认识和来源指针仍是方案骨架；测试底稿不会成为另一份正式主账。

可以给负责执行的 Agent 这段指令：

> 核对当前项目主账、实际群绑定及相关 Session 原始事件。覆盖全部已登记项目，保留组合、子项、探索和历史主题的区别。优先复用既有采集结果，不另开消费者。生成显式 capture plan；记录来源截止、遗漏、挂靠依据及待核职责。用手动隔离采集器处理，在私有输出中复核关键状态、提取方法候选并编写测试日报。不得接入开工上下文、正式记忆、日报推送、业务动作或 Skill 晋升。用本机真实隔离测试和版本／并发测试验收；说明仍未覆盖的范围。

人工只需补充机器无法找到的群绑定、范围取舍及职责认定。无需为了开始测试先补齐所有这些信息；未知项必须保留。

## 实际边界

- 仅手动运行，没有 Agent、模型、网络采集、定时器、开工 hook、消息发送或正式记忆写回。
- 可信的宿主采集器只读显式文件、检查读取前后状态并计算 SHA256。plan 必须由已获授权的 Harness 提供；适配器不决定来源权限或项目语义。
- Linux worker 位于独立 user、mount、network、PID namespace，chroot 后丢弃 capabilities 并启用 no-new-privileges。只挂载只读公共运行库、Node、只读 `/input`、可写 `/output`、16 MiB `/tmp` 及自身 PID namespace 的 `/proc`。不挂载用户 home、配置、正式记忆或凭据。
- 运行失败或环境不支持 namespace 就拒绝执行，不降级为宿主无隔离运行。Mac 可维护 plan，但不能用此工具启动 worker。CI 若宿主拒绝 namespace，相关集成测试明确 skip，不能据此宣称隔离通过；实施机器必须实际验收。
- 单 worker CPU 30 秒、墙钟 65 秒、2 GiB 地址空间、256 MiB Node heap、单文件 64 MiB、64 个文件描述符、nice 19；每份源文件最多40 MiB，全部显式文件累计192 MiB，投影32 MiB／20,000条／128项目／256来源。
- 同一 workspace 一位写入者；跨 workspace 没有全局资源队列，这一阶段应一次手动运行一份工作区。nice 与限制只降低干扰，尚不能证明前台性能无退化。
- 这些限制适用于这个 worker，不限制拥有整机权限的宿主 Harness 或其他 Agent。测试禁止正式写回不是对既有自动写回系统的改造。

## 固定入口与文件

```bash
node scripts/memory-governance-collect.mjs --plan /absolute/private/plan.json --workspace /absolute/private/test-workspace
```

输出只在经校验的 workspace，拒绝与已配置保护目录重叠或把 input/output 链接到别处。目录0700、文件0600。宿主可信部分仍须遵守授权；不把含真实正文的目录放到 public static 目录。

```text
test-workspace/
  policy.json                      # 明确：仅测试采集打开
  input/corpus.json                # 来源投影、范围、hash、缺口
  input/worker.mjs                  # 固定可信 worker
  output/CURRENT                   # 原子更新的有效版本指针
  output/generation-<revision>-<uuid>/
    state.json                     # 完整投影及条目版本
    report.md                      # 可核对底稿；不是语义验收结果
```

每次 plan 是一份完整的**测试快照**，不是只有新增条目的增量包。下一份快照未出现的旧条目仍在历史 generation；这不等于现实删除。UUID 目录避免失败留下的半成品堵住后续版本；CURRENT 只在状态和报告均写完后切换。硬终止可能留下锁或未提交目录，须先确认无在运行的对应 worker，再人工清理本工作区的残留；不能盲删生产目录。

同一原条目同一文本去重；相同投影重放不增加版本；文本修订新版本指向旧条目，旧 generation 保留。expectedRevision 防止基于旧状态覆盖。状态损坏拒绝重建为 revision 0。同批同证据键出现不同全文会报错，交由来源核对，不把截短文本误作原文修改。

## plan 数据与分类

最小虚构输入：

```json
{
  "schemaVersion": 1,
  "projects": [{"id":"example","title":"示例项目","category":"项目","basis":"已经核对的范围依据"}],
  "sources": [{
    "id":"example-ledger","title":"既有认识",
    "format":"markdown-blocks","projectIds":["example"],
    "files":["/absolute/authorized/projects.md"],
    "blocks":[{"id":"scope","start":1,"end":4,"projectIds":["example"]}],
    "coverage":"显式四行","cutoff":"2026-10-03T00:00:00Z",
    "gap":"派生认识，尚未与原始证据复核"
  }],
  "inventory":{"unverifiedGaps":["负责人职责尚未登记"]}
}
```

| 适配器 | 输入与限制 |
| --- | --- |
| markdown-blocks | 单个主账文件及显式1起始行范围；id对应段落。移动或增加段落后重新核对，不继续用旧行号。 |
| feishu-pages | 既有规范化 roots / threads JSON；指定 chatId，核对消息所属群，去除根与话题重复。图片／附件文字占位不代表已读附件。 |
| session-events | 原 `/events?filter=all` 快照；按显式窗口投影对话与执行结果，默认最近100条对话／20条工具结果，遗漏数量及原文件hash保留。seq是原证据定位。 |
| jsonl-stream | 既有 allowed 消息流及显式 chatProjects；不重开消费者。有界节选和全文使用不同表示，保留共同 lineageKey。 |

来源在 plan 中应按完整群原文、主账、Session、最后有界流的顺序排列，才能复用已读原文并排除后续回声。原群消息在 Session 中重复出现或再次流出时不能变成多个独立背书。Agent 回复标为派生报告，执行输出只证明具体回执；没有工具自动判定“项目已完成”。

群来源的默认项目范围来自核对过的绑定。Session 主账引用只能形成候选关联；混合话题的项目清单应由 Harness 再核对，不能仅按标题、侧栏人员视图或关键词强制挂靠。子项目要单独有明确关联，不因父群名称自动丢失细分来源。未归属材料留在缺口中。

所有自动条目都是 confirmation=pending、businessState=unclassified、humanAccepted=false；本阶段只有来源整理，没有实现逐条人确认系统。Harness 写测试日报时区分“原人发言／原执行回执／旧主账转引／Agent建议”，绑定条目ID和版本。本人说想做、工具启动、产物保存、独立验收、效果成立分别处理。

## 下一道验收

优先核验真实状态更新和已有工作流的发现，而非堆更多层。来源全量更新、项目与个人逐条挂靠、职责反馈回收、对照评测和正式切换仍未启用。不得以采集器运行快、单次底稿成功、CI或 namespace 测试通过，代替前台延迟／token／回答质量的匹配实测。

`npm run test:memory-governance` 验证旧准备工具及新采集器；真实 namespace 测试包括正式文件访问拒绝、输入只读、服务网络不可达、能力与资源限制、相同投影重放、修改版本、并发写入拒绝、过期修订、损坏状态和保护目录别名。

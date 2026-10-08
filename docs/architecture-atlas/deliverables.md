# RemoteLab 产出汇总

本章在 2026-10-08 归集了 17 组独立 Web 产物，涵盖 66 个网站与历史版本入口；同时定位 8 组、43 项候选功能及其 106 个源码或文档引用，6 个原有说明页面、12 个重点文档入口，以及 27 条旧功能记录。数量分别描述不同对象，不能相加当作已完成成果总数。

本次核对到文件、目录和引用存在。功能清单沿用 2026-10-06 的候选记录，模块作者补漏与逐项实际使用验收尚未完成；历史目录也可能含已调整的入口。某项功能的当前启用、结果送达与业务效果，需要继续沿原记录查证。

源码核对基线 4e8426e5e256f0ff49acf1b4af285965242c94d9。页面、功能与文档保留各自的核对日期，本章整理日期不替代它们。

本页是整体说明项目的生成章节；内容修改原项目记录后重新生成。

## 独立 Web 产物

独立网站、研究资料与试验页面也属于我们的产出，按原项目或主题归组。网站内容继续在各自项目维护，本章只登记入口、用途和发布时的状态。发布目录于 2026-10-08 核对；发布记录时间不等于内容日期，也不表示试验已应用或设备已经验收。

本次从 101 条发布记录归集可定位的 HTML 页面，同一项目的历史版本收在对应入口下。另有 30 条旧目录缺发布元数据，尚未逐项恢复；临时文件传输与原始数据发布不计作网站。因此这里仍保留补漏空间。

### 研究资料

- [具身前沿追踪](https://zhangyu.jiujianian.dev/public-pages/qianyan-workbench-sources-20260929/index.html)：具身智能与 AI 行业两条赛道的动态、原文阅读、研究资料、早报与音频。 持续维护；各材料与榜单保留自己的日期和核读范围。 发布记录：2026-10-08。
  同组历史版本与相关入口：[早期单页原型（v6）](https://zhangyu.jiujianian.dev/public-pages/qianyan-workbench-v6-20260929/index.html)
- [具身策略经典论文研读](https://zhangyu.jiujianian.dev/public-pages/classic-paper-reading-20260929/index.html)：从主要动机和数学基础查找具身策略论文及阅读路线。 已发布的研读网站；不作为模型训练或复现结果。 发布记录：2026-10-04。

### 评测与实验

- [具身 Agent 入门与实验回放](https://zhangyu.jiujianian.dev/public-pages/embodied-agent-lab-20260919/index.html?v=r3)：结合语言决策、机器人过程视频与轨迹理解实验案例。 历史案例回放；实时生产观测接入另行核对。 发布记录：2026-09-19。
- [RoboDojo × OpenWAM 部署架构](https://zhangyu.jiujianian.dev/public-pages/robodojo-openwam-architecture-20260924/index.html)：查看评测到模型推理的调用链和组件说明。 9 月 24 日的架构说明快照；当前部署沿原项目核对。 发布记录：2026-09-24。
- [RoboDojo Pi0.5 结果与对照](https://zhangyu.jiujianian.dev/public-pages/robodojo-pi05-comparison-20260910/index.html)：查看历史评测运行、结果、模型对照与效率分析。 历史结果入口；不作为正在运行的评测状态。 发布记录：2026-09-15。
  同组历史版本与相关入口：[新模型与官方模型对照](https://zhangyu.jiujianian.dev/public-pages/robodojo-pi05-new-vs-official-20260913/index.html)、[新模型与上一版对照](https://zhangyu.jiujianian.dev/public-pages/robodojo-pi05-new-vs-previous-20260913/index.html)、[9月9日评测效率分析](https://zhangyu.jiujianian.dev/public-pages/robodojo-ab-efficiency-20260909/index.html)、[9月9日评测状态快照](https://zhangyu.jiujianian.dev/public-pages/robodojo-ab-status-20260909-2250/index.html)
- [Core10k 评测速度说明](https://zhangyu.jiujianian.dev/public-pages/core10k-throughput-diagnosis-20260924/index.html)：解释一轮评测耗时及速度分析。 9 月 24 日的诊断材料；不当作当前吞吐读数。 发布记录：2026-09-24。
- [Agent Benchmark 接入与训练闭环评估](https://zhangyu.jiujianian.dev/public-pages/agent-benchmark-report-20260709/index.html)：比较 Agent 评测接入与训练闭环的方案。 历史报告；9 月 9 日重新发布不改变原报告日期。 发布记录：2026-09-09。

### 产品与设备试验

- [副屏设置与方案预览](https://zhangyu.jiujianian.dev/public-pages/secondary-display-studio/index.html)：查看副屏布局、主题配置、提醒与声音试验方案。 预览与配置资料；实际设备表现需由原设备记录核对。 发布记录：2026-09-26。
  同组历史版本与相关入口：[副屏声音试验](https://zhangyu.jiujianian.dev/public-pages/display-studio-sound-pilot-20260927/index.html)、[声音播放测试页面](https://zhangyu.jiujianian.dev/public-pages/display-sound-test-20260927/index.html)、[第59版布局评审入口](https://zhangyu.jiujianian.dev/public-pages/display-studio-59-preview-first/index.html)、[第58版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-58-unified-font-todos/index.html)、[第57版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-57-font-layout-fast-pet/index.html)、[第56版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-56-topic-directed-alerts/index.html)、[第55版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-55-topic-reply-filter/index.html)、[第54版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-54-feishu-one-consent/index.html)、[第53版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-53-calendar-still-pet/index.html)、[第51版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-51-evening-reminders/index.html)、[第52版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-52-feishu-ack/index.html)、[第50版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-50-sync-original-pets/index.html)、[第49版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-49-beijing-weather/index.html)、[第48版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-48-weather-chat-source/index.html)、[第47版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-47-weather-chat-source/index.html)、[第46版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-46-reminder-sync/index.html)、[第45版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-45-feishu-read-sync/index.html)、[第44版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-44-persistent-feishu/index.html)、[第43版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-43-quiet-alerts/index.html)、[第42版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-42-reminder-stack/index.html)、[第41版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-41-feishu-actions/index.html)、[第40版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-40-feishu-pets/index.html)、[第39版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-39-real-reminders/index.html)、[第38版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-38-schedule-overview/index.html)、[第37版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-37-animated-pets/index.html)、[第36版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-36-one-click-apply/index.html)、[第35版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-35-sticky-preview-apply/index.html)、[第34版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-34-sticky-preview-apply/index.html)、[第33版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-33-preview-apply/index.html)、[第32版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-32-remotelab-ui/index.html)、[第31版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-31-appearance-work/index.html)、[第30版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-30-clear-flow/index.html)、[第29版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-29-three-zones/index.html)、[第28版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-28-original-style/index.html)、[第27版历史预览](https://zhangyu.jiujianian.dev/public-pages/display-studio-27-20260925-layout/index.html)
- [RemoteLab 外观实验室](https://zhangyu.jiujianian.dev/public-pages/remotelab-theme-lab-20260924/index.html)：预览外观主题和配色方案。 试验预览；发布页面不代表主题已经应用。 发布记录：2026-09-30。
- [RemoteLab 工作台与任务导航方案](https://zhangyu.jiujianian.dev/public-pages/remotelab-workbench-design-20260930-v4/index.html)：查看工作台、文件夹、任务中心与导航的信息组织方案。 v4 设计预览；v1–v3 保留为历史版本。 发布记录：2026-09-30。
  同组历史版本与相关入口：[第3版历史预览](https://zhangyu.jiujianian.dev/public-pages/remotelab-workbench-design-20260930-v3/index.html)、[第2版历史预览](https://zhangyu.jiujianian.dev/public-pages/remotelab-workbench-design-20260930-v2/index.html)、[第1版历史预览](https://zhangyu.jiujianian.dev/public-pages/remotelab-workbench-design-20260930-v1/index.html)、[文件夹布局预览](https://zhangyu.jiujianian.dev/public-pages/remotelab-folder-ui-preview-20260930/index.html)、[导航方案研究](https://zhangyu.jiujianian.dev/public-pages/remotelab-navigation-study-20260924/index.html)、[任务中心层级预览](https://zhangyu.jiujianian.dev/public-pages/remotelab-task-center-hierarchy-20260924/index.html)、[任务中心交互试验](https://zhangyu.jiujianian.dev/public-pages/remotelab-task-center-lab-20260924/index.html)、[工作台界面探索](https://zhangyu.jiujianian.dev/public-pages/remotelab-ui-exploration-20260924/index.html)
- [工牌硬件选型参考](https://zhangyu.jiujianian.dev/public-pages/gongpai-hardware-selection-20260925-v2/index.html)：查看候选硬件的选型材料。 历史选型资料；网页存在不代表硬件交付。 发布记录：2026-09-25。
  同组历史版本与相关入口：[第一版硬件选型资料](https://zhangyu.jiujianian.dev/public-pages/gongpai-hardware-selection-20260925/index.html)
- [小形星 · 几何伙伴实验室](https://zhangyu.jiujianian.dev/public-pages/shape-pals-20260926/index.html)：查看几何形态伙伴的视觉与交互方案。 独立试验页面。 发布记录：2026-09-26。
- [小人实验室](https://zhangyu.jiujianian.dev/public-pages/companion-lab-20260926-v2/index.html)：查看人物与伙伴形象的交互原型。 v2 独立试验页面。 发布记录：2026-09-26。
- [C2 水獭 3D 试生成](https://zhangyu.jiujianian.dev/public-pages/claude-tag-otter-c2-3d-trial-20261004/index.html)：查看水獭形象的首次 3D 生成结果。 试生成，原页标注待修正。 发布记录：2026-10-04。
- [RemoteLab 模型标注入口](https://zhangyu.jiujianian.dev/public-pages/jev-model-labeling-20260922/index.html)：进入模型标注页面。 已发布入口；实际标注仍需页面要求的权限。 发布记录：2026-09-22。
- [RemoteLab 工作过程交互试验](https://zhangyu.jiujianian.dev/public-pages/activity-playground-20260908/index.html)：查看工作过程收起、展开和细节展示的交互方案。 历史交互原型；页面发布不代表已成为应用默认行为。 发布记录：2026-09-08。

### 运维资料

- [RemoteLab 账号与机器概览](https://zhangyu.jiujianian.dev/public-pages/remotelab-fleet-overview/index.html)：查看已发布的账号、机器与实例概览。 静态概览；当前服务健康与额度读原监控。 发布记录：2026-09-19。

## 功能与代码

### 会话与历史接续

会话（Session）是一条持续工作的对话。人在手机、桌面或已接入的聊天工具中说明目标，执行工具在实际机器上做事；之后可以沿原会话继续。

- [开工背景、相关工作与参考建议](features.html#work-awareness)
- [真实机器上的对话与执行](features.html#conversation)
- [文件、图片和截图输入](features.html#inputs)
- [语音输入、快捷键和文字整理](features.html#voice)
- [会话搜索、筛选、置顶、重命名和分组](features.html#organization)
- [归档、自动归档和重新打开](features.html#archive)
- [复制会话与分出独立工作](features.html#fork)
- [查看执行过程和历史文件修改](features.html#activity)

代码与说明：[docs/session-work-awareness.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/session-work-awareness.md)、[chat/work-awareness.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/work-awareness.mjs)、[chat/necessary-background.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/necessary-background.mjs)、[chat/related-person-context.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/related-person-context.mjs)、[chat/session-manager.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/session-manager.mjs)、[chat/runner-sidecar.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/runner-sidecar.mjs)、[docs/native-harness-input.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/native-harness-input.md)、[static/chat/compose.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/compose.js)、[chat/file-assets.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/file-assets.mjs)、[docs/object-storage-file-assets.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/object-storage-file-assets.md)、[static/chat/voice-input.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/voice-input.js)、[static/chat/voice-shortcut.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/voice-shortcut.js)、[static/chat/voice-review.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/voice-review.js)、[chat/voice-doubao-relay.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/voice-doubao-relay.mjs)、[static/chat/sidebar-ui.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/sidebar-ui.js)、[chat/session-person-view.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/session-person-view.mjs)、[README.zh.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/README.zh.md)、[docs/session-auto-archive.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/session-auto-archive.md)、[chat/session-auto-archive.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/session-auto-archive.mjs)、[lib/session-spawn-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/session-spawn-command.mjs)、[docs/platform-skills/session-delegate.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/session-delegate.md)、[static/chat/activity-ui.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/activity-ui.js)、[docs/historical-file-diffs.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/historical-file-diffs.md)

### 执行、配置与验收

RemoteLab 提供执行入口、持久记录和结果传输。任务怎么理解、工具怎么用、工作是否完成，仍由所选执行工具（Harness，例如 Codex 或 Claude）判断。

- [执行工具、模型和思考强度选择](features.html#runtime)
- [Auto 路由与 Quick 会话](features.html#auto)
- [执行账号授权、切换与额度观察](features.html#accounts)
- [执行中的提问、追加输入与停止](features.html#questions)
- [任务卡、进度和验收依据](features.html#workboard)
- [会话与执行故障定位](features.html#debug)

代码与说明：[chat/models.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/models.mjs)、[lib/runtime-selection.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/runtime-selection.mjs)、[static/chat/tooling.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/tooling.js)、[lib/jev-auto-router.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/jev-auto-router.mjs)、[docs/quick-sessions.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/quick-sessions.md)、[static/chat/auto-routing-settings.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/auto-routing-settings.js)、[chat/router-codex-auth-routes.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/router-codex-auth-routes.mjs)、[lib/codex-accounts.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/codex-accounts.mjs)、[chat/router-claude-auth-routes.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/router-claude-auth-routes.mjs)、[chat/router-pi-auth-routes.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/router-pi-auth-routes.mjs)、[docs/native-harness-input.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/native-harness-input.md)、[static/chat/native-question-ui.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/native-question-ui.js)、[chat/native-user-questions.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/native-user-questions.mjs)、[lib/workboard-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/workboard-command.mjs)、[lib/workboard-state.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/workboard-state.mjs)、[docs/assistant-message-visibility.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/assistant-message-visibility.md)、[docs/platform-skills/session-debug.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/session-debug.md)、[docs/session-start-preflight.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/session-start-preflight.md)、[lib/remotelab-api-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/remotelab-api-command.mjs)

### 自动工作、日历与待办

定时执行、日历事件和人的待办各有自己的用途。告诉 Agent 何时做什么、结果回哪里，它再选择相应入口。

- [一次性自动工作](features.html#one-time)
- [重复执行的自动化](features.html#recurring)
- [浏览、暂停和复查自动化](features.html#task-list)
- [日历事件和订阅提醒](features.html#calendar)
- [个人待办、截止时间与数字进度](features.html#todos)

代码与说明：[lib/trigger-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/trigger-command.mjs)、[docs/trigger-control-plane-v0.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/trigger-control-plane-v0.md)、[lib/schedule-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/schedule-command.mjs)、[docs/task-center-v1.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/task-center-v1.md)、[static/chat/task-center.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/task-center.js)、[lib/agenda-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/agenda-command.mjs)、[docs/platform-skills/calendar-write.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/calendar-write.md)、[lib/todo-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/todo-command.mjs)

### 消息和办公接入

连接器把外部输入接到会话，并将结果送回原位置。已安装的方法和已完成授权是两件事，需要按当前身份、资源和实例检查。

- [飞书群、话题与会话控制](features.html#feishu-chat)
- [飞书文档和办公操作](features.html#feishu-office)
- [飞书项目入口、讨论上下文与文档评论](features.html#project-links)
- [Agent 邮箱与 Gmail](features.html#mail)
- [绑定的连接器动作和其他消息接入](features.html#connector-framework)
- [具身前沿资料查询与内部研究协作](features.html#research)

代码与说明：[docs/platform-skills/feishu-cli.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/feishu-cli.md)、[docs/feishu-bot-setup.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/feishu-bot-setup.md)、[lib/feishu-action-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/feishu-action-command.mjs)、[docs/feishu-project-links.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/feishu-project-links.md)、[docs/feishu-document-bindings.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/feishu-document-bindings.md)、[docs/connector-turn-context.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/connector-turn-context.md)、[lib/agent-mail-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/agent-mail-command.mjs)、[lib/gmail-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/gmail-command.mjs)、[docs/cloudflare-email-worker.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/cloudflare-email-worker.md)、[lib/connector-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/connector-command.mjs)、[docs/external-message-protocol.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/external-message-protocol.md)、[scripts/wechat-connector.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/scripts/wechat-connector.mjs)、[docs/qianyan-research-access.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/qianyan-research-access.md)、[docs/qianyan-internal-collaboration.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/qianyan-internal-collaboration.md)、[knowledge/qianyan.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/knowledge/qianyan.mjs)

### 文件、分享与预览

需要编辑或分享的结果，应有可打开的文件或链接。会话回答、结果文件、公开网页和需要登录的预览分别交付。

- [结果文件与附件下载](features.html#files)
- [只读会话分享快照](features.html#share)
- [静态网页发布](features.html#static-pages)
- [本地服务预览与端口暴露](features.html#previews)

代码与说明：[lib/assistant-message-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/assistant-message-command.mjs)、[chat/file-assets.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/file-assets.mjs)、[docs/object-storage-file-assets.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/object-storage-file-assets.md)、[chat/shares.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/shares.mjs)、[README.zh.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/README.zh.md)、[lib/static-publish-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/static-publish-command.mjs)、[docs/platform-skills/stable-static-publish.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/stable-static-publish.md)、[lib/preview-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/preview-command.mjs)、[docs/platform-skills/guest-port-expose.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/guest-port-expose.md)

### 本地助手与设备

这些能力有额外的机器、设备或服务条件。先查绑定，再做真实的输入和结果验收。

- [会话绑定的本地助手](features.html#bridge)
- [可操作的图形浏览器桌面](features.html#browser)
- [硬件讨论录音](features.html#recording)
- [显示设备、主题与关联内容](features.html#display)

代码与说明：[lib/local-bridge-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/local-bridge-command.mjs)、[chat/local-bridge-session.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/local-bridge-session.mjs)、[docs/browser-desktop.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/browser-desktop.md)、[chat/browser-desktop-proxy.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/browser-desktop-proxy.mjs)、[lib/recording-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/recording-command.mjs)、[docs/platform-skills/hardware-recording.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/hardware-recording.md)、[chat/router-display-routes.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/router-display-routes.mjs)、[static/chat/display-settings.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/display-settings.js)

### 人员、记忆与设置

人员身份用于区分发言人和个人视图；记忆让后续工作能找到已有资料。身份、资料存在和本轮实际读取各需核对。

- [人员与登录方式管理](features.html#people)
- [项目、个人与公司资料接续](features.html#memory)
- [语言、主题、思考显示与会话开场设置](features.html#appearance)
- [安装到桌面与浏览器通知](features.html#notifications)

代码与说明：[lib/auth-config.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/auth-config.mjs)、[templates/chat.html](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/templates/chat.html)、[README.zh.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/README.zh.md)、[docs/memory-architecture/README.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/memory-architecture/README.md)、[chat/project-memory-runtime.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/project-memory-runtime.mjs)、[chat/person-memory-context.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/person-memory-context.mjs)、[chat/memory-learning.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/memory-learning.mjs)、[docs/memory-learning.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/memory-learning.md)、[static/chat/settings-ui.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/settings-ui.js)、[static/chat/instance-settings.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/instance-settings.js)、[templates/mobile-install.html](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/templates/mobile-install.html)、[chat/push.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/push.mjs)、[static/chat/notifications.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/notifications.js)

### 监控、安装与运维

监控器提供当前实例的运行信息；部署和开发操作则由维护 Agent 按实际权限完成。观察到问题、收到告警、完成修复和业务恢复是不同结果。

- [监控器的总览与自动化列表](features.html#monitor)
- [独立告警、日报来源与获授权的失败恢复](features.html#alerts)
- [个人 GitHub 工作目录与身份核对](features.html#github)
- [安装、运行、升级与实例健康检查](features.html#host)
- [隔离的 guest 实例](features.html#guests)
- [可选的产品跟踪、GitHub 分诊与 CI 修复](features.html#optional-workflows)

代码与说明：[docs/monitoring.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/monitoring.md)、[static/chat/monitoring.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/static/chat/monitoring.js)、[chat/router-control-routes.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/chat/router-control-routes.mjs)、[scripts/monitoring-alerts.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/scripts/monitoring-alerts.mjs)、[scripts/monitoring-report.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/scripts/monitoring-report.mjs)、[lib/github-workspace-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/github-workspace-command.mjs)、[docs/shared-host-github-accounts.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/shared-host-github-accounts.md)、[docs/setup.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/setup.md)、[docs/request-state-upgrade.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/request-state-upgrade.md)、[docs/instance-factory-v1.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/instance-factory-v1.md)、[cli.js](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/cli.js)、[lib/guest-instance-command.mjs](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/lib/guest-instance-command.mjs)、[docs/platform-skills/guest-port-expose.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/guest-port-expose.md)、[docs/remote-capability-monitor.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/remote-capability-monitor.md)、[docs/github-auto-triage.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/github-auto-triage.md)、[docs/github-ci-auto-repair.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/github-ci-auto-repair.md)、[docs/proactive-observer.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/proactive-observer.md)

## 说明页面

- [features.html](features.html)
- [project.html](project.html)
- [index.html](index.html)
- [output/index.html](output/index.html)
- [memory/index.html](memory/index.html)
- [output/reference.html](output/reference.html)

## 项目文档

- [产品介绍与安装入口](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/README.zh.md)：解释 RemoteLab 解决什么问题，以及如何开始使用。
- [系统架构与代码地图](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/project-architecture.md)：从系统职责定位实现文件和运行链路。
- [常见开发修改方法](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/implementation-recipes.md)：为修改接口、运行适配和界面提供现有实现入口。
- [外部消息接入协议](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/external-message-protocol.md)：说明连接器输入、执行和结果投递的共同约定。
- [执行工具的输入与接续](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/native-harness-input.md)：说明 Codex、Pi、Claude 的输入传递、追加消息和恢复。
- [相关工作与协作记录](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/session-work-awareness.md)：说明开工背景、已有成果查询与参考建议的证据边界。
- [人员观察与 Agent 方法](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/memory-learning.md)：说明按身份读取、确认和撤销的方法；项目成果仍归项目。
- [飞书接入与配置](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/feishu-bot-setup.md)：说明 Bot、话题、权限与运行配置的接入条件。
- [静态网页发布](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/stable-static-publish.md)：说明把网页发布到原实例、回读和更新的流程。
- [运行服务预览](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/guest-port-expose.md)：说明预览本地服务及其认证和实例边界。
- [硬件录音](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/platform-skills/hardware-recording.md)：说明设备绑定、录音提交和实际设备验收要求。
- [完整文档导航](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/docs/README.md)：从当前主线文档继续查找专用 API、安装与运维资料。

## 找回的历史记录

- [feature_list.json](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/feature_list.json)：27 条旧功能与验证标记；最后更新于 2026-09-16，不代表当前部署全部验收。
- [progress.txt](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/progress.txt)：开发、验证、上线或暂缓上线记录；最后更新于 2026-09-16。
- [CHANGELOG.md](https://github.com/Ninglo/remotelab/blob/4e8426e5e256f0ff49acf1b4af285965242c94d9/CHANGELOG.md)：历史版本与 Unreleased 变化，不是完整现状目录。

尚不能确认这些文件就是讨论中提到的那份更早记录，也没有确认其持续自动更新。

## 如何继续维护

1. 功能与使用说明更新 features.json；实际代码与专用文档仍在原文件维护。
2. 说明页面和本章重点文档入口更新 project.json；新增章节继续加入同一个项目。
3. 独立 Web 产物继续在原项目维护；在 project.json 的 deliverables.webProducts 登记发布入口与状态，同一项目的旧版本归入 related。
4. 重新生成本章并组装原网站，更新同一个发布入口；生成的 HTML 与参考文本不手工维护第二份正文。
5. 项目决定、责任与进度沿原项目记录核对；本章提供成果入口，不另维护一份记忆或任务状态。

```sh
node docs/architecture-atlas/render-deliverables.mjs
node docs/architecture-atlas/assemble-site.mjs <新的空输出目录>
```

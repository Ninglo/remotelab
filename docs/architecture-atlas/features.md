# 功能清单与使用说明

状态：盘点初稿，待模块作者补漏确认。核对日期：2026-10-06。

这份清单是供使用和作者补漏的底稿。完整性和负责人尚未经过作者确认，不能称为完整说明书。

本版对照主仓库的界面、主 CLI 分派和相关专题资料。命令下的每个子操作、仓库外脚本、其他实例配置和作者归属尚未全面核对。 2026-10-06增补人员学习与行动手册入口；其余功能沿用原盘点和待作者确认边界，不扩展为全部业务已验收。

本轮源码基线：16e1dce2a661528ca72f369239f9cd4b022a77b3。8 组、42 项候选功能；34 个主 CLI 命令已有对应条目，0/8 组收到作者确认。

## 发起工作、接着做和找回历史

会话（Session）是一条持续工作的对话。人在手机、桌面或已接入的聊天工具中说明目标，执行工具在实际机器上做事；之后可以沿原会话继续。

### 真实机器上的对话与执行

处理文件、调查问题、修改项目、运行程序，并在原会话继续补充要求。

入口：会话 → 新建会话 → 发送消息。

使用条件：需要可用的执行工具及相应机器权限。浏览器关闭不等于任务停止；执行结果仍需验收。

可以这样说：“把这份表里的重复项清掉，保留原件，给我可下载的新表。”

维护线索：[chat/session-manager.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/session-manager.mjs)、[chat/runner-sidecar.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/runner-sidecar.mjs)、[docs/native-harness-input.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/native-harness-input.md)。

### 文件、图片和截图输入

上传样例文件，粘贴截图，让 Agent 结合材料工作。

入口：会话输入框的上传入口或直接粘贴图片。

使用条件：不同执行工具对图片和文件的支持有区别；附件成功上传不等于模型已读取。

可以这样说：“按这张截图检查页面，修好后给我预览。”

维护线索：[static/chat/compose.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/compose.js)、[chat/file-assets.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/file-assets.mjs)、[docs/object-storage-file-assets.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/object-storage-file-assets.md)。

### 语音输入、快捷键和文字整理

把口述转成可编辑的输入草稿，可配置个人热词和快捷键。

入口：会话语音入口；设置 → 连接 → 语音输入。

使用条件：需浏览器麦克风许可及可用识别服务。快捷键只在页面活跃时工作；草稿整理是可选能力。

可以这样说：“配置我的语音输入，并检查识别出的文字再发送。”

维护线索：[static/chat/voice-input.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/voice-input.js)、[static/chat/voice-shortcut.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/voice-shortcut.js)、[static/chat/voice-review.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/voice-review.js)、[chat/voice-doubao-relay.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/voice-doubao-relay.mjs)。

### 会话搜索、筛选、置顶、重命名和分组

从共享会话中找到自己的工作，并按个人视图组织 Space 和 Group。

入口：会话侧栏与会话菜单；设置 → 会话 → 我的视图。

使用条件：个人筛选和分组影响视图，不形成会话访问隔离；共享会话内容和标题仍是共同数据。

可以这样说：“把这些相关会话放到我的同一个分组里。”

维护线索：[static/chat/sidebar-ui.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/sidebar-ui.js)、[chat/session-person-view.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/session-person-view.mjs)、[README.zh.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/README.zh.md)。

### 归档、自动归档和重新打开

让不活跃的会话退出常用列表，保留历史并能再次继续。

入口：会话菜单；设置 → 会话 → 自动归档。

使用条件：自动归档默认关闭。归档不删除历史，也不停止已绑定的连接器工作；新消息会重新打开会话。

可以这样说：“把闲置三天的会话自动归档。”

维护线索：[docs/session-auto-archive.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/session-auto-archive.md)、[chat/session-auto-archive.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/session-auto-archive.mjs)。

### 复制会话与分出独立工作

从已有上下文探索另一条路线，或把范围明确的工作交给独立会话。

入口：会话的 Fork 菜单；要求 Agent 新建一个独立工作会话。

使用条件：新会话有自己的执行和交付记录。创建成功不等于分出的工作完成；不同分支后续输入不会自动合并。

可以这样说：“保留当前方案，另开一个会话比较第二种实现。”

维护线索：[lib/session-spawn-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/session-spawn-command.mjs)、[docs/platform-skills/session-delegate.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/session-delegate.md)、[chat/session-manager.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/session-manager.mjs)。

Agent 命令入口：`remotelab session-spawn`。

### 查看执行过程和历史文件修改

展开工具调用、执行结果和已记录的文件差异，复查当时做了什么。

入口：会话中的过程记录与文件修改条目。

使用条件：文件差异依赖执行工具提供的记录；缺失或失败的记录会保留说明，不能用今天的文件还原旧修改。

可以这样说：“展开这次改动，看看具体改了哪些行。”

维护线索：[static/chat/activity-ui.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/activity-ui.js)、[docs/historical-file-diffs.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/historical-file-diffs.md)。

## 选择执行方式、回答问题和核对任务

RemoteLab 提供执行入口、持久记录和结果传输。任务怎么理解、工具怎么用、工作是否完成，仍由所选执行工具（Harness，例如 Codex 或 Claude）判断。

### 执行工具、模型和思考强度选择

为工作选择已接入的执行工具和运行选项。

入口：新会话的工具、模型和思考强度选择器；相关账号设置。

使用条件：选项取决于本实例安装、登录和模型目录。目录里有名称不等于该账号已能成功执行。

可以这样说：“用本实例已可用的执行工具处理这个仓库。”

维护线索：[chat/models.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/models.mjs)、[lib/runtime-selection.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/runtime-selection.mjs)、[static/chat/tooling.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/tooling.js)。

### Auto 路由与 Quick 会话

由已配置的路由为新会话选择执行档位，或用固定的 Quick 模式回答简短问题。

入口：新会话选择 Auto 或 Quick；设置 → 会话 → Auto 路由；飞书 /quick。

使用条件：Quick 在创建时固定运行方式。Auto 的档位和默认值按实例配置核对，不能把某个实例的设置推广到所有人。

可以这样说：“新建一个 Quick 会话，解释这段报错。”

维护线索：[lib/jev-auto-router.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/jev-auto-router.mjs)、[docs/quick-sessions.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/quick-sessions.md)、[static/chat/auto-routing-settings.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/auto-routing-settings.js)。

Agent 命令入口：`remotelab quick-stats`。

### 执行账号授权、切换与额度观察

查看登录与账号状态，在已经授权的账号之间管理后续执行。

入口：执行工具的账号管理入口；监控器的账号信息。

使用条件：首次登录仍可能需要持有人完成授权。运行中的账号和后续默认账号要分别核对；额度采样过期时不能当作当前余额。

可以这样说：“检查当前可用账号和采样时间，说明是否需要我完成授权。”

维护线索：[chat/router-codex-auth-routes.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/router-codex-auth-routes.mjs)、[lib/codex-accounts.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/codex-accounts.mjs)、[chat/router-claude-auth-routes.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/router-claude-auth-routes.mjs)、[chat/router-pi-auth-routes.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/router-pi-auth-routes.mjs)。

### 执行中的提问、追加输入与停止

在工作过程中回答缺失信息、补充约束或要求停止。

入口：原会话输入框、问题控件和停止入口。

使用条件：是否支持运行中直接追加取决于执行工具。默认选项与没有回复都不能当作用户批准。

可以这样说：“保留刚才的目标，把输出语言改成中文。”

维护线索：[docs/native-harness-input.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/native-harness-input.md)、[static/chat/native-question-ui.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/native-question-ui.js)、[chat/native-user-questions.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/native-user-questions.mjs)。

### 任务卡、进度和验收依据

对较复杂的工作显示目标、交付项、验收条件和证据。

入口：已启用的会话任务卡；由 Agent 提交和更新。

使用条件：需要相应部署和会话启用条件。卡片更新或执行结束不证明业务结果通过验收。

可以这样说：“这项工作列出可验收的交付项，每项完成后附上依据。”

维护线索：[lib/workboard-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/workboard-command.mjs)、[lib/workboard-state.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/workboard-state.mjs)、[docs/assistant-message-visibility.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/assistant-message-visibility.md)。

Agent 命令入口：`remotelab workboard`。

### 会话与执行故障定位

区分未接纳、排队、执行失败、结果生成和外部送达问题。

入口：让 Agent 查原会话的状态和记录；相关调试入口。

使用条件：日志只证明对应阶段。不能用 HTTP 成功、Run 结束或本地文件存在替代结果验收。

可以这样说：“这次回答没到飞书，核对原投递记录后再决定是否重试。”

维护线索：[docs/platform-skills/session-debug.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/session-debug.md)、[docs/session-start-preflight.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/session-start-preflight.md)、[lib/remotelab-api-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/remotelab-api-command.mjs)。

Agent 命令入口：`remotelab api`、`remotelab session-preflight`。

## 自动化、日历和个人待办

定时执行、日历事件和人的待办各有自己的用途。告诉 Agent 何时做什么、结果回哪里，它再选择相应入口。

### 一次性自动工作

在指定时间或已支持的触发条件下，继续一个范围明确的会话任务。

入口：直接在会话描述；监控器 → 一次性自动化。

使用条件：需要明确目标会话、触发条件和结果去向。支持的条件以当前 Trigger 接口为准。

可以这样说：“明天上午检查这个任务的最新结果，把结论回到这里。”

维护线索：[lib/trigger-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/trigger-command.mjs)、[docs/trigger-control-plane-v0.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/trigger-control-plane-v0.md)。

Agent 命令入口：`remotelab trigger`。

### 重复执行的自动化

按时区和周期执行既有工作，保留每次尝试与结果。

入口：在会话说明频率；监控器 → 常规自动化。

使用条件：创建成功不证明未来运行或投递成功。暂停通常阻止后续接纳，已经运行的工作需另查。

可以这样说：“每天九点按这个已验证流程整理资料，结果发到原会话。”

维护线索：[lib/schedule-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/schedule-command.mjs)、[docs/task-center-v1.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/task-center-v1.md)、[docs/trigger-control-plane-v0.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/trigger-control-plane-v0.md)。

Agent 命令入口：`remotelab schedule`。

### 浏览、暂停和复查自动化

查看常规、一次性和已停止任务，进入源会话查运行、失败和结果去向。

入口：监控器的自动化列表与任务详情。

使用条件：它保存的是平台自动工作。项目任务、外部评测状态或人的待办仍在各自系统维护。

可以这样说：“列出最近失败的自动化，解释失败阶段和已有结果。”

维护线索：[static/chat/task-center.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/task-center.js)、[docs/task-center-v1.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/task-center-v1.md)。

### 日历事件和订阅提醒

把明确的时间安排写入实例日历源，再通过支持的日历客户端订阅。

入口：在会话说安排；由 Agent 使用 agenda；需要时打开订阅辅助页。

使用条件：日历提醒由订阅客户端执行，刷新时机取决于客户端；写入日历不等于启动定时 AI 工作。

可以这样说：“明天下午三点到四点开会，提前半小时提醒，给我日历订阅入口。”

维护线索：[lib/agenda-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/agenda-command.mjs)、[docs/platform-skills/calendar-write.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/calendar-write.md)。

Agent 命令入口：`remotelab agenda`。

### 个人待办、截止时间与数字进度

记录人的待办及当前数值、目标和单位。

入口：在当前身份的会话中要求创建或更新待办；由 Agent 使用 todo。

使用条件：需要对应 Person 和待办服务。数值达到目标不会自动把状态改成完成；待办不是自动执行计划。

可以这样说：“记一项本周读五篇论文的待办，现在完成两篇。”

维护线索：[lib/todo-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/todo-command.mjs)。

Agent 命令入口：`remotelab todo`。

## 飞书、邮件、外部接入和研究资料

连接器把外部输入接到会话，并将结果送回原位置。已安装的方法和已完成授权是两件事，需要按当前身份、资源和实例检查。

### 飞书群、话题与会话控制

从已接入的飞书对话发起工作，在原话题接收回答、问题、附件和任务进度。

入口：已接入的飞书 Bot；按该群规则发消息；/status、/model 等命令。

使用条件：群接入、参与规则、来源权限和命令范围按 Bot 配置核对。不能把一个群的行为推广到所有群。

可以这样说：“在当前话题继续刚才的工作，把结果也回到这里。”

维护线索：[docs/platform-skills/feishu-cli.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/feishu-cli.md)、[docs/feishu-bot-setup.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/feishu-bot-setup.md)。

### 飞书文档和办公操作

在授权范围内读取或维护文档、知识库、消息、日历、任务和多维表格。

入口：在会话说清具体资源和操作；Agent 按现行飞书方法选择入口。

使用条件：固定 Bot 动作只是其中一部分；其他操作需对应 CLI/Skill。应用 scope、用户授权和资源访问权分别检查。

可以这样说：“读取这篇文档，在原件补充结论并保留现有评论。”

维护线索：[lib/feishu-action-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/feishu-action-command.mjs)、[docs/platform-skills/feishu-cli.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/feishu-cli.md)。

Agent 命令入口：`remotelab feishu`。

### 飞书项目入口、讨论上下文与文档评论

读取已登记的项目资料和自动化，带入绑定讨论上下文，或从原文档评论继续工作。

入口：已配置群的 /project；已绑定项目对话或文档评论。

使用条件：这是明确登记和绑定的范围。网页目录、项目主账和授权资料不会因出现一个链接就全部自动读入。

可以这样说：“查看这个已登记项目的资料和任务，并在原文档评论回复。”

维护线索：[docs/feishu-project-links.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/feishu-project-links.md)、[docs/feishu-document-bindings.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/feishu-document-bindings.md)、[docs/connector-turn-context.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/connector-turn-context.md)。

### Agent 邮箱与 Gmail

使用 Agent 邮箱接收与回复邮件，或操作当前已绑定的 Gmail。

入口：在会话指定邮箱目标；mail 或 gmail；设置中的相关授权入口。

使用条件：两种邮箱身份不同，需单独确认绑定和发送授权。收到邮件、进入会话和回复送达各有记录。

可以这样说：“查看我的已绑定邮箱中这封邮件，先整理需要回复的事实。”

维护线索：[lib/agent-mail-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/agent-mail-command.mjs)、[lib/gmail-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/gmail-command.mjs)、[docs/cloudflare-email-worker.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/cloudflare-email-worker.md)。

Agent 命令入口：`remotelab mail`、`remotelab gmail`。

### 绑定的连接器动作和其他消息接入

发现当前绑定的动作，接入符合消息协议的外部服务；部分实例有微信等入口。

入口：设置 → 连接；让 Agent 先列出当前实例已绑定的能力。

使用条件：代码或能力目录里有适配器，不证明本实例已经绑定，也不证明可以向任意联系人发送。

可以这样说：“先列出这个实例已绑定的连接器，以及能做的具体操作。”

维护线索：[lib/connector-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/connector-command.mjs)、[docs/external-message-protocol.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/external-message-protocol.md)、[scripts/wechat-connector.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/scripts/wechat-connector.mjs)。

Agent 命令入口：`remotelab connector`。

### 具身前沿资料查询与内部研究协作

检索已收录的研究材料、版本和来源；有员工身份时可进入授权的内部文档与讨论。

入口：具身前沿追踪的现有网站与研究查询入口；对应研究 Skill。

使用条件：需工作台语料和相应身份配置。公共研究查询不提供内部材料，也不代表训练或评测的实时状态。

可以这样说：“查与这个方法相关的已收录材料，给出原始来源和适用条件。”

维护线索：[docs/qianyan-research-access.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/qianyan-research-access.md)、[docs/qianyan-internal-collaboration.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/qianyan-internal-collaboration.md)、[knowledge/qianyan.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/knowledge/qianyan.mjs)。

## 下载、分享、网页和预览

需要编辑或分享的结果，应有可打开的文件或链接。会话回答、结果文件、公开网页和需要登录的预览分别交付。

### 结果文件与附件下载

把本机生成的表格、图片、压缩包等变成会话内可下载的附件。

入口：要求 Agent 交付文件；会话附件或结果文件入口。

使用条件：Agent 需要显式发布结果，并核对附件可取。只说一个机器路径不构成交付。

可以这样说：“给我导出的 CSV，直接在会话里下载。”

维护线索：[lib/assistant-message-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/assistant-message-command.mjs)、[chat/file-assets.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/file-assets.mjs)、[docs/object-storage-file-assets.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/object-storage-file-assets.md)。

Agent 命令入口：`remotelab assistant-message`。

### 只读会话分享快照

把选定内容冻结为独立只读分享，方便别人查看当时的结果。

入口：会话的分享入口。

使用条件：快照不会跟随后续工作自动更新。分享前要检查内容范围；共享实例中的会话不是个人私有空间。

可以这样说：“为这次结果生成只读分享，先核对会公开哪些内容。”

维护线索：[chat/shares.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/shares.mjs)、[README.zh.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/README.zh.md)。

### 静态网页发布

发布报告、图表、演示和说明页，给出稳定可访问的链接。

入口：要求 Agent 发布已有静态文件；publish static。

使用条件：公开静态页无需登录，只适合已核对可公开的内容。生成文件与公网实际可读需分别检查。

可以这样说：“把这份可公开报告发布成网页，给我可直接打开的链接。”

维护线索：[lib/static-publish-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/static-publish-command.mjs)、[docs/platform-skills/stable-static-publish.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/stable-static-publish.md)。

Agent 命令入口：`remotelab publish`。

### 本地服务预览与端口暴露

让已有的本地动态页面通过稳定入口访问，保留它需要的认证。

入口：让 Agent 检查本地服务后使用 preview，或受控 guest 入口。

使用条件：服务需已监听且属于授权范围；当前实例预览要求相应认证。与静态发布是不同流程。

可以这样说：“把这个已经运行的本地预览接到当前实例的认证入口。”

维护线索：[lib/preview-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/preview-command.mjs)、[docs/platform-skills/guest-port-expose.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/guest-port-expose.md)。

Agent 命令入口：`remotelab preview`。

## 本地助手、浏览器和设备

这些能力有额外的机器、设备或服务条件。先查绑定，再做真实的输入和结果验收。

### 会话绑定的本地助手

把另一台本地机器允许的能力连接到当前会话。

入口：让 Agent 检查 local-bridge 状态，再按绑定流程连接。

使用条件：需要安装、配对和明确授权。状态里没有绑定时，不具备那台机器的操作能力。

可以这样说：“检查当前会话有没有连接到我的本地助手。”

维护线索：[lib/local-bridge-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/local-bridge-command.mjs)、[chat/local-bridge-session.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/local-bridge-session.mjs)。

Agent 命令入口：`remotelab local-bridge`。

### 可操作的图形浏览器桌面

通过实例的认证网页进入持久浏览器，完成人只能亲自完成的登录或验证。

入口：已配置实例的 /browser/；让 Agent 核对入口。

使用条件：需要本地 noVNC 等桌面服务和实例配置。打开桌面不等于目标网站已登录成功。

可以这样说：“打开这个实例的浏览器桌面，让我完成网站验证。”

维护线索：[docs/browser-desktop.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/browser-desktop.md)、[chat/browser-desktop-proxy.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/browser-desktop-proxy.mjs)。

### 硬件讨论录音

将明确绑定的音源和按键用于独立开始、结束录音，再把保存的音频提交处理。

入口：由 Agent 配置 recording；已绑定的接收器和小键盘。

使用条件：需设备许可、音源、频道、按键和接收会话配置。保存音频不等于转写、分析或外部交付完成。

可以这样说：“核对录音设备和交付位置，再配置这台机器的录音入口。”

维护线索：[lib/recording-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/recording-command.mjs)、[docs/platform-skills/hardware-recording.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/hardware-recording.md)。

Agent 命令入口：`remotelab recording`。

### 显示设备、主题与关联内容

通过已有显示服务管理配对设备、内容和预览。

入口：已配置实例的显示设置与设备端。

使用条件：需要显示 sidecar 和真实设备绑定。副屏、工牌和其他硬件的能力不能互相替代；本次未做物理验收。

可以这样说：“检查已配对显示设备，说明现在能展示哪些内容。”

维护线索：[chat/router-display-routes.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/router-display-routes.mjs)、[static/chat/display-settings.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/display-settings.js)。

## 人员、记忆和界面设置

人员身份用于区分发言人和个人视图；记忆让后续工作能找到已有资料。身份、资料存在和本轮实际读取各需核对。

### 人员与登录方式管理

添加人员档案、管理登录方式，并关联已核外部身份。

入口：设置 → 人员；部署者的登录配置入口。

使用条件：同一实例所有已认证人员可使用全部会话。身份用于归因和视图，不提供会话权限隔离。

可以这样说：“检查我的网页与飞书身份是否对应同一个人员档案。”

维护线索：[lib/auth-config.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/auth-config.mjs)、[templates/chat.html](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/templates/chat.html)、[README.zh.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/README.zh.md)。

Agent 命令入口：`remotelab generate-token`、`remotelab set-password`。

### 项目、个人与公司资料接续

让新工作沿入口查已有项目认识、个人偏好和背景资料，必要时维护原来源。已启用的实例还能从普通互动归纳人员习惯，从执行证据维护行动手册。

入口：同一说明项目的记忆章；已配置的启动和项目指针；直接告诉 Agent 应保留什么。检查和修订入口为 memory，操作说明见 docs/memory-learning.md。

使用条件：路径指针不等于正文已读取。个人偏好、共同规则、项目事实和候选记录有不同维护位置与生效范围。新学习默认关闭，按实例明确列出的 Person 试用；推断、本人偏好、已验证方法和撤销分别标记，实际效果继续核对。

可以这样说：“接着这个项目做，先核对现有主账和最新决定。”

维护线索：[docs/memory-architecture/README.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/memory-architecture/README.md)、[chat/project-memory-runtime.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/project-memory-runtime.mjs)、[chat/person-memory-context.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/person-memory-context.mjs)、[chat/memory-learning.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/memory-learning.mjs)、[docs/memory-learning.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/memory-learning.md)。

Agent 命令入口：`remotelab memory`。

### 语言、主题、思考显示与会话开场设置

调整阅读语言、已提供主题和过程展开方式，以及会话默认视图。

入口：设置 → 常规／会话。

使用条件：不同选项可能属于浏览器、个人或共享实例；以设置说明为准。额外主题的指标展示需相应后端数据。

可以这样说：“把界面语言设成中文，并收起默认展开的过程内容。”

维护线索：[templates/chat.html](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/templates/chat.html)、[static/chat/settings-ui.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/settings-ui.js)、[static/chat/instance-settings.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/instance-settings.js)。

### 安装到桌面与浏览器通知

在支持的手机或桌面环境安装网页应用，并接收已启用的浏览器通知。

入口：设置 → 此设备 → 安装／浏览器通知。

使用条件：需要浏览器和操作系统支持及通知许可；装到桌面不改变底层服务是否在线。

可以这样说：“给我这个设备的安装步骤，并检查是否支持通知。”

维护线索：[templates/mobile-install.html](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/templates/mobile-install.html)、[chat/push.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/push.mjs)、[static/chat/notifications.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/notifications.js)。

## 监控、部署和开发协作

监控器提供当前实例的运行信息；部署和开发操作则由维护 Agent 按实际权限完成。观察到问题、收到告警、完成修复和业务恢复是不同结果。

### 监控器的总览与自动化列表

查看紧急问题、账号额度、用量、磁盘、自动化和已配置服务。

入口：顶部或侧栏的监控器；总览使用 ?tab=tasks&monitor=overview。

使用条件：默认只覆盖本实例已有来源；fleet、额外磁盘和独立服务需明确配置。缺失或过期的采样不是零余额。

可以这样说：“查看本实例的紧急问题和覆盖缺口，给我最新观测时间。”

维护线索：[docs/monitoring.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/monitoring.md)、[static/chat/monitoring.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/static/chat/monitoring.js)、[chat/router-control-routes.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/chat/router-control-routes.mjs)。

Agent 命令入口：`remotelab usage-summary`。

### 独立告警、日报来源与获授权的失败恢复

在明确配置后观察重要问题，保留告警和恢复记录，并把日常情况归入既有日报。

入口：由维护 Agent 配置现有监控 observer 与日报流程。

使用条件：页面可打开不代表告警或自动恢复已启用。恢复需额外授权与配置；发送成功也不等于故障已修复。

可以这样说：“检查现有监控是否启用告警与恢复，说明范围和真实记录。”

维护线索：[docs/monitoring.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/monitoring.md)、[scripts/monitoring-alerts.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/scripts/monitoring-alerts.mjs)、[scripts/monitoring-report.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/scripts/monitoring-report.mjs)。

### 个人 GitHub 工作目录与身份核对

为实际人员准备可追溯的仓库工作目录，核对 remote、分支和提交身份。

入口：向 Agent 给出仓库与当前人员；github-workspace。

使用条件：共享机器登录不能替代真实请求者身份。私有仓库与推送仍需要相应访问权。

可以这样说：“为我准备这个仓库的工作目录，先核对身份、远端和已有改动。”

维护线索：[lib/github-workspace-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/github-workspace-command.mjs)、[docs/shared-host-github-accounts.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/shared-host-github-accounts.md)。

Agent 命令入口：`remotelab github-workspace`。

### 安装、运行、升级与实例健康检查

配置宿主机和服务，启动或重启已有实例，检查配置与版本。

入口：把目标实例、机器和已有条件交给维护 Agent；现行 setup 与实例工厂说明。

使用条件：部署操作有自己的权限和验收。旧状态升级可能需要专门转换；源码提交不证明活跃服务已经加载。

可以这样说：“检查这个实例的版本和健康状态，按现行流程处理必要的升级。”

维护线索：[docs/setup.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/setup.md)、[docs/request-state-upgrade.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/request-state-upgrade.md)、[docs/instance-factory-v1.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/instance-factory-v1.md)、[cli.js](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/cli.js)。

Agent 命令入口：`remotelab setup`、`remotelab start`、`remotelab stop`、`remotelab restart`、`remotelab chat`、`remotelab upgrade-state`、`remotelab provision-host`、`remotelab bootstrap-host`、`remotelab install-profile`、`remotelab validate-profile`。

### 隔离的 guest 实例

在同机创建和管理拥有独立运行环境的实例，并按受控方式暴露已有服务。

入口：由部署 Agent 使用 guest-instance。

使用条件：这是实例层的运行隔离，不是同一实例内的个人会话权限。需宿主机管理权限与明确目标。

可以这样说：“先检查本机条件，再为指定用途准备独立实例。”

维护线索：[lib/guest-instance-command.mjs](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/lib/guest-instance-command.mjs)、[docs/instance-factory-v1.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/instance-factory-v1.md)、[docs/platform-skills/guest-port-expose.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/platform-skills/guest-port-expose.md)。

Agent 命令入口：`remotelab guest-instance`。

### 可选的产品跟踪、GitHub 分诊与 CI 修复

复用仓库中的专项脚本，将来源更新或开发故障带回既有工作流程。

入口：对应专项文档和脚本，由维护 Agent 先检查是否已经配置。

使用条件：这些是可选流程，未逐一核对本实例启用状态。旧脚本存在不证明它仍在定时运行。

可以这样说：“检查这个仓库是否已有 CI 修复流程，说明状态和授权范围。”

维护线索：[docs/remote-capability-monitor.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/remote-capability-monitor.md)、[docs/github-auto-triage.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/github-auto-triage.md)、[docs/github-ci-auto-repair.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/github-ci-auto-repair.md)、[docs/proactive-observer.md](https://github.com/Ninglo/remotelab/blob/16e1dce2a661528ca72f369239f9cd4b022a77b3/docs/proactive-observer.md)。

## monitor 和 fleet

RemoteLab 监控器的总览聚合本实例账号、用量、磁盘、自动化和已登记服务；Fleet Observer 跨机器采集账号额度、去重并保留来源及历史。RemoteLab 可读取配置好的 fleet 脱敏快照，现有集成不代表所有 fleet 管理功能已迁入 RemoteLab。

Fleet Observer：它是监控数据源和独立管理入口；RemoteLab 监控总览可读取已配置的脱敏快照。本次未验收所有 Adapter 的覆盖与线上管理操作。
领域 Skill 与外部工作流：这些方法可以使用 RemoteLab 的会话、触发和交付，但领域数据和结果由原项目维护。安装的方法不等于所有实例都有设备、账号与业务权限。

## 待作者确认

- 请各模块作者补充：没有菜单的操作、命令下的重要子能力、特殊使用条件，以及本表没有覆盖的实际场景。
- 请部署维护者确认：在哪些实例启用、依赖什么账号或设备、哪些旧功能已经停用，哪些说明需要更新。
- 仓库外的个人脚本、独立网站、系统服务和领域项目没有统一登记；本次不会把扫描一个仓库称为组织全部能力盘点。
- 每项功能的作者与当前维护人尚未正式登记；需要本人或已有明确记录确认，不能从 git blame 推断责任。
- 本次仅核对有限只读运行入口，没有逐项执行业务写入、发消息、设备操作或未来自动化验收。

作者补漏输入：

```text
你参与编写或正在维护的模块／功能：
它能解决什么问题，给一个实际例子：
用户入口与启用条件，支持哪些实例：
对应源码、原文档或仓库外脚本的维护位置：
最初作者与当前维护人（分别填写，未知就保留未知）：
确认人、日期和可以核对的依据：
本清单的遗漏、错误或已经停用的条目：
```

## CLI 覆盖对照

| 主命令 | 对应功能 |
| --- | --- |
| setup | 安装、运行、升级与实例健康检查 |
| start | 安装、运行、升级与实例健康检查 |
| stop | 安装、运行、升级与实例健康检查 |
| restart | 安装、运行、升级与实例健康检查 |
| upgrade-state | 安装、运行、升级与实例健康检查 |
| provision-host | 安装、运行、升级与实例健康检查 |
| bootstrap-host | 安装、运行、升级与实例健康检查 |
| install-profile | 安装、运行、升级与实例健康检查 |
| validate-profile | 安装、运行、升级与实例健康检查 |
| guest-instance | 隔离的 guest 实例 |
| publish | 静态网页发布 |
| preview | 本地服务预览与端口暴露 |
| chat | 安装、运行、升级与实例健康检查 |
| api | 会话与执行故障定位 |
| mail | Agent 邮箱与 Gmail |
| gmail | Agent 邮箱与 Gmail |
| github-workspace | 个人 GitHub 工作目录与身份核对 |
| connector | 绑定的连接器动作和其他消息接入 |
| feishu | 飞书文档和办公操作 |
| assistant-message | 结果文件与附件下载 |
| workboard | 任务卡、进度和验收依据 |
| recording | 硬件讨论录音 |
| local-bridge | 会话绑定的本地助手 |
| agenda | 日历事件和订阅提醒 |
| todo | 个人待办、截止时间与数字进度 |
| memory | 项目、个人与公司资料接续 |
| trigger | 一次性自动工作 |
| schedule | 重复执行的自动化 |
| usage-summary | 监控器的总览与自动化列表 |
| session-preflight | 会话与执行故障定位 |
| quick-stats | Auto 路由与 Quick 会话 |
| session-spawn | 复制会话与分出独立工作 |
| generate-token | 人员与登录方式管理 |
| set-password | 人员与登录方式管理 |

主命令覆盖只证明这些入口已对应条目，不证明所有功能都已找到。子操作、接口、连接器回调和仓库外能力仍需确认。

## 核对范围

- 核对时，本实例的服务版本与本章源码基线一致。工具目录、监控总览和自动化任务的只读接口返回成功；这不证明每项业务操作、未来定时执行或所有实例都可用。
- 本机 PATH 中的 CLI 帮助比本次核对的源码少了 workboard 和 recording 两项。本章以所选实例的源码 CLI 为准；使用时让 Agent 先确认自己的实例和版本。
- 作者确认尚未完成。提交作者、机器用户名或 Agent 写代码的身份，都不能直接当作这个功能的当前负责人。

内容源为 features.json；运行 node docs/architecture-atlas/render-features.mjs 生成网页与本文。

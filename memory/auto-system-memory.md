# Auto-Promoted System Memory Review Queue

This file is a temporary review queue for automatically proposed cross-deployment learnings.

Before publishing the repository:

- promote only stable, deployment-agnostic lessons into `memory/system.md`
- move user-, machine-, customer-, project-, and incident-specific notes into local or project-scoped memory
- remove duplicates, dated case residue, credentials, private paths, hostnames, account identifiers, and raw investigation logs
- leave this queue empty after review

## Candidates

<!-- Automatically proposed candidates may be appended below. -->

- Static artifact delivery verification must check the final URL and expected artifact marker/title, not only an eventual HTTP 200 and `text/html`: an authentication redirect can end on a login page that returns 200. Treat a login redirect or unexpected page as an incomplete user handoff.

## Learnings

- RemoteLab 的邮箱连接必须由 WebUI 用户通过 SSO/OAuth 明确授权，查询只能使用与当前实例和用户绑定的令牌；未授权时应提示授权，不得回退到机器预置的 CLI 身份。
- 用户隔离边界是独立 RemoteLab 实例，不是 Session。每个用户实例拥有自己的配置、记忆、工作区、认证、Connector 与多个任务 Session；不要在单实例里用会话标签模拟多用户隔离。
- RemoteLab 新建会话采用前端空白草稿：只有首次发送消息或附件时才创建后端 Session，避免遗留空会话。
- RemoteLab 中 Codex/对话旧线程失效属于可恢复小故障，应由系统自动恢复：优先为同一条用户消息创建新线程重跑并保存新线程 ID，而不是让用户看到报错或要求重发。
- Feishu Connector Fork Session 上下文串线根因：当根消息未 @ 机器人导致精确父 Session 映射失败时，fallback 策略会选择同群最近使用的 Session，造成不同 thread 上下文被继承串联。修复方向：有明确 root_id 但无法精确映射时，禁止模糊继承，改为创建全新 topic Session，通过 Feishu 单消息接口读取根消息作为初始上下文，仅在确认 root/parent message → Session 映射时才允许 Fork。
- RemoteLab 的会话 Fork 应定义为从明确消息检查点创建分支，并将会话绑定、上下文来源和回复目标分开管理；不得用最近会话猜测继承来源。
- 飞书 Connector 应区分补读上下文与触发执行：未触发机器人的根消息、文件和卡片可作为背景读入，但不能被逐条重新执行。
- 飞书任务巡检遇到无权读取时，应区分应用 API scope 与具体任务资源权限；即使 task read/write scope 已批准，应用仍须被有编辑权限的成员加入任务关注人或任务清单可读成员，且无权应用不能自行提权。
- 飞书 Connector 发送 post/md 时应保留完整 Markdown 块，不能逐行拆分；Thread 回复与普通消息使用同一内容结构，兼容逻辑应放在 Connector 层而非依赖模型 Skill。
- 飞书资源读取不应由实例配置强制限制为 Bot 身份；应允许使用飞书 CLI 已有的用户授权，并在 Bot 无权时尝试用户身份。
- 飞书 CLI 的 profile 切换只能使用实例中已存在的登录态，不能自动继承群内发言人的权限；缺少用户登录态时必须先由可访问资源的用户完成授权。
- 排查飞书文档内任务“页面可见但 Task API 不可读”时，应分别验证文档访问权限、应用 scope、用户 OAuth 授权和任务资源 ACL；文档展示任务块不代表调用身份拥有任务详情读取权。
- 文档任务遇到 Task API 权限拒绝时，先确认该块是文档内原生创建的任务还是从任务中心粘贴的实时引用；实时引用不会自动继承文档权限，原生任务在具备文档编辑权时仍不可读则应排查任务 ACL 同步或权限传播异常。
- 接入仿真评测时，应由官方 benchmark 持有 simulator、episode loop 和 success 判定；RemoteLab 只负责启动编排、运行身份绑定、结果归一化与验收。
- Server 模式评测协议应显式约定 observation/action schema、相机布局与变换、动作坐标系、夹爪语义、控制频率和握手版本，并将 checkpoint、manifest 与 runtime 摘要绑定到每次运行及续跑判断。
- 仿真 benchmark readiness 至少需要官方正例、确定性负对照及官方参考模型三道机械验证；抽样只证明链路，资产完整性应通过全量静态清单和轻量运行 gate 验证。
- 可视化评测产物应同时保留模型实际 observation、原始 simulator 视角、逐步 action/state trace、成功判定依据和人工 review 状态，以便识别图像变换及动作语义错误。
- RemoteLab Connector 必须持久化普通请求的 in-flight 等待与发送状态，并在启动时自动续投；仅持久化 Session/run 不足以保证重启后结果回传。
- RemoteLab 使用 Cloudflare 临时隧道时，公网地址会随隧道重启而变化；若需固定入口，应改用自有域名和持久化 Tunnel Token。
- RemoteLab 各 connector 的首次会话入口链接应在统一的 reply publication 投影层生成，而不是进入 agent 流程或逐个修改 connector；是否首次回复应依据持久化完整 history 判断，链接仅在配置绝对公网地址且渠道声明支持时附加，且不得携带 owner token。
- RemoteLab 自身更新或重启可能中断当前会话时，完成通知应通过不依赖该会话的机制，在原消息线程另发消息，不能仅依赖会话最终回复。
- RemoteLab 的独立监控遇到持续阻塞时，必须将其识别为异常并通知当前用户会话，同时触发或明确上报恢复流程；不得把阻塞降级为 no-change，也不得只在监控会话中留日志。
- RemoteLab 不应把消息事件写入成功等同于用户可见通知成功；尤其目标 Session 正在运行时，插入的消息可能被折叠进 thinking block，必须另行核验正常时间线中的可见性。
- RemoteLab 的跨会话内部协调消息必须明确标注为 Agent 生成及其来源，不得记录成用户消息、触发自动会话命名，或把生产写入边界包装成用户要求的新任务或正式交接。
- 处理异步任务时，避免在前台会话中连续使用固定时长 sleep；应采用有终止条件的 watcher、长轮询或事件机制，并在等待期间推进可并行工作。
- 飞书 connector 可将非关键 reaction 从 admission 主流程拆为立即发起、异步完成；消息获取采用按 route 唤醒的长请求，同时保留持久化 outbox 重扫作为漏信号和重启后的可靠性兜底。
- RemoteLab Connector 创建 Session 时应对超长消息正文进行紧凑化，确保请求体低于接口大小上限，同时保留原消息 ID 的幂等处理，避免单条大消息阻塞整个 Inbox。
- 群聊复用连续 Session 时，必须将上下文连续性与回复目的地解耦：新的群根消息回复到本次入站消息，只有话题内消息才沿用原话题；应以“旧 Session 绑定旧话题后，新根消息不得回旧话题”作为回归约束。
- RemoteLab 的 Codex 账号切换应取消并等待进行中的额度查询退出，再串行执行 logout 和 device login，并在切换期间禁止启动新的额度查询；否则共享 runtime 竞争可能导致 logout 超时且旧凭据残留。
- 飞书消息最终投递时，正确的目标群聊不得被旧 Session 绑定覆盖；飞书回执处理也不得将 continue 模式重新写回 thread 模式。修复后应同时验证实际目标会话与是否进入 thread。
- RemoteLab 账号观测应分别建模物理机器、RemoteLab 实例、实例级 CODEX_HOME 和 Codex 账号；同一机器可运行多个实例并登录不同账号，不能把单个采集进程当作整机或全量资产。
- 飞书应用权限申请接口只能申请已加入应用版本但尚未授权的权限；若返回 unauthorized scopes were empty，应先在开发者后台为应用版本配置新的未授权权限，再发起申请。
- RemoteLab 预检应采用 fail-open：最多重试三次；即使未通过或预检出错，也只记录 warning，并在同一 durable Run 中继续提交并执行最初的原始 Prompt。
- RemoteLab 的 JSONL 原生协议必须仅按 LF 字节分帧；不能使用会将 U+2028/U+2029 识别为行边界的文本行读取器，否则可能截断字符串并触发 JSON 解析失败。
- Feishu 转发合并事件应保留正常记录、去重和排队，仅在准入阶段忽略且不创建 Session；同一线程后续出现文本回复时仍按原有逻辑触发。
- RemoteLab 等第三方 coding agent 不应接入 Antigravity 订阅登录额度；合规调用 Gemini 应使用 AI Studio API key 或 Google Cloud Vertex。
- RemoteLab 将运行时配置建模为 Harness（代码中称 tool）、model、effort 三元组；Default、Session 及 Web/飞书配置同步均处理完整三项。
- 定时任务和触发器的继承策略会保留来源 Session 的 Harness，仅在其与全局默认 Harness 相同时补齐默认 model 和 effort，而非用全局三元组整体覆盖。
- RemoteLab 的 RuntimeProfile 应将 harness、model、effort 作为原子快照处理：schedule/trigger 无显式覆盖时继承完整 Default；切换 Harness 时解析该 Harness 的默认 model/effort，避免跨 Harness 混合配置；Quick Session 可保留固定配置例外。
- 飞书 User access token 不可设为永久；需要长期免扫码时，应申请 offline_access，并通过单写入者的可靠滚动刷新、失败监控和到期预警维持授权。
- 无人值守和定时任务应优先使用 Bot/tenant 身份；仅在必须代表具体用户操作时使用 User OAuth。
- 飞书回复位置（inline/thread）与执行配置（standard/quick）是正交维度；话题群只允许 thread，但新话题入口仍应接受 /quick 并创建 Quick Thread Session，已有话题则沿用其已固定的执行配置。
- RemoteLab 自动标题的竞态保护应以已覆盖的用户消息序号或 barrier 判断新旧；被 native steer 合并进同一执行链的消息共享同一完成边界，不能用请求 runId 严格相等判断，否则分类结果会被误丢弃。
- RemoteLab preflight 应按 user_turn、scheduled_user_work、metadata、maintenance 等执行目的决定；标题生成、记忆整理、上下文压缩等纯元数据或维护任务可跳过，但语义上执行用户要求的定时任务不应仅因标记为 internal 而跳过。
- 自动标题应仅由首条实质消息初始化临时值，并为已完成但仍处于 autoRenamePending 的 Session 提供可恢复重试，同时持久化 applied、discarded 或 error 原因。
- 飞书回复拓扑统一规则：普通群允许 inline 或 thread；话题群固定 thread 并拒绝 inline；quick 只选择执行配置，不改变回复位置。
- 话题可用 /quick 正文新建 Quick Session；已绑定 Standard Session 的旧话题不可原地切换为 Quick，应提示新开话题；已绑定 Quick 的话题可继续使用 /quick。
- RemoteLab Task Center 短期继续以 Trigger/Schedule 作为任务身份，不引入独立的重量级自动化实体；任务需正交支持有限或永续生命周期，以及直接触发 Session 或先运行轻量脚本判定是否唤醒 Agent 两种方式，以适配无需每次经过 AI 的高频监控。
- RemoteLab 不再提供 compact 和 drop tools；活动上下文压缩与工具裁剪交由 Codex、Pi 等 Harness 管理，历史 continuation 仅保留读取兼容。
- Session 自动重命名应以分类器实际读取的最新用户消息序号判断结果是否过期，不能依赖 native steering 中可能变化的 request/run ID。
- Preflight 应按执行目的启用：交互任务和定时用户任务保留，metadata、maintenance 等后台静默请求跳过。
- RemoteLab 的默认模型仅作用于新建会话或明确切换模型的会话；已有、恢复及调度复用的 Session 会继续沿用其持久化的会话级模型配置，不会随默认值追溯迁移。
- RemoteLab 调度中的 Default 应表示动态继承：每次创建新的执行 Session 时读取最新 Default；同一自然日复用已有 Session 时保持其既定模型，显式模型选择则始终固定。
- RemoteLab 自动任务统一支持“跟随 Default”和“固定配置”：跟随模式仅在创建新执行会话时读取最新 Default，复用既有会话时保留原模型配置。
- RemoteLab WebUI 应展示会话中实际保存且模型可见的自定义要求，方便用户核对上下文；同时明确区分 RemoteLab 会话要求与 Harness 管理的系统、安全及工具规则。
- 群配置中的会话要求发生变化时，连接器应同步更新已绑定的话题 Session，不能只让新话题生效。
- RemoteLab WebUI 应在 Thought 中用统一的模型上下文 slot 展示本次实际发送给模型的可见内容；模型可见的上下文原则上也应让用户可见，不为单类提示设计独立面板，也不伪造无法取得的 Harness 原生隐藏提示。
- RemoteLab 将 Auto 固定为新 Session 的不可修改默认值；模型或 effort 的手动调整仅作用于当前 Session，不同步到其他 Session，也不改变后续新 Session 的默认行为。
- RemoteLab 新建 Session 默认使用 Auto：JEV 根据首条消息选择模型和 effort；选择后当前 Session 保持不变，用户仍可手动修改。判断不确定或 JEV 调用失败时回退到质量档。
- RemoteLab 的 Session 启动上下文仅强注入缺失后会影响来源、权限范围或交付方式，且工具无法及时说明的信息；各项能力保留简短入口，参数和流程细节在相关任务触发后查阅。
- 治理启动上下文时，先建立统一能力目录，再迁移长段说明，最后收缩每轮重复内容；新增说明须写明具体错误风险、负责人、激活条件、更新方式及验证场景。

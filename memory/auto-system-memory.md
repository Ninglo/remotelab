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

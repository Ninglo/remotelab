// One row is one point in a user's journey. Every route uses the same questions.
// Instance-specific statements remain marked in the route names and copy.
export const journeyStages = [
  { id: 'input', title: '发出输入', question: '谁发起了这件事？', nodes: ['surface', 'person'] },
  { id: 'receive', title: '接收与接纳', question: 'RemoteLab 收到了什么，按什么规则接纳？', nodes: ['admission', 'feishu-ingress', 'automation'] },
  { id: 'record', title: '绑定与存储', question: '这条输入归到哪个 Session，先写下什么？', nodes: ['session', 'request', 'history', 'feishu-observation'] },
  { id: 'decide', title: '判断与策略', question: '谁判断是否工作，谁决定如何做？', nodes: ['quick-participation', 'classifier', 'prompt', 'harness'] },
  { id: 'work', title: '执行工作', question: '有没有 Run，工具和模型在哪里运行？', nodes: ['run', 'harness', 'native-skill'] },
  { id: 'return', title: '返回结果', question: '结果怎样到用户手里，哪里有回执？', nodes: ['outbox', 'artifacts', 'history'] },
  { id: 'after', title: '轮后再使用', question: '哪些内容会留下，怎样影响未来？', nodes: ['memory-writeback', 'memory-index', 'skill-review', 'semantic-forgetting'] },
];

const web = {
  input: {
    summary: '用户在网页 Session 中发文字或附件。', visible: '发送后，用户先看到自己的消息和运行状态。',
    action: '浏览器从当前 Session 发起消息；登录身份决定可访问的实例和个人视图。',
    stored: '附件先成为可引用的文件资产；输入本身还未等于一次模型执行。',
    resources: '浏览器与服务器交互；此时没有任务模型 token。',
    protocol: '浏览器 HTTPS/HTTP。', sources: [{ path: 'chat/router-session-main-routes.mjs', line: 417 }],
  },
  receive: {
    summary: '控制面验证输入、选择运行设置并接纳 Request。', visible: '页面得到已接纳、排队或错误状态。',
    action: 'HTTP 路由校验 Session 权限、正文和附件；submitHttpMessage 处理忙碌条件与运行设置，再接纳 Request。自动路由若启用需单独计量。',
    stored: 'Request 持久记录 requestId、目标 Session、文字、附件引用、运行设置与必要的投递计划。',
    resources: '以本地程序、磁盘写入和 HTTP 为主；自动路由是否额外用模型看具体配置与账本。',
    protocol: 'POST /api/sessions/{id}/messages → 控制面 Request runtime。', sources: [{ path: 'chat/router-session-main-routes.mjs', line: 417 }, { path: 'chat/session-manager.mjs', line: 3057 }],
  },
  record: {
    summary: 'Request 绑定 Session；准备 Run 时追加用户历史事件。', visible: '用户消息出现在这个 Session 中，后续可回看。',
    action: 'RemoteLab 按 Session 绑定 Request 与 Run；准备运行时用 requestId 去重，追加 user/message 事件。',
    stored: 'Session 元数据、requests/、chat-history/{sessionId}/events/；附件在 file-assets/。',
    resources: '本地磁盘增量；大小取决于正文、附件及后续事件，不能按“发一条消息”给固定字节数。',
    protocol: '控制面内部调用与本地持久记录。', sources: [{ path: 'chat/session-manager.mjs', line: 3093 }, { path: 'chat/session-manager.mjs', line: 3128 }],
  },
  decide: {
    summary: 'RemoteLab 准备运行边界，Harness 在运行中理解任务。', visible: '用户看到已进入运行；计划与工具活动由所选 Harness 表现。',
    action: 'RemoteLab 选择/固定 Harness、模型和上下文边界；实际任务理解、计划与工具选择发生在 Harness 的工作 Run 内。',
    stored: '运行清单与可追溯的上下文事件；不是独立的“总控大脑”文件。',
    resources: '选择运行设置主要是程序逻辑；若启用模型路由另计；Harness 的思考消耗前台模型 token。',
    protocol: '控制面 → detached runner → Harness 自有运行协议。', sources: [{ path: 'chat/session-manager.mjs', line: 3079 }, { path: 'docs/project-architecture.md', line: 106 }],
  },
  work: {
    summary: 'Run 执行 Harness 任务、工具调用和结果生成。', visible: '页面可看到状态、工具过程与最终文字；具体可见度取决于事件投影。',
    action: 'Harness 决定步骤并调用可用工具；RemoteLab 负责运行持久化、输出归一化和中断恢复。',
    stored: 'chat-runs/ 原始输出、状态与结果；chat-history/ 中有归一化的消息和工具事件；usage-ledger/ 记可归属用量。',
    resources: 'Harness 模型 token、工具 CPU/网络/外部 API 与磁盘；不能把一次用户输入算成固定一次模型调用。',
    protocol: '本地 detached runner 与 Harness；工具再访问本机或外部服务。', sources: [{ path: 'docs/project-architecture.md', line: 106 }, { path: 'chat/session-manager.mjs', line: 3153 }],
  },
  return: {
    summary: '最终事件留在 Session，网页读取并渲染。', visible: '用户在同一 Session 看到答复；成果文件需另有可打开入口。',
    action: 'RemoteLab 归一化结果并通知页面重新读取；WebSocket 是失效提示，HTTP 是规范读取。',
    stored: 'assistant/message 事件、Run 终态、文件资产或发布记录。',
    resources: '页面 HTTP/WebSocket 与文件流量；渲染本身不新增任务模型 token。',
    protocol: '控制面 HTTP 读取 + WebSocket 提示。', sources: [{ path: 'docs/project-architecture.md', line: 106 }, { path: 'static/chat/realtime-render.js', line: 116 }],
  },
  after: {
    summary: '普通已完成轮次可能触发状态整理和记忆审阅。', visible: '用户未必立即看到变化；后续能否真正复用需另核。',
    action: '轮后条件允许时，RemoteLab 启动状态/工作摘要整理及记忆候选审阅；写入是否发生有跳过条件。Skill 候选检查是另一个定时流程。',
    stored: 'Session 元数据/历史、记忆 Markdown、候选审阅记录；原始历史与长期记忆不是同一物。',
    resources: '可能另耗后台模型 token 和磁盘；应按独立 Run/操作归因。',
    protocol: '完成回调 → 后台 detached Harness 或定时 Schedule。', sources: [{ path: 'chat/session-manager.mjs', line: 1871 }, { path: 'chat/session-manager.mjs', line: 1890 }],
  },
};

const feishuShared = {
  input: {
    summary: '群成员在飞书发一条消息。', visible: '用户先在飞书看到自己的原消息。',
    action: '飞书连接器接收群消息事件，提取发送者、群、话题、@、正文与附件线索。',
    stored: '飞书原消息仍在飞书；连接器稍后保存来源事件。',
    resources: '飞书长连接事件和少量本地处理；接收本身不调用 Harness。',
    protocol: '飞书持久 WebSocket → 连接器。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1877 }],
  },
  receive: {
    summary: '连接器先落 inbox，再按群配置和来源规则路由。', visible: '此时飞书里未必有 Bot 回应。',
    action: '连接器去重、检查来源/群规则、命令、@ 与主线或话题绑定；服务身份调用 RemoteLab，sourceContext 保留实际发送者。',
    stored: '连接器耐久 inbox、来源索引与会话绑定；被过滤的消息不等于 Harness 工作。',
    resources: '固定程序、磁盘和飞书事件通道；后续飞书 API 及模型调用另算。',
    protocol: '连接器本地处理 → RemoteLab 本机 HTTP API。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1877 }, { path: 'connectors/feishu/group-settings.mjs', line: 64 }],
  },
};

const feishuOld = {
  ...feishuShared,
  record: {
    summary: '已接纳消息绑定群 Session 并提交正常 Request。', visible: '群中会先出现临时 THINKING 表情。',
    action: '旧 quickReactions 启动 THINKING 与 Jev 快速判断；正常提交路径仍接纳 Request，用户事件在 Run 准备阶段写入 Session。两路可能并行。',
    stored: '连接器快速判断日志；requests/、chat-history/、chat-runs/ 随正式工作产生。',
    resources: 'THINKING 使用飞书 reaction API；快速 Jev 是外部模型调用；正式工作再有 Harness token。',
    protocol: '连接器 → 飞书 reaction OpenAPI；连接器 → RemoteLab /messages。', sources: [{ path: 'connectors/feishu/quick-participation.mjs', line: 241 }, { path: 'scripts/feishu-connector.mjs', line: 1650 }],
  },
  decide: {
    summary: '快速 Jev 只做旁路判断，最终参与由 Harness 本轮决定。', visible: 'THINKING 是处理提示，不保证随后一定有文字。',
    action: 'Jev 判断写日志并可提名交接；它不拦截已接纳的正常 Run。Harness 阅读群上下文，在最终答复中选择结果表情及是否有文字。',
    stored: '快速判断日志和正式 Run 上下文；最终表情指令随结果处理。',
    resources: '快速 Jev 调用与 Harness token 都可能发生；Jev 用量未进入现有 RemoteLab Run 账本。',
    protocol: '连接器 → Jev 外部 API；Harness 最终指令 → 结果投递。', sources: [{ path: 'connectors/feishu/quick-participation.mjs', line: 258 }, { path: 'connectors/feishu/group-settings.mjs', line: 18 }],
  },
  work: {
    summary: '已接纳消息有正常 Harness Run，即使最终只发结果表情。', visible: '群成员可能看到答复文字，也可能只看到结果表情。',
    action: 'Harness 决定要不要使用工具及回复内容；群时间线指令要求较大的工作转到单独工作 Session。',
    stored: 'Request、Run、原始输出和 Session 归一化事件。',
    resources: 'Harness token 与工具资源；工作量由实际 Run 决定。',
    protocol: 'RemoteLab detached runner → Harness/工具。', sources: [{ path: 'connectors/feishu/group-settings.mjs', line: 32 }, { path: 'scripts/feishu-connector.mjs', line: 1665 }],
  },
  return: {
    summary: '投递层把结果表情、文字和附件送回原群或话题。', visible: 'THINKING 被结果表情替换；如有文字，用户在飞书看到答复。',
    action: 'RemoteLab 生成投递部分，连接器调用飞书 OpenAPI 并记录发送回执。',
    stored: 'outbox 投递状态、外部回执；答复也留在 Session 历史。',
    resources: '飞书 reaction/message API、重试和附件流量；发送程序本身不耗模型 token。',
    protocol: 'RemoteLab outbox → 连接器 → 飞书 OpenAPI。', sources: [{ path: 'lib/reply-deliveries.mjs', line: 4 }, { path: 'chat/source-deliveries.mjs', line: 99 }],
  },
  after: {
    summary: '群 Session 历史留存；group-feed 不走普通轮后自动记忆写回。', visible: '后续群讨论能继续引用上下文；是否记得具体内容取决于实际读取窗口。',
    action: 'Session 原始事件保留；group-feed Session 被轮后记忆写回的跳过条件排除。独立日报或项目知识流程另有规则。',
    stored: 'chat-history/、Session 摘要与来源记录；不是自动进入全局记忆或 Skill。',
    resources: '历史持续占盘；后续读取/总结若调用模型再计。',
    protocol: '本地 Session 历史；后续独立 Schedule/Trigger 可读取。', sources: [{ path: 'chat/session-manager.mjs', line: 1890 }],
  },
};

const feishuNewBase = {
  ...feishuShared,
  record: {
    summary: '先把原消息作为观察事件写进群主线 Session。', visible: '飞书用户仍只看到原消息；Session 网页里出现普通用户气泡。',
    action: '连接器 POST /observations；group-feed Session 先追加 user/message/feishu_observation。它发生在 Jev 判断和附件解析之前。',
    stored: 'chat-history/{sessionId}/events/ 用户事件；session-observations/ 去重记录；附件资产此时未解析。',
    resources: '本地 HTTP 与磁盘写入；尚未启动 Harness。',
    protocol: '飞书连接器 → POST /api/sessions/{id}/observations。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1051 }, { path: 'chat/session-observations.mjs', line: 49 }],
  },
  decide: {
    summary: 'Jev 读这个 Session 的短窗口，决定 reply 或 silent。', visible: '没有临时 THINKING；用户要等结果表情。',
    action: 'Jev 用最近最多 20 条、2 小时、5,000 字符的上下文判断参与和表情；决定写入记录及 system/reaction_decision 事件。明确要求只发表情时可保持 silent。',
    stored: 'session-observations/ 决策；chat-history/ 的 reaction_decision 系统事件。',
    resources: '外部 Jev 模型调用；当前 RemoteLab Run 用量账本未覆盖它。',
    protocol: '连接器 → Jev 外部 API → RemoteLab /observations/decision。', sources: [{ path: 'connectors/feishu/quick-participation.mjs', line: 10 }, { path: 'scripts/feishu-connector.mjs', line: 1147 }],
  },
  after: feishuOld.after,
};

const feishuNewSilent = {
  ...feishuNewBase,
  work: {
    summary: 'silent 分支没有正式工作 Run。', visible: '不会出现 Bot 的文字任务回复。',
    action: '连接器跳过 submitRemoteLabRequest 的工作路径；Harness 不读取这条消息作为一个新工作轮次。',
    stored: '没有该消息对应的工作 Run；观察事件和 Jev 决策已保留。',
    resources: '这一分支没有前台 Harness token；先前 Jev 调用仍有成本。',
    protocol: '本地分支判断，无 Harness 运行调用。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1178 }], skipped: true,
  },
  return: {
    summary: '仍会排队一个结果表情。', visible: '群用户在原消息上看到结果表情，不看到 Bot 文字。',
    action: '固定程序创建 delivery-only Request/outbox；连接器调用飞书 reaction API。',
    stored: '投递状态与回执；不是工作 Run。',
    resources: '飞书 reaction API 配额与投递存储；发送行为不新增模型 token。',
    protocol: 'RemoteLab /source-deliveries → 连接器 → 飞书 reaction OpenAPI。', sources: [{ path: 'chat/source-deliveries.mjs', line: 99 }, { path: 'scripts/feishu-connector.mjs', line: 1183 }],
  },
};

const feishuNewReply = {
  ...feishuNewBase,
  work: {
    summary: 'reply 分支复用已观察的用户事件，启动正式 Harness Run。', visible: '原消息可见 OnIt，之后收到文字或交接；实际先后以投递回执为准。',
    action: '连接器提交工作请求时设置 recordUserMessage=false，避免把已观察的消息再写一次；Harness 在 Run 中理解任务、规划工具。',
    stored: '同一 Session 中一条用户观察事件；另有正式 Request/Run、输出事件与用量。',
    resources: '除 Jev 以外，再产生 Harness token、工具/API 和 Run 磁盘占用。',
    protocol: '连接器 → RemoteLab /messages → detached runner → Harness。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1178 }, { path: 'scripts/feishu-connector.mjs', line: 957 }],
  },
  return: {
    summary: 'OnIt 和正常答复都走各自的投递记录。', visible: '飞书原消息可能出现 OnIt；用户还会收到可见答复或工作 Session 交接。',
    action: 'OnIt 由连接器通过 outbox 排队；文字、附件和工作结果按 Request 的原目标投递。',
    stored: '结果事件、投递记录、飞书回执和可能的文件资产。',
    resources: '飞书 reaction/message API 与附件流量；模型成本已经发生在 Jev/Run。',
    protocol: 'RemoteLab outbox → 飞书 OpenAPI。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1183 }, { path: 'lib/reply-deliveries.mjs', line: 4 }],
  },
};

const feishuCommand = {
  ...feishuShared,
  input: { ...feishuShared.input, summary: '试验群成员发送无正文的 /help。', visible: '用户在飞书看到自己发出的 /help。' },
  record: {
    summary: '试验群仍先追加观察事件。', visible: '网页群 Session 可见这条 /help 用户消息。',
    action: 'jevReactions 分支先调用 /observations；随后连接器识别本地命令。',
    stored: 'Session 观察事件和去重记录；此命令不产生普通 Jev 参与决策事件。',
    resources: '本地 HTTP/磁盘；无此命令的 Jev 判断 token。',
    protocol: '连接器 → RemoteLab /observations。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1587 }],
  },
  decide: {
    summary: '命令解析交给固定程序。', visible: '用户等待固定的帮助文字。',
    action: '连接器命中无正文控制/查询命令，直接调用 runtime-commands；不进入普通 Jev 参与判断。',
    stored: '命令处理所需的设置/状态按具体命令读取；/help 本身不改变 Skill 或模型设置。',
    resources: '/help 的回答由固定程序生成；无 Jev 或 Harness token。',
    protocol: '连接器本地命令处理。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1617 }, { path: 'connectors/feishu/runtime-commands.mjs' }],
  },
  work: {
    summary: '/help 无正式 Harness Run。', visible: '没有工作过程或工具日志。',
    action: '固定命令响应直接返回投递文本。', stored: '没有工作 Run；只保留观察与投递相关状态。',
    resources: '本地程序 CPU/磁盘，无任务模型 token。', protocol: '本地函数调用。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1627 }], skipped: true,
  },
  return: {
    summary: '固定说明文字经 outbox 发回飞书。', visible: '用户在群中看到 /help 回复。',
    action: '连接器排队回复；sender 调用飞书消息 OpenAPI 并记录回执。',
    stored: 'delivery-only Request、投递部分和外部回执。', resources: '飞书消息 API 与少量持久记录，不新增模型 token。',
    protocol: 'RemoteLab /source-deliveries → 飞书 OpenAPI。', sources: [{ path: 'scripts/feishu-connector.mjs', line: 1633 }, { path: 'chat/source-deliveries.mjs', line: 99 }],
  },
  after: feishuOld.after,
};

const daily = {
  input: {
    summary: '实例配置的日报 Schedule 到达开始时间。', visible: '到点并不表示飞书群已经收到日报。',
    action: '调度器发现到期 occurrence；若配置脚本 gate，先由固定脚本判断是否创建 Trigger。',
    stored: 'Schedule 配置及上次/下次检查状态。', resources: '本地时钟检查及可选脚本 CPU；尚无日报 Harness token。',
    protocol: '本机调度器 → 可选 bash/node/python gate。', sources: [{ path: 'chat/recurring-schedules.mjs', line: 739 }, { path: 'chat/recurring-schedules.mjs', line: 651 }],
  },
  receive: {
    summary: 'Schedule gate 通过后，生成有去重键的 Trigger。', visible: '用户通常看不到接纳过程。',
    action: 'RemoteLab 检查并发、次数、冷却和 gate 结果；通过后创建 Trigger 并接纳执行。',
    stored: 'Schedule 检查点、Trigger/occurrence 与执行归属。', resources: '固定程序与持久写入；脚本 gate 本身不使用 Harness token。',
    protocol: '本机 Schedule → Trigger 控制面。', sources: [{ path: 'chat/recurring-schedules.mjs', line: 760 }, { path: 'chat/recurring-schedules.mjs', line: 812 }],
  },
  record: {
    summary: 'Trigger 进入审阅 Session，再形成工作 Request/Run。', visible: '用户可在对应 Session 查看进度，群里尚未必有结果。',
    action: '平台按 Schedule 模板确定工作 Session 和提示文本；日报具体读取范围由实例规则定义。',
    stored: 'Trigger、Session、Request 与随后产生的 Run/历史事件。', resources: '本地持久状态与后续运行磁盘占用。',
    protocol: '本机调度/控制面 → Session。', sources: [{ path: 'chat/recurring-schedules.mjs', line: 818 }, { path: 'docs/project-architecture.md', line: 106 }],
  },
  decide: {
    summary: 'Harness 依据实例日报规则决定读哪些来源及如何核验。', visible: '用户看到的是最终审阅，不是 gate 的内部判断。',
    action: 'Schedule 只决定何时启动；Harness 按实例规则阅读讨论、主账、任务等，形成审阅判断。',
    stored: '来源检查点、项目知识库变更、当日 Markdown；具体覆盖需按本轮记录核对。',
    resources: '审阅是 Harness 模型调用；来源 API、文件读取和工具执行另计。',
    protocol: 'Harness → 本地文件/Git/飞书等来源。', sources: [{ path: 'chat/recurring-schedules.mjs', line: 818 }, { path: '实例配置 / 日报审阅提示与来源范围', instance: true }],
  },
  work: {
    summary: '审阅 Run 产生内容；固定出版器负责写入飞书文档。', visible: '日报文档可能逐步更新；群摘要往往稍后才到。',
    action: 'Harness 生成/修订现有 Markdown；出版脚本用飞书 Wiki/Docx API 更新并读回正文。',
    stored: 'Run 输出、项目知识库 Git、日报 Markdown、飞书文档与回读证据。',
    resources: 'Harness token、飞书 Docx/Wiki API、文件和 Git 增量；出版脚本自身不耗模型 token。',
    protocol: 'Harness/本地脚本 → 飞书 Docx/Wiki OpenAPI。', sources: [{ path: 'chat/session-manager.mjs', line: 3153 }, { path: '实例工作流程 / project-review/publish_daily_report.mjs', instance: true }],
  },
  return: {
    summary: '文档出版与群摘要投递是两个可分别验收的结果。', visible: '用户看到飞书群摘要，并可打开当日 Wiki。',
    action: '先核对文档正文/权限/绑定，再通过来源投递路径发送群摘要并记录回执。',
    stored: 'Wiki 文档、群投递记录与回执；“文档存在”不能代替“群已送达”。',
    resources: '飞书 API 调用、附件/页面流量与投递重试；没有新的内容模型 token。',
    protocol: '飞书 Docx/Wiki OpenAPI + 群消息 OpenAPI。', sources: [{ path: '实例工作流程 / project-review/publish_daily_report.mjs', instance: true }, { path: 'chat/source-deliveries.mjs', line: 99 }],
  },
  after: {
    summary: '日报更新项目主账；后续审阅以来源和新事实继续修订。', visible: '用户未来在日报与项目材料中看到持续修正的认识。',
    action: '这是实例工作流程的知识维护，不等同于平台的普通轮后自动记忆或自动 Skill 晋升。',
    stored: '项目知识库、当日 Markdown、来源检查点和飞书文档。', resources: '后续审阅继续使用 Harness、外部 API 与存储。',
    protocol: '定时 Schedule + 本地 Git/Markdown + 飞书 API。', sources: [{ path: 'chat/recurring-schedules.mjs', line: 739 }],
  },
};

export const journeyRoutes = [
  { id: 'web', label: '网页消息', kind: '常规工作', intro: '从网页消息进入标准 Request / Run 路径。', stages: web,
    marks: [['程序', '附件'], ['程序/可选路由', 'Request'], ['程序', 'Session 历史'], ['Harness/可选路由', 'Run 清单'], ['Harness + 工具', 'Run + 历史'], ['程序', '结果事件'], ['条件后台模型', '记忆候选']] },
  { id: 'feishu-old', label: '飞书旧规则', kind: '已接纳群消息', intro: '快速 Jev 旁路判断；已接纳消息仍进入 Harness。当前配置有 2 个这类群。', stages: feishuOld,
    marks: [['程序', '飞书原消息'], ['程序', 'inbox'], ['Jev + 程序', 'Request + 历史'], ['Jev + Harness', '判断日志'], ['Harness', 'Run'], ['飞书 API', 'outbox'], ['后续流程', 'Session 历史']] },
  { id: 'feishu-new-silent', label: '飞书新规则 · silent', kind: '试验群主线', intro: '先观察，再由 Jev 决定不启动工作 Run；只送结果表情。', stages: feishuNewSilent,
    marks: [['程序', '飞书原消息'], ['程序', 'inbox'], ['程序', '观察事件'], ['Jev', '决策事件'], ['无工作 Run', '无 Run 输出'], ['飞书 API', 'delivery-only'], ['程序', 'Session 历史']] },
  { id: 'feishu-new-reply', label: '飞书新规则 · reply', kind: '试验群主线', intro: '先观察，再由 Jev 接纳工作；正式 Run 复用原消息事件。', stages: feishuNewReply,
    marks: [['程序', '飞书原消息'], ['程序', 'inbox'], ['程序', '观察事件'], ['Jev', '决策事件'], ['Harness', 'Request + Run'], ['飞书 API', 'outbox'], ['程序', 'Session 历史']] },
  { id: 'feishu-command', label: '飞书固定命令', kind: '试验群 /help', intro: '先观察，随后由固定脚本回答；不调用 Jev 判断或 Harness。', stages: feishuCommand,
    marks: [['程序', '飞书原消息'], ['程序', 'inbox'], ['程序', '观察事件'], ['固定脚本', '读取命令状态'], ['无工作 Run', '无 Run 输出'], ['飞书 API', 'delivery-only'], ['程序', 'Session 历史']] },
  { id: 'daily', label: '定时日报', kind: '本实例流程', intro: '由 Schedule/Trigger 发起；Harness 审阅与固定出版器分工。', stages: daily,
    marks: [['调度/可选脚本', 'Schedule'], ['固定程序', 'Trigger'], ['程序', 'Session + Request'], ['Harness', '来源检查点'], ['Harness + 出版脚本', 'Markdown + Wiki'], ['飞书 API', '文档 + 回执'], ['后续 Harness', '项目知识库']] },
];

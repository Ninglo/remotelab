// A public, aggregate snapshot. No message text, identity, group ID or credential is included.
export const measuredAt = '2026-09-29 13:07 中国时间';

// Counts describe the inspected instance configuration, not a rollout guarantee.
export const feishuRules = {
  checkedAt: '2026-09-29 · 本实例配置与一条已落盘的 silent 记录',
  modes: [
    {
      name: '旧规则 · quickReactions', scope: '当前配置：2 个群',
      visible: '先出现临时 THINKING；随后可能有 Harness 选择的结果表情和文字。',
      decision: '连接器并行调用 Jev，记录快速判断与交接候选；已接纳的消息仍按原路径提交 Harness，快速判断本身不拦截工作 Run。',
      model: '快速 Jev 调用 + 正常任务的 Harness token；程序发送 THINKING 和最终投递，使用飞书 API。',
      writes: '连接器 inbox/快速判断日志；正常任务的 Session、Request、Run、用量记录及投递回执。',
    },
    {
      name: '新规则 · jevReactions', scope: '当前配置：1 个试验群的主线',
      visible: '不加临时 THINKING；Jev 判定 silent 时只在原消息上加结果表情，判定 reply 时加 OnIt 并启动答复。',
      decision: '先把消息写入绑定的 group-feed Session，再用近期 Session 消息调用 Jev；silent 跳过工作 Run，reply 复用已写入的用户事件提交任务。',
      model: '每条进入判断的消息有一次快速 Jev 调用；只有 reply 再产生 Harness token。结果表情由固定程序经飞书 API 发送。',
      writes: 'Session 用户事件、观察去重/决策记录、决策事件；silent 仍产生 delivery-only Request 和 outbox 回执。',
    },
  ],
  observation: [
    ['① 接收', '飞书 WebSocket → 连接器 inbox；核对群主线配置及消息路由。'],
    ['② 观察', '连接器 POST /api/sessions/{id}/observations；同一群绑定的 group-feed Session 追加 type=message、role=user、source=feishu_observation。'],
    ['③ 判断', 'Jev 读取该 Session 最近最多 20 条、最多 2 小时的消息，总上下文限 5,000 字符；决策写入 session-observations/，并追加 type=reaction_decision、role=system。'],
    ['④ silent', '不创建正式工作 Run；outbox 创建 delivery-only Request，连接器调用飞书 reaction OpenAPI。原始用户事件仍在 chat-history/{sessionId}/。'],
  ],
  boundaries: [
    '试验范围只覆盖选定群主线；该群话题、Thread 和其他群沿各自原有规则。旧规则不是所有群的统一规则。',
    '无正文的本地命令先进入观察 Session，然后走现有命令脚本；不会进入普通 Jev 参与判断。',
    '当前网页按普通用户消息气泡渲染观察事件，没有显示“已观察但未回复”的标记或飞书发送者；reaction_decision 也未在普通事件视图单独渲染。',
    '观察分支在附件解析前返回，用户事件只含文字/预览，没有附件资产；原始历史长期留存不等于附件已保存。',
    '近期 Jev 上下文是有界窗口；完整 Session 历史仍在磁盘。被保存并不等于下一次 Harness 一定会把原始事件全文作为提示读取。',
  ],
  sources: [
    { path: 'connectors/feishu/group-settings.mjs', line: 52, note: '启用条件和主线范围' },
    { path: 'scripts/feishu-connector.mjs', line: 1587, note: '先观察、命令分叉和 Jev 判断' },
    { path: 'chat/session-observations.mjs', line: 49, note: '用户事件、去重与近期上下文' },
    { path: 'chat/session-observations.mjs', line: 88, note: '决策记录和系统事件' },
    { path: 'chat/source-deliveries.mjs', line: 99, note: 'delivery-only 投递' },
    { path: 'static/chat/realtime-render.js', line: 116, note: '普通 Session 事件渲染' },
  ],
};

export const experiences = [
  {
    id: 'web-turn', title: '在网页发一条消息', visible: '用户看到消息进入 Session、运行状态、工具过程与最终答复；文件要另有可打开的交付入口。',
    tags: ['前台 Harness + 条件后台', '接入与运行编排由程序处理'], model: '前台 Harness：会调用', local: 'HTTP 接纳、Run 持久化和界面事件投影由 RemoteLab 程序处理', storage: 'Session 元数据、历史、Request、Run；有附件或成果时另占文件资产空间',
    stages: [
      ['固定程序', '浏览器通过 HTTP 提交消息，控制面接纳 Request、启动并跟踪 Run；WebSocket 主要传失效提示。'],
      ['模型调用', '所选 Harness 读取本轮上下文、决定工具和答案。模型 token 与工具执行时间随任务而变。'],
      ['条件模型调用', '完成后若符合条件，Session 状态整理和记忆审阅可分别启动后台模型调用；不应当只把一次用户消息算成一次模型调用。'],
      ['固定程序', '持久化事件和结果，更新页面；生成文件需进入资产或发布路径后才算可交付。'],
    ],
    protocol: '浏览器 HTTPS/HTTP + WebSocket 提示；控制面到本地 detached runner；Harness 使用自身运行协议。',
    measurement: '按 requestId/runId 查看前台与后台 usage ledger、持续时间、工具调用；按资产 ID 查看大小和是否可访问。',
    caveat: '后台检查有跳过条件；是否发生要以该 Run 的后置事件和 usage 记录为准。',
    nodes: ['surface', 'request', 'run', 'classifier', 'memory-writeback', 'artifacts'],
    sources: [{ path: 'docs/project-architecture.md', line: 106 }, { path: 'chat/session-turn-completion.mjs', line: 212 }, { path: 'chat/session-manager.mjs', line: 1879 }],
  },
  {
    id: 'feishu-task', title: '在飞书提出一个需要回答的任务', visible: '用户可能先看到“思考中”表情，之后在原群或话题看到文字、附件和结果表情。',
    tags: ['完整任务模型 + 可选快速模型', '接入与发送由程序处理'], model: '完整 Harness：接纳为任务后会调用；快速参与判断视群配置可能额外调用', local: '接收、去重、会话绑定、投递和飞书接口发送由连接器与控制面程序处理', storage: '飞书 inbox/事件/索引 + Request/Run/历史 + 文字、表情、附件各自的投递与回执',
    stages: [
      ['固定程序', '飞书长连接送来事件；连接器按群规则、静默状态、@ 与话题绑定判断是否接纳。'],
      ['可能的额外模型', '启用 quickReactions 的非 Jev 群会并行调用快速参与模型；Jev 模式先记观察，再调用模型决定是否只发表情或提交任务。'],
      ['模型调用', '真正的任务进入 Request 和 Run，由 Harness 阅读上下文、执行工具和生成内容。'],
      ['固定程序', '结果拆成文字、附件、结果表情等投递部分；连接器用飞书 OpenAPI 发送并写回回执。'],
    ],
    protocol: '飞书持久 WebSocket 事件 → 连接器 → RemoteLab 本机 HTTP API → Harness；出站 RemoteLab outbox → 飞书 OpenAPI。',
    measurement: '分开计快速判断调用、完整 Run 的 token、飞书 API 次数/限流、投递重试次数和从接收到用户可见的时延。',
    caveat: '群配置分叉很大；不能用一个群的行为代表所有飞书消息。表情发送本身无需模型，但选择表情可能已用模型。',
    nodes: ['feishu-ingress', 'quick-participation', 'request', 'harness', 'outbox'],
    sources: [{ path: 'scripts/feishu-connector.mjs', line: 1529 }, { path: 'scripts/feishu-connector.mjs', line: 1621 }, { path: 'lib/reply-deliveries.mjs', line: 4 }],
  },
  {
    id: 'feishu-reaction', title: '飞书只出现一个表情，或用户给 Bot 点表情', visible: '用户可能只看到“思考中”或结果表情；给 Bot 的回复点表情后通常不会看到新文字。',
    tags: ['按配置可能调用模型', '表情发送是固定程序'], model: '依路径而定：即时表情固定发送；快速分类、结果选择或隐藏反馈轮次可能调用模型', local: '创建/删除表情、记录反馈、静默开关和投递回执是程序动作', storage: '连接器事件和快速判断日志；若生成反馈 Request，还写 Session/Run/usage',
    stages: [
      ['固定程序', '即时 THINKING 由连接器调用飞书 reaction API，不需先让 Harness 决定。'],
      ['模型调用（配置条件）', 'quickReactions 用 Jev 判断是否参与；Jev 模式还能选择结果表情，未必启动完整 Harness。'],
      ['模型或预设', '普通结果表情可以来自 Harness 最终指令；若要求结果表情却未给出有效值，投递层有 EatingFood 兜底。'],
      ['隐藏模型调用（反馈条件）', '用户在 Bot 回复上点表情或 [嘘] 时，连接器可提交不对外回复的反馈轮次；这仍可能产生模型 token。'],
    ],
    protocol: '飞书 reaction 事件/WebSocket；飞书 reaction OpenAPI；反馈经 RemoteLab HTTP 进入 Session。',
    measurement: '每条消息串联原消息 ID、快速判断日志、Run、reaction API 回执；Jev 当前只有判断与时延日志，未见 token 纳入 RemoteLab usage ledger。',
    caveat: '“没发文字”不等于“没调用模型”。Jev 调用是否实际计费须查其服务侧账单。',
    nodes: ['quick-participation', 'outbox', 'feishu-ingress', 'usage-ledger'],
    sources: [{ path: 'connectors/feishu/quick-participation.mjs', line: 90 }, { path: 'scripts/feishu-connector.mjs', line: 1189 }, { path: 'scripts/feishu-connector.mjs', line: 1484 }],
  },
  {
    id: 'feishu-command', title: '飞书里发 /help、/status 或静默命令', visible: '用户得到固定说明、状态或静默确认；命令附带任务正文时走另一条任务路径。',
    tags: ['命令响应固定；反馈可能模型', '命令与投递由程序处理'], model: '命令响应本身是固定程序；/mute 和 /unmute 的反馈记录可能额外启动隐藏 Harness 轮次', local: '命令解析、查询状态、修改会话静默配置、排队回复均由程序处理', storage: '连接器设置、命令回复的投递记录；反馈轮次还会占 Session/Run 空间',
    stages: [
      ['固定程序', '解析命令；无任务正文的控制/查询命令交给 runtime-commands 和连接器。'],
      ['固定程序', '结果经 source-deliveries/outbox 送达飞书。'],
      ['条件模型调用', '静默/解除静默会提交一条不对外回复的反馈，不能把整条路径一概计为零模型调用。'],
    ],
    protocol: '飞书 WebSocket 事件 → 连接器本地命令 → RemoteLab HTTP 状态/投递 API → 飞书 OpenAPI。',
    measurement: '记录命令种类、API 往返、投递结果，以及是否创建反馈 Request/Run。',
    caveat: '不同命令语义不同；/quick、/thread、/sota 后有正文时会接纳任务。',
    nodes: ['feishu-ingress', 'quick-participation', 'outbox', 'request'],
    sources: [{ path: 'scripts/feishu-connector.mjs', line: 1600 }, { path: 'connectors/feishu/runtime-commands.mjs' }, { path: 'scripts/feishu-connector.mjs', line: 1484 }],
  },
  {
    id: 'daily-review', title: '收到每日项目审阅', visible: '用户在飞书看到摘要，并可打开当天文档；04:00/18:00 是启动时间，送达时间取决于这轮工作。',
    tags: ['审阅调用 Harness', '出版器是固定脚本'], model: '定时审阅 Session 会调用 Harness；固定出版脚本自身不需要模型', local: 'Schedule/Trigger 接纳、来源检查点、Markdown 与 Wiki 出版、回读和群投递由程序/脚本协作', storage: 'Trigger/Session/Run + 项目知识库 Git + 当日 Markdown/来源记录 + 飞书文档与投递回执',
    stages: [
      ['固定程序', 'Schedule 到点生成 Trigger 并接纳执行；不会自动读完所有项目来源。'],
      ['模型调用', '审阅 Harness 在实例规则限定的范围内读取讨论、项目主账和任务，形成判断并更新知识。'],
      ['固定脚本 + API', '出版器把已有 Markdown 更新到飞书 Wiki 并读回；飞书 API 使用应用授权凭据，和模型 token 是两类资源。'],
      ['固定程序', '飞书投递摘要、记录回执；文档存在和用户实际收到仍是不同验收点。'],
    ],
    protocol: '本机调度/文件/Git → Harness → 飞书 Docx/Wiki OpenAPI → 群消息投递。',
    measurement: '按 Trigger 统计模型 tokens、来源数量、运行时间、知识库 diff、文档 API/回读与投递回执。',
    caveat: '这是一条本实例配置的工作流；出版器脚本不是内容理解者。',
    nodes: ['automation', 'daily-review', 'project-knowledge', 'outbox'],
    sources: [{ path: 'chat/recurring-schedules.mjs', line: 742 }, { path: '实例工作流程 / project-review/publish_daily_report.mjs', instance: true }],
  },
  {
    id: 'memory-skill', title: '一次任务之后的记忆和 Skill 检查', visible: '用户可能在后续任务中感到系统记住了约定；这不是每次都直接显示出来的动作。',
    tags: ['条件后台模型 + 定时 Harness', '文件合并由程序处理'], model: '符合条件的轮后记忆审阅另启低成本模型；限次 Skill 检查是独立定时 Harness 任务', local: '目标选择、文件合并和候选日志写入由程序处理', storage: 'Session 状态/历史 + 记忆 Markdown + 候选审阅日志；不等于已进入生产 Skill',
    stages: [
      ['条件模型调用', '普通完成轮次若通过跳过条件，轮后审阅模型判断是否有可复用内容。'],
      ['固定程序', '解析结构化决定、校验目标并写入记忆文件。'],
      ['另一次模型调用（若调度触发）', 'Skill 候选审阅按实例计划运行，只生成候选和日志，不能当成自动修改活动 Skill。'],
      ['未来使用待验证', '下次任务需实际发现、读取并正确使用该条目，才能证明记忆生效。'],
    ],
    protocol: 'Run 结束回调 → detached Harness 审阅 → 本地 Markdown；定时 Schedule → 独立 Session。',
    measurement: '区分候选审阅次数、模型 tokens、实际写入条数、下次读取次数和有效复用；不能只统计文件大小。',
    caveat: '当前未证实独立 Dream 或自动语义遗忘实现。',
    nodes: ['memory-writeback', 'memory-index', 'skill-review', 'semantic-forgetting'],
    sources: [{ path: 'chat/session-manager.mjs', line: 1880 }, { path: 'chat/session-memory-writeback.mjs', line: 246 }, { path: 'chat/usage-ledger.mjs' }],
  },
];

export const resourceSnapshot = {
  label: '本实例单次快照', measuredAt,
  method: 'du -sB1 -L；计磁盘已分配空间，跟随这两处迁移后的符号链接。目录仍在变化，数值不是单次请求成本。',
  stores: [
    { label: 'Run 原始输出与结果', key: 'chat-runs/', bytes: 14181654528, volume: '数据盘', node: 'run' },
    { label: 'Session 事件历史', key: 'chat-history/', bytes: 9501999104, volume: '数据盘', node: 'history' },
    { label: '静态发布页面', key: 'public-pages/', bytes: 4049920000, volume: '系统盘', node: 'artifacts' },
    { label: '文件资产', key: 'file-assets/', bytes: 900435968, volume: '系统盘', node: 'artifacts' },
    { label: 'Request 状态', key: 'requests/', bytes: 163864576, volume: '系统盘', node: 'request' },
    { label: '飞书连接器（两处）', key: 'feishu-connector(s)/', bytes: 108285952, volume: '系统盘', node: 'feishu-ingress' },
    { label: '图片资产', key: 'images/', bytes: 43278336, volume: '系统盘', node: 'artifacts' },
    { label: '模型用量账本', key: 'usage-ledger/', bytes: 7208960, volume: '系统盘', node: 'usage-ledger' },
    { label: '长期记忆入口', key: 'memory/', bytes: 1277952, volume: '系统盘', node: 'memory-index' },
  ],
  ledger: {
    window: '2026-09-22 13:07 至 09-29 13:07 中国时间',
    runs: 1702, tokens: 7056715193, cachedInputShare: 0.98, backgroundShare: 0.07,
    note: '来自 RemoteLab usage ledger 的 7 日已记录 Run；含缓存输入，不等于实际账单，也不覆盖单独的 Jev 快速判断服务。',
  },
};

export const missingDimensions = [
  ['用户结果', '用户在哪个界面看到什么；失败时看到什么；是否真的打开文档或附件。'],
  ['分叉条件', '配置、@、话题绑定、静默、附件类型、重试与恢复会改变路径。'],
  ['工作类型', '固定程序、Harness 任务、轻量模型判断、后台模型审阅和人工决策分开记。'],
  ['协议与身份', '每一跳标明 HTTP、WebSocket、本机进程、文件或外部 OpenAPI；调用凭据与数据权限分开。'],
  ['资源账', '逐段量模型 token、外部 API 请求、CPU/时延、网络流量、文件增长和保留时间。'],
  ['故障证据', '每跳关联 requestId/runId/deliveryId 与外部回执，标明可重试和不可重复的副作用。'],
  ['收益证据', '把成本与用户真正节省的时间、正确率、干预次数和后续复用放在一起看。'],
];

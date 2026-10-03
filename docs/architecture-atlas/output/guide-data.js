export const meta = {
  version: 'v2 · 2026-10-03',
  status: '任务卡输出已实现；提问分级与接收确认前置仍待实施',
  mainCommit: '1dc8fbae612c54d624c75838ddc75ec8de67d9c8',
  pilotCommit: 'b95073aaa8e407249d0718e9c0530414b2b7d3c7',
  boundary: '源码与实例核对截止 2026-10-03。v2 已修正短问题被 Jev 否决任务卡的链路；本页把已实现输出与仍待改动的提问、接收确认分开展示；图中交互是演示，不会创建真实任务、发消息或执行工具。常规部署实例没有据此自动升级。',
};

export const references = {
  ingress: ['scripts/feishu-connector.mjs', 'connectors/feishu/session-flow.mjs'],
  admission: ['chat/session-manager.mjs', 'chat/requests.mjs'],
  runtime: ['chat/native-request-dispatch.mjs', 'chat/native-input-transport.mjs', 'docs/native-harness-input.md'],
  execution: ['chat/runner-sidecar.mjs', 'chat/run-launcher.mjs', 'chat/runs.mjs'],
  projection: ['lib/assistant-surface-messages.mjs', 'lib/workboard-state.mjs'],
  workboard: ['lib/workboard-state.mjs', 'connectors/feishu/workboard-pilot.mjs', 'scripts/feishu-workboard-pilot.mjs'],
  questions: ['chat/native-user-questions.mjs', 'chat/native-request-dispatch.mjs'],
  delivery: ['lib/reply-deliveries.mjs', 'chat/native-final-publication.mjs', 'docs/external-message-protocol.md'],
  jev: ['lib/jev-auto-router.mjs', 'scripts/feishu-connector.mjs'],
  background: ['chat/session-turn-completion.mjs', 'notes/current/thin-control-plane-architecture.md'],
};

export const nodes = {
  trial: { title: '网页 · 试验入口', owner: '网页适配器', role: 'surface', status: '已有入口', summary: '人员试验开关影响展示，不改变任务是否真的完成。', input: '用户文本、附件、所在 Session。', output: 'HTTP 接纳请求；读取原会话的历史与卡片。', stored: '共享 Session 历史；个人试验配置单独保存。', async: '浏览器断开不停止已接纳工作。重连读最新事实，不重发消息。', evidence: '试验卡按 Person / Session 启用；不是端口上所有用户都自动拥有。', refs: 'admission' },
  standard: { title: '网页 · 常规入口', owner: '网页适配器', role: 'surface', status: '已有入口', summary: '与试验入口共用接纳和运行底座，展示能力须分别部署与验收。', input: '原会话中的一次用户输入。', output: '规范化 Request 与原会话回复位置。', stored: 'Session、Request、Run 和规范化事件。', async: 'HTTP 返回接纳回执，不等待模型完成。WebSocket 只通知变化，HTTP 读取事实。', evidence: '主线源码、已部署版本和用户收到结果是三种证据。', refs: 'admission' },
  feishu: { title: '飞书 · 群与话题', owner: '飞书 Connector', role: 'surface', status: '已有入口', summary: '只处理已配置接入范围；无 @ 可被收录，是否承担工作另行判断。', input: '真人消息、来源事件、群或话题归属。', output: '耐久 inbox、规范化输入与原消息绑定。', stored: '消息去重键、发送者、来源和回复目的地。', async: '飞书事件接入、AI 工作、卡片投递独立运行。', evidence: '本次核对包含试验分支；普通群的触发配置不同。Bot 消息不当作新真人任务循环触发。', refs: 'ingress' },
  accept: { title: '可靠接收与去重', owner: 'RemoteLab 接入层', role: 'code', status: '底座已有', summary: '先可靠记录消息；相同输入沿用身份，不能靠重发制造第二份工作。', input: '来源消息标识、用户文本、附件引用。', output: '接纳回执、Request 身份及 Session 绑定。', stored: 'inbox / Request / Session 历史。', async: '接纳成功后不等待模型、清单或飞书发卡。', evidence: '目标：表情从这个已确认事件触发。现有 Jev 试验分支的表情仍在快判和提交之后。', refs: 'admission' },
  receipt: { title: '立即确认收到', owner: '入口确认器', role: 'code', status: '需前置', summary: '飞书给原消息加表情；网页确认已接收。这里只承诺收到。', input: '已经可靠收录的消息。', output: '收到表情或对应入口的接纳状态。', stored: '确认动作的去重记录与回执。', async: '不等待语义判定，不阻塞 AI 执行。失败可重试确认，不能重提工作。', evidence: '表情不能证明模型已理解、已接单或已执行。只收录讨论时可以止于此。', refs: 'ingress' },
  ackSurface: { title: '原消息收到状态', owner: '网页 / 飞书原消息', role: 'surface', status: '目标体验', summary: '先看到收到确认；主模型接单后才出现工作开场。', input: '可靠接收事实，以及稍后的真实工作判定。', output: '收到表情 / 接收状态；未判定时不显示已经开工。', stored: '接收回执与工作判定留在原会话。', async: '排队仍显示等待开始。只收录讨论时不生成开工消息或任务卡。', evidence: '仅有收到表情不证明 Agent 已接单。工作状态必须来自 Harness 与运行事实。', refs: 'ingress' },
  dispatch: { title: '会话与运行调度', owner: 'RemoteLab 核心', role: 'code', status: '底座已有', summary: '把输入交到正确会话。空闲启动；兼容的运行中输入交给原生通道。', input: 'Request、Session、选定 Harness 与运行配置。', output: '启动 Run、追加输入，或明确不兼容 / 需排队。', stored: '请求关联、Run manifest、原生输入接纳记录。', async: '已接纳不等于已消费；不确定的原生投递不能换新 Run 重放。内部维护操作保留串行边界。', evidence: 'Codex 原生使用 turn/steer；确定无活动 turn 才能退回 turn/start。超时不是确定拒绝。', refs: 'runtime' },
  harness: { title: '理解与执行', owner: '所选 Harness', role: 'model', status: '职责已有', summary: '决定是否接单、工作范围、第一步、长短任务、交付标准与验收。', input: '用户输入、上下文、已采用的补充、原生工具能力。', output: '有信息增量的开场、任务快照、进度、问题、正式结果。', stored: '原生线程与规范化事件；任务事实进入 Session 历史。', async: '原生控制循环处理新输入与工具结果。清单可以稍后形成，执行不等待卡片投递。', evidence: '不增加第二个隐藏 planner、回复 reviewer 或卡片生成模型。短任务可以直接给完整结果。', refs: 'execution' },
  tools: { title: '工具与外部系统', owner: 'Harness 调用的工具', role: 'external', status: '能力已有', summary: '完成查询、文件修改与外部动作；工具返回后才产生对应证据。', input: '当前已采用条件下的工具参数。', output: '结果、错误与可核对的回执。', stored: '工具事件及对应外部资源。', async: '长调用可以独立运行。新条件不保证改变已启动调用，停止也不能撤销已经发生的外部动作。', evidence: '进度由可观察结果支持，不能从工具开始推断工作已经完成。', refs: 'execution' },
  events: { title: '事件与任务记录', owner: 'RemoteLab 持久层', role: 'code', status: '需扩展快照', summary: '保存事实，再从同一份记录生成网页和飞书展示。', input: '规范化输出、带证据的验收项、用户输入与送达回执。', output: '稳定 taskId 的递增快照；可重建当前视图。', stored: 'Session 追加事件、workboard 快照与投递记录。', async: 'taskId 跨 Run 保持不变；revision 防止旧更新盖住新状态。', evidence: 'taskId 是 Session 内任务卡的投影身份，不新增全局任务系统。现有 schema 尚无独立 progress / waiting 区。', refs: 'workboard' },
  publish: { title: '输出投影与投递', owner: '网页投影 / 飞书 Worker', role: 'code', status: '输出已实现 / 交互卡待做', summary: '有内容的开场合入会话入口；进度编辑原卡；问题与最终答复独立。', input: '带明确输出意图的事件、任务版本和固定目的地。', output: '表面可读内容、卡片更新及外部回执。', stored: 'reply publication / outbox、卡片锚点、分片回执。', async: '慢网络与发卡失败不拖住模型。恢复按最新事实补投递，不重跑任务。', evidence: '已有任务卡时，进度写入卡内；无卡的简单回答直接交付。问题目前仍是文字，分级交互卡待做。', refs: 'delivery' },
  visible: { title: '用户可见结果', owner: '网页 / 飞书表面', role: 'surface', status: '目标体验', summary: '看到是否收到、是否开工、做到哪、是否等自己、结果是否送达。', input: '可公开展示的任务投影与正式结果。', output: '清楚区分进行中、待补充、暂停、完成、失败和取消。', stored: '展示不另造一份任务事实。', async: '离开页面后任务继续；恢复查看同一卡片与结果位置。', evidence: '工作完成与答复送达分别显示；停止执行不自动勾完交付项。', refs: 'projection' },
  background: { title: '后置整理与归集', owner: '独立后台支路', role: 'code', status: '已有独立支路', summary: '维护会话标题、工作摘要及有条件的长期记忆归集。', input: '已结束轮次的历史和可复用信息。', output: 'Session 元数据及符合条件的归集记录。', stored: 'workSummary 与记忆相关记录。', async: '与正式答案投递独立；用户不为元数据整理等待。', evidence: '分类器不是任务验收者，不改写答案，也不负责生成这张任务卡。记忆细节见既有记忆架构说明。', refs: 'background' },
  jev: { title: 'Jev 快速判定', owner: '试验快速模型', role: 'model', status: '现状分支', summary: '当前仍选表情和工作位置，另有独立 Auto 选档位；已不再判定任务卡。', input: '群消息、上下文和对应配置。', output: '反应 / 路由判定，或独立 Auto 模型档位。', stored: '判定与相关运行记录。', async: '现有试验流程先等待快判，再提交工作并排表情；目标输出主线移除这段等待。', evidence: '这些是按配置启用的不同用途。当前群试验还有 fail-open 提交策略；不能从源码断言所有入口都开了这些功能。Auto 单独评估。', refs: 'jev' },
  gate: { title: 'Harness 判断是否建卡', owner: '当前执行 Harness', role: 'model', status: '已实现', summary: '每个已启用的工作输入均带任务卡规则，按实际工作量决定；短问题也可能要调查。', input: '用户输入、已有事实、实际需要的工作。', output: '短答直接交付；复杂工作生成可验收任务卡。', stored: 'Session 中的任务快照；旧 Jev 判定只作历史。', async: '没有额外清单模型调用；工作变长时在进一步进度前建卡。', evidence: '原来的短文本 Jev gate 已退出任务卡入口；每个新任务仍保持稳定身份。', refs: 'workboard' },
  currentSurface: { title: '现行文本与清单', owner: '现行输出投影', role: 'code', status: '现状已核', summary: '有效开场包含会话入口；任务卡含当前进度与验收状态；最终答复独立。', input: 'commentary、progress 标记、user_question、final 与 workboard。', output: '开场、原卡进度、普通问题文字、验收状态和最终答复。', stored: '原始事件保留；表面按规则筛选。', async: '飞书开场标开始处理，问题标待你回复；执行停止后标最终答复。任务完成由验收事实决定。', evidence: '普通选择题默认五分钟：有选项选第一项，无选项返回未答；没有偏好 / 关键输入等级。现有这些标签不等于任务成功。', refs: 'projection' },
};

const n = (ref, x, y, w = 176, h = 98) => ({ ref, x, y, w, h });
export const overviewGraphs = {
  target: {
    label: '目标架构', height: 760, defaultNode: 'harness',
    intro: '三条异步路径：接收确认尽快返回；Harness 独立推进工作；输出 Worker 从持久事件更新表面。点击节点查看职责与依据。',
    lanes: [{x:14,w:196,label:'用户入口'},{x:235,w:430,label:'RemoteLab · 持久与调度'},{x:687,w:196,label:'原生 Harness'},{x:910,w:196,label:'用户可见输出'}],
    nodes: [n('trial',24,111),n('standard',24,228),n('feishu',24,345),n('accept',251,200),n('receipt',251,427),n('ackSurface',24,621),n('dispatch',476,200),n('harness',697,200),n('tools',697,385),n('events',476,427),n('publish',920,427),n('visible',920,621),n('background',476,621)],
    edges: [
      {from:'trial',to:'accept',points:[[200,160],[224,160],[224,236],[251,236]]},
      {from:'standard',to:'accept',points:[[200,277],[224,277],[224,260],[251,260]]},
      {from:'feishu',to:'accept',points:[[200,394],[224,394],[224,284],[251,284]]},
      {from:'accept',to:'dispatch',points:[[427,249],[476,249]],label:'接纳',at:[450,235]},
      {from:'accept',to:'receipt',points:[[339,298],[339,427]],label:'不等模型',at:[384,363],async:true},
      {from:'receipt',to:'ackSurface',points:[[339,525],[339,565],[112,565],[112,621]],label:'原消息快速确认',at:[144,589],async:true},
      {from:'dispatch',to:'harness',points:[[652,249],[697,249]],label:'原生输入',at:[675,235]},
      {from:'harness',to:'tools',points:[[813,298],[813,385]],label:'调用',at:[839,344]},
      {from:'tools',to:'harness',points:[[758,385],[758,298]],label:'结果',at:[732,345],async:true},
      {from:'harness',to:'events',points:[[717,298],[717,352],[564,352],[564,427]],label:'接单后：开场 / 进度 / 问题 / 结果',at:[580,335],async:true},
      {from:'events',to:'publish',points:[[652,505],[880,505],[880,475],[920,475]],label:'按事件投影',at:[767,523],async:true},
      {from:'publish',to:'visible',points:[[1008,525],[1008,621]],label:'发一次 / 编辑原卡',at:[1008,582],async:true},
      {from:'visible',to:'events',points:[[945,621],[945,565],[610,565],[610,525]],label:'实际送达回执',at:[787,552],async:true},
      {from:'events',to:'background',points:[[564,525],[564,621]],label:'独立支路',at:[519,585],async:true},
    ],
  },
  current: {
    label: '现行飞书试验分支', height: 700, defaultNode: 'jev',
    intro: '这里只展开已核对的 Jev 群试验分支。常规群配置与 Auto 选择按配置生效；任务卡由已启用的主 Harness 判断；不能当作所有入口的统一流程。',
    lanes: [],
    nodes: [n('feishu',24,114),n('accept',251,114),n('jev',476,114),n('dispatch',697,114),n('harness',920,114),n('receipt',476,322),n('gate',697,322),n('events',697,530),n('currentSurface',920,530)],
    edges: [
      {from:'feishu',to:'accept',points:[[200,163],[251,163]]},
      {from:'accept',to:'jev',points:[[427,163],[476,163]],label:'先等待快判',at:[452,146]},
      {from:'jev',to:'dispatch',points:[[652,163],[697,163]]},
      {from:'dispatch',to:'harness',points:[[873,163],[920,163]],label:'初始化后启动',at:[898,146]},
      {from:'dispatch',to:'receipt',points:[[710,212],[710,263],[564,263],[564,322]],label:'提交成功后排表情',at:[564,285],async:true},
      {from:'dispatch',to:'gate',points:[[760,212],[760,322]],label:'任务卡规则',at:[734,294],async:true},
      {from:'gate',to:'dispatch',points:[[820,322],[820,212]],label:'判定返回',at:[853,286],async:true},
      {from:'harness',to:'events',points:[[1008,212],[1109,212],[1109,490],[785,490],[785,530]],label:'原生输出 → 规范化事件',at:[956,475],async:true},
      {from:'events',to:'currentSurface',points:[[873,579],[920,579]],async:true},
    ],
  },
};

export const actors = [
  {id:'user',label:'用户',owner:'消息与反馈'}, {id:'inbox',label:'接入 / 调度',owner:'RemoteLab'},
  {id:'harness',label:'执行',owner:'原生 Harness'}, {id:'store',label:'持久事件',owner:'RemoteLab'},
  {id:'worker',label:'输出 Worker',owner:'网页 / 飞书'},
];
export const sequences = {
  long: {label:'长任务',lead:'时间线表示先后与独立承接，不表示固定秒数。发卡与投递不会成为模型开工的前置条件。',steps:[
    ['user','inbox','消息到达','真人输入进入已配置入口'],
    ['inbox','store','可靠记录 + 去重','同一输入只接纳一次'],
    ['inbox','user','收到确认','飞书表情 / 网页已收到；不等模型'],
    ['inbox','harness','启动或续接原生运行','返回接纳身份，执行脱离网页连接'],
    ['harness','store','开场：有依据的判断与第一步','主模型写内容；不套固定寒暄'],
    ['store','worker','开场待投递','确定原会话或唯一工作话题'],
    ['worker','user','短开场 + 工作位置','开场不等待完整交付清单'],
    ['harness','store','任务快照 + 继续执行','目标、2–5 交付项；清单只是展示投影'],
    ['store','worker','创建或更新原任务卡','保存卡片锚点和任务版本'],
    ['harness','store','有证据的进度变化','工具返回、关键发现、步骤变化或阻塞'],
    ['store','worker','编辑进度区','合并可读增量；不逐句新增消息'],
    ['harness','store','验收与正式结果提交','证据支持完成程度；不由 Run 终止猜完成'],
    ['store','worker','结果进入独立投递','工作已完成，答复待送达'],
    ['worker','user','正式结果 / 附件','保留明确结果标识与完成程度'],
    ['worker','store','提供方确认回执','全部结果部分确认后才显示已送达'],
  ]},
  short: {label:'快速完整答复',lead:'收到确认之后直接完成并交付；不为开场或任务卡制造额外等待。若卡片尚在准备，终态会阻止迟到创建。',steps:[
    ['user','inbox','消息到达','原会话接纳输入'],['inbox','store','可靠记录与去重','保存来源与回复位置'],
    ['inbox','user','收到确认','不等待模型判断'],['inbox','harness','原生执行','主模型形成完整答案'],
    ['harness','store','正式结果','无需另交清单和开场'],['store','worker','独立投递','取消未发出的迟到卡片'],
    ['worker','user','完整答案','原位置直接回答'],['worker','store','送达回执','任务与投递均有可核对状态'],
  ]},
  waiting: {label:'缺关键输入',lead:'关键问题没有安全默认。完成独立部分后释放当前执行，待答任务与问题持久保留；回复触发同一任务的续作。',steps:[
    ['user','inbox','原任务输入','消息已接纳'],['inbox','harness','执行现有部分','先完成不依赖用户回答的工作'],
    ['harness','store','必要问题 + 等待范围','主模型说明缺什么、为什么、阻塞哪项'],
    ['store','worker','保存待答问题并投影','问题归属 taskId / questionId / 对象 / 版本'],
    ['worker','user','单独交互卡','主卡显示等待补充，已有结果保留'],
    ['harness','store','结束本次执行，任务仍等待','不自动首选，不维持空转 Run'],
    ['user','inbox','用户稍后回答','可以在断线或本次执行结束后返回'],
    ['inbox','store','校验问题与版本','过期问题不直接应用到新要求'],
    ['inbox','harness','续接同一任务','新执行消费答案，不是另造任务卡'],
    ['harness','store','原卡更新 + 继续验收','等待解除，交付项依新证据推进'],
  ]},
  deliveryFailure: {label:'结果发送失败',lead:'工作与交付分开：投递失败只补投递。结果已产生，不再启动模型重复工具和外部动作。',steps:[
    ['harness','store','验证完成 + 结果保存','工作已完成，有可恢复的结果与资产'],
    ['store','worker','结果待发送','沿用稳定 publication / 分片身份'],
    ['worker','store','发送失败或状态不确定','记失败原因；不确定时先读回，不盲目重发'],
    ['store','worker','恢复补投递','只重试需要的结果部分，不重跑任务'],
    ['worker','user','正式结果送达','用户获得原结果'],
    ['worker','store','读回并确认回执','全部部分确认，主卡再显示答复已送达'],
  ]},
};

export const feedbackGraph = {
  height: 760,
  nodes: [
    {id:'input',x:465,y:24,w:210,h:85,title:'原任务中收到新输入',sub:'可靠记录，保留来源与顺序'},
    {id:'explicitStop',x:35,y:175,w:230,h:104,title:'明确的停止控制',sub:'停止按钮 / 已确认的停止命令',tone:'stop'},
    {id:'boundAnswer',x:365,y:175,w:250,h:104,title:'绑定问题的回答',sub:'交互卡按钮 / 明确回复该问题'},
    {id:'freeInput',x:775,y:175,w:275,h:104,title:'其他自由文本',sub:'先送入原生会话，再由主 Harness 理解'},
    {id:'stop',x:35,y:365,w:230,h:107,title:'原生中断与状态回执',sub:'停止中 → 已停止；暂停保留续作',tone:'stop'},
    {id:'answer',x:365,y:365,w:250,h:107,title:'核对对象、题号、版本',sub:'有效答案接回原任务；旧题不串答'},
    {id:'question',x:695,y:365,w:180,h:107,title:'插问 / 查进度',sub:'直接回答；原任务继续'},
    {id:'supplement',x:910,y:365,w:180,h:107,title:'补充 / 纠正',sub:'采纳后改步骤；必要时重验'},
    {id:'independent',x:695,y:610,w:180,h:107,title:'新的独立目标',sub:'独立工作位置；说明原任务安排'},
    {id:'continue',x:320,y:610,w:280,h:107,title:'原卡继续更新',sub:'同一目标、同一 taskId；收到 ≠ 已采纳'},
  ],
  edges: [
    {from:'input',to:'explicitStop',points:[[465,65],[150,65],[150,175]]},
    {from:'input',to:'boundAnswer',points:[[550,109],[550,145],[490,145],[490,175]]},
    {from:'input',to:'freeInput',points:[[675,65],[912,65],[912,175]]},
    {from:'explicitStop',to:'stop',points:[[150,279],[150,365]],label:'优先停止',at:[150,332]},
    {from:'boundAnswer',to:'answer',points:[[490,279],[490,365]],label:'结构化校验',at:[490,332]},
    {from:'freeInput',to:'question',points:[[848,279],[848,320],[785,320],[785,365]]},
    {from:'freeInput',to:'supplement',points:[[975,279],[1000,279],[1000,365]]},
    {from:'freeInput',to:'independent',points:[[1050,227],[1107,227],[1107,559],[785,559],[785,610]],async:true},
    {from:'answer',to:'continue',points:[[490,472],[490,610]],async:true},
    {from:'question',to:'continue',points:[[695,421],[658,421],[658,535],[570,535],[570,610]],async:true},
    {from:'supplement',to:'continue',points:[[1000,472],[1000,578],[535,578],[535,610]],async:true},
  ],
};

export const feedbackDetails = {
  input: '用户消息先可靠记录。已接收、已投递原生通道、主模型实际采用是不同事件。重试沿用输入身份；收不到原生 ACK 时不制造第二次执行。',
  explicitStop: '有明确控制意图的停止先于答案路由。自然语言仍由原生 Harness 识别；平台不另开隐藏分类模型。待答时的“停止”不能被吞成自由文本答案。',
  boundAnswer: '交互卡按钮自带任务、问题、提问对象与版本。自由文本只有明确回答对应问题才进入答案路径；其他人的回复先判断适用性。',
  freeInput: '运行兼容时使用 turn/steer 等原生输入通道。没有活动运行时续接原会话。主 Harness 决定它是插问、补充、纠正还是独立目标，RemoteLab 不做第二次任务规划。',
  stop: '先显示停止中，原生确认后显示已停止。取消使任务终止；暂停保留原卡与上下文，等待明确继续。不能承诺撤销已发生外部动作。',
  answer: '必要问题不能超时自动选第一项。当前 Run 可以结束，待答事项仍保存在任务记录；用户回答后续作原任务。题目已被新要求替代时，旧答案不会直接生效。',
  question: '用户主动问“做到哪了”应得到直接答复；任务继续。相关插问尽快回答，必要时改变步骤。这个回答不自动成为最终交付，也不勾完交付项。',
  supplement: '先确认收到，实际采用后说明改了什么。纠正影响交付标准时记录范围变化理由，并重新验收受影响项目。正在跑的工具不保证立即使用新条件。',
  independent: '真正独立的工作目标可以拥有新的用户可见工作位置。短插问不需要独立任务；优先级或替换目标要说明原任务是继续、暂停还是取消。',
  continue: '同一任务跨执行延续，更新原卡。新输入在正式交付前使结论失效时先校验；正式交付后的反馈以续作和修订呈现，保留原结果历史。',
};

export const questionLevels = [
  {id:'optional',label:'可选偏好',example:'呈现方式有合理默认',behavior:'能不问就说明假设继续；确需询问时明确默认与采用期限。独立工作继续，默认五分钟后用已告知选项。',silence:'系统默认，非用户回答',tone:'neutral'},
  {id:'required',label:'必要补充',example:'缺关键参数，无法可靠完成',behavior:'说明缺什么、影响哪项。受影响部分等待，其他部分继续；独立工作结束后释放本次执行，保留待答任务。',silence:'等待回答；不自动首选',tone:'amber'},
  {id:'authorization',label:'明确确认',example:'确实超出当前授权的具体动作',behavior:'列明动作与影响，只等待必要决定。已有授权的日常工作不重复求确认。',silence:'没有同意就不执行该动作',tone:'amber'},
];

export const states = [
  {id:'task',label:'任务 / 工作卡',owner:'Harness 给出验收事实，平台保存',states:['进行中','等待补充 / 用户暂停','进行中','已完成 / 部分完成 / 失败 / 取消'],meaning:'同一任务可以跨多个 Run。现有 workboard.status 保留；拟增加 waiting.kind 区分必要输入与用户暂停，不能仅由 Run 终态宣布完成。'},
  {id:'run',label:'一次执行 Run',owner:'原生 Harness 与运行宿主',states:['已接纳','运行中','执行终态','按新输入续接下一次执行'],meaning:'已接纳不等于正在执行；结束本次执行可以留下待答任务。停止确认和任务取消分别记录。'},
  {id:'delivery',label:'结果投递',owner:'publication / outbox Worker',states:['尚无正式结果','结果待发送','发送中 / 失败待恢复','回执确认已送达'],meaning:'工作完成不等于答复送达。发卡、答案、附件和分片须有各自回执；不确定发送先读回。'},
];

const items = (a,b,c) => [{title:'核清现有机制',status:a},{title:'确定交互与续作规则',status:b},{title:'交付可评审架构',status:c}];
export const simulations = {
  observation: {label:'只收录讨论',frames:[
    {label:'可靠收录',reaction:'已收到',run:'待原生判断',status:'已收到，尚未接单',note:'无 @ 的接入范围内真人消息先确认收到；这不是已经开工。'},
    {label:'没有工作任务',reaction:'已收到',run:'已结束，仅收录',status:'仅收录讨论',note:'消息进入讨论上下文，但主 Harness 没有承担新任务。不生成开工、任务卡或虚假的结果交付。'},
  ]},
  long: {label:'长任务推进',frames:[
    {label:'可靠接收',reaction:'已收到',run:'尚未启动',status:'已接收，等待开始',note:'只有接收确认，不生成“已理解 / 已开工”的假承诺。'},
    {label:'形成有效开场',reaction:'已收到',run:'运行中',status:'进行中',opening:'现有链路把执行停止标成“交付”，普通进度又分散在新消息里。我先拆开任务、执行和投递三种状态，确定各入口要改哪里。',note:'开场来自已核对的具体问题和处理判断；同时作为唯一工作话题入口。'},
    {label:'清单稍后出现',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','running','pending'),progress:'已核清现行投影与五分钟提问规则；当前在区分偏好、必要补充和明确确认。',note:'执行继续，不等待卡片发出。标题是目标，交付项与实际进度分开。'},
    {label:'更新实际进度',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','done','running'),progress:'已明确关键问题不能自动首选；当前核对“等待回答时收到停止”这条分支。下一步：检查结果投递失败的恢复。',note:'编辑同一张卡的进度区，不新增三条进度消息。'},
    {label:'工作完成，待投递',reaction:'已收到',run:'已结束',status:'工作完成',delivery:'答复待送达',card:true,items:items('done','done','done'),progress:'职责、异步时序和用户反馈分支已完成评审。正式结果及附件已进入投递。',note:'交付项完成要有实际验证依据；尚未收到投递回执。'},
    {label:'正式结果送达',reaction:'已收到',run:'已结束',status:'已完成',delivery:'答复已送达',card:true,items:items('done','done','done'),progress:'全部交付项已验收；正式答复已送达。',result:'【结果：已完成】三条职责与异步路径已明确，关键输入待答和停止优先规则已列入改动范围。',note:'结果是独立消息；卡片能返回结果位置。这个示例的“完成”指规划交付，不是机制已经部署。'},
  ]},
  short: {label:'快速答完',frames:[
    {label:'收到',reaction:'已收到',run:'开始执行',status:'进行中',note:'简单任务不为展示流程额外生成开场和卡片。'},
    {label:'直接完整答复',reaction:'已收到',run:'已结束',status:'已完成',delivery:'答复已送达',result:'【结果：已完成】这条问题已有完整答案，直接在原消息位置回复。',note:'阻止尚未发出的迟到卡片；不能结果之后再补“我开始处理”。'},
  ]},
  waiting: {label:'必要补充未答',frames:[
    {label:'只推进独立部分',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','running','pending'),progress:'已完成可独立核对的部分；余下项缺少关键参数。'},
    {label:'单独交互卡',reaction:'已收到',run:'可结束本次执行',status:'等待你补充',card:true,items:items('done','pending','pending'),progress:'受影响的交付项等待关键参数；其他可独立工作已完成。',question:{level:'必要补充',text:'请提供实际要处理的目标资源，余下操作需要据此确定范围。',silence:'不回答不会自动选择；该部分保持等待。'},note:'只在确实无法可靠完成时问。待答问题与原任务持久关联，不让 Run 空等。'},
    {label:'五分钟后仍未回复',reaction:'已收到',run:'已结束',status:'等待你补充',card:true,items:items('done','pending','pending'),progress:'仍缺同一项关键输入，未执行依赖该输入的动作；已有结果保留。',question:{level:'必要补充',text:'目标资源待补充',silence:'仍然待答；没有默认选择。'},note:'没有回答不会变成“用户已选择”，也不会变成任务已完成。'},
    {label:'稍后回答，原卡续作',reaction:'已收到',run:'续接执行',status:'进行中',card:true,items:items('done','running','pending'),progress:'已收到并采用你补充的目标；当前继续核对受影响部分。',note:'问题版本核对后消费答案，沿用原 taskId。'},
  ]},
  feedback: {label:'用户插问 / 纠正',frames:[
    {label:'原任务运行',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','running','pending'),progress:'正在核对群内回复与工作话题的对应关系。'},
    {label:'用户问进度',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','running','pending'),progress:'仍在核对回复位置，原任务继续。',reply:'已经核清接收与启动，当前在核对工作话题的绑定；正式结果还没完成。',note:'直接回答用户主动提问；这条答复不被当作正式交付，不结束任务。'},
    {label:'补充先被收录',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','running','pending'),progress:'补充已收到并送入原生输入通道；等待主模型采用，已启动工具仍按原参数运行。',note:'可靠接收和实际采用分别显示。'},
    {label:'纠正实际生效',reaction:'已收到',run:'运行中',status:'进行中',card:true,items:items('done','running','pending'),progress:'已采用“沿用现有工作话题”的要求，取消新开话题的后续步骤；受影响的规则重新验收。',note:'主模型说明具体影响；范围变化保留理由和修订记录。'},
  ]},
  stop: {label:'待答时停止',frames:[
    {label:'有待答问题',reaction:'已收到',run:'运行中',status:'等待你补充',card:true,items:items('done','pending','pending'),progress:'正在等关键条件。',question:{level:'必要补充',text:'目标范围需要补充',silence:'不会自动首选。'}},
    {label:'收到停止',reaction:'已收到',run:'停止中',status:'停止中',card:true,items:items('done','pending','pending'),progress:'已请求原生停止，等待确认；待答问题停止接收旧选择。',note:'“停止”走停止路径，不吞成问题的自由文本答案。'},
    {label:'原生确认停止',reaction:'已收到',run:'已停止',status:'已取消',card:true,items:items('done','cancelled','cancelled'),progress:'原生执行已停止，已完成部分保留；没有把余下交付项勾成完成。',result:'【结果：已取消】已停止继续推进。此前完成的结果保留；已发生的外部动作仍按实际回执记录。',note:'取消不自行恢复。暂停则保留待继续状态，用户明确继续后沿用原卡。'},
  ]},
  failure: {label:'答复发送失败',frames:[
    {label:'工作已完成',reaction:'已收到',run:'已结束',status:'工作完成',delivery:'答复待送达',card:true,items:items('done','done','done'),progress:'验收完成，结果已保存。'},
    {label:'发送失败',reaction:'已收到',run:'已结束',status:'工作完成',delivery:'答复发送失败',card:true,items:items('done','done','done'),progress:'结果发送未成功；投递器正在恢复，不重新运行任务。',note:'不确定是否发出时先读回；失败和未知不能简单地重复发送。'},
    {label:'补投递后确认',reaction:'已收到',run:'已结束',status:'已完成',delivery:'答复已送达',card:true,items:items('done','done','done'),progress:'原结果已补投递并确认送达。',result:'【结果：已完成】原来已经验收的结果已送达；没有重复执行工具。'},
  ]},
};

export const openings = {
  weak: '收到，我会核对试验端口、常规端口和飞书群，先对照源码，进展和结果放在这里。',
  useful: '现有链路把执行停止标成“交付”，普通进度又分散在新消息里。我先拆开任务、执行和投递三种状态，确定各入口要改哪里。',
  rule: '主模型基于本轮已有事实，写出具体判断、关键分叉或首步为何能缩小不确定性。没有核实的发现不伪装成事实；快速完整答案直接交付。开场只承担有用增量，接收表情承担即时确认。',
};

export const rollout = [
  {id:'receipt',status:'开场已实现，接收确认前置待做',title:'接收与开场',owner:'接入层 + Harness + 输出适配器',now:'Jev 试验分支先快判再提交，表情排在之后；会话入口已合入有内容的开场，无固定创建通知。',change:'可靠收录后前置确认；主模型给有依据的开场；群内开场同时作为唯一工作话题入口。',acceptance:'无 @ 的接入消息能确认收到；未接单不假报开工；快速答案不会被迟到开场和卡片打断。'},
  {id:'progress',status:'代码已实现，真人新任务待验',title:'一张任务卡承载进度',owner:'Harness 写事实；持久层与 Web / 飞书投影',now:'卡片有目标、验收项和总体状态；进度区已实现，同一任务更新原卡；长短任务已改由执行 Harness 判断。',change:'扩展 progress 与 waiting；标题用目标；按真实变化更新原卡，保留必要历史。',acceptance:'同一 taskId 跨 Run 仍是一张卡；普通进度不产生新消息；重连恢复最新版本，不重发旧历史。'},
  {id:'interaction',title:'分级问题与续作',owner:'Harness 定等级；问题 Broker 保存与路由',now:'普通有选项提问五分钟后默认首项；必要性没有单独字段，表面仍是问题文字。',change:'交互卡注明级别、未答政策、影响范围与对象；必要问题持久待答，不超时强选。',acceptance:'必要补充无回复保持等待；可选题的默认标记非用户回答；跨 Run 的迟到答案正确接回原任务。'},
  {id:'input',title:'停止、插问、补充与纠正',owner:'原生输入通道 + Harness + 结构化控制',now:'已有原生追加输入和停止底座；存在待答问题时把新文字作为候选答案的路径。',change:'停止控制优先，答案绑定具体问题；自由文本交给 Harness 分类处理，实际采用后写进度。',acceptance:'待答时说停止不被吞成答案；插问不结束任务；纠正影响的标准重新验收，收到与采用可区分。'},
  {id:'publication',status:'输出已实现，续作竞态持续验收',title:'完成与送达分别展示',owner:'Harness 验收 + publication / outbox Worker',now:'已有独立投递与回执底座；开场、问题和最终答复分别标识；最终答复不宣称任务完成，结束后不补发新卡。',change:'明确正式结果输出意图和完成程度；卡片同步工作状态与答复状态，竞态中阻止迟到创建与过期结论。',acceptance:'Run 结束不自动宣布成功；发送失败只补投递；结果前有新纠正先校验，结果后续作有修订记录。'},
];

export const contracts = [
  {name:'message.received',writer:'接入层',fact:'消息已可靠记录与去重',consumer:'接收确认器 / 会话调度',status:'事件名为规划，不是现行 API'},
  {name:'input.accepted / input.applied',writer:'原生桥接 / Harness',fact:'通道已接纳 / 主模型已采用，分别记录',consumer:'运行观测 / 进度区',status:'已有接纳底座；采用展示待补'},
  {name:'assistant.opening',writer:'主 Harness',fact:'有信息增量的判断、第一步与输出归属',consumer:'开场投影 / 工作话题入口',status:'内容职责与合并规则待落地'},
  {name:'task.snapshot',writer:'Harness 提交；平台结构校验',fact:'taskId、revision、goal、items、progress、waiting',consumer:'Web / 飞书原卡投影',status:'拟扩展现有 workboard 快照'},
  {name:'question.opened / answered',writer:'Harness 定义；问题 Broker 存储',fact:'questionId、等级、对象、任务版本、未答政策及回答来源',consumer:'交互卡 / 当前或下一次原生执行',status:'分级与持久待答待补'},
  {name:'result.committed / delivery.confirmed',writer:'Harness 验收 / 投递 Worker',fact:'正式结果与完成程度 / 提供方确认的回执',consumer:'结果消息 / 卡片答复状态',status:'复用现有出版与投递底座'},
];

export const invariants = [
  '接收确认不等待模型；收到不冒充已理解或已开工。',
  '主 Harness 是唯一任务理解与验收者；不增加隐藏 planner 或独立卡片模型。',
  '同一任务在 Session 中保留稳定身份；Task 卡是投影，不另造全局任务产品。',
  '普通自动进度更新原卡；用户主动提问仍直接得到回答。',
  '必要输入与真实授权不会因无人回答而默认同意。',
  'Run 结束、任务完成、结果送达分别有证据；互不替代。',
  '原生输入或外部发送结果不确定时先核对，不靠重复执行消除不确定。',
];

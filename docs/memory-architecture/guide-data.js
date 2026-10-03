// Human-readable reference and interactive page share this content source.
export const guide = {
  version: '1.0', verifiedAt: '2026-10-03', auditedCommit: 'd19adfa1', mainBaseline: 'a3c33eec',
  title: 'RemoteLab 如何记住、理解与协作',
  goal: '让 Agent 在多人、多项目、多信源的工作中形成可追溯、经相应职责认可的组织认识；从同一份认识生成项目与个人视图，持续发现进展、风险和值得复用的方法。',
  boundary: '本页解释已经核实的读取与写回机制，并展示尚未实施的治理方案。图的连线表达读取、归集或派生关系；不表示每一轮都运行全部步骤。',
  findings: [
    ['入口与读取不同', 'RemoteLab 在新原生线程提供记忆位置；Harness 决定本次需要读哪些正文。继续同一线程时，启动指针不会整包重新注入。'],
    ['实例与个人不同', '本地 user memory 默认按机器或实例共用。Person 已保存部分产品设置与个人 Session 排列；协作偏好还缺逐人来源、适用范围和确认记录。'],
    ['候选与共识不同', '自动提炼可以提供线索。候选有来源后还要核对适用范围、状态与确认职责，才能进入有效共识。']
  ],
  scenarios: {
    fresh: { label: '新线程首次开工', active: ['message','startup','turn','harness','library','proof','archive'], defaultNode: 'startup', summary: '自动提供：启动指针、适用的本轮来源与约定。按需读取：项目索引、偏好、任务、Skill 和证据。第一次开工也没有强制全盘检索。' },
    resume: { label: '同线程继续', active: ['message','native','turn','harness','library','proof','archive'], defaultNode: 'native', summary: '复用原生线程的已有上下文；本轮来源和适用约定继续投影。文件已更新不代表旧上下文自动消失；涉及当前状态仍要查证。' },
    rebuild: { label: '换 Harness／重建线程', active: ['message','startup','continuation','turn','harness','library','proof','archive'], defaultNode: 'continuation', summary: '重建启动指针，并在有可用历史时提供有界延续。RemoteLab 保留归一化历史；原生 Harness 没有返回的隐藏上下文不能被完整重建。' }
  },
  startGraph: {
    height: 510,
    nodes: [
      { id:'message', x:20,y:206, title:'当前请求', subtitle:'谁说了什么，要做什么', tag:'本轮输入', text:'人的请求、附件和连接器来源分别保存。以本次目标为检索起点；群内一般讨论不自动构成执行授权。', refs:['source','prompt'] },
      { id:'startup', x:264,y:20, title:'启动指针', subtitle:'bootstrap · projects · skills', tag:'新线程自动提供', text:'system-prompt 提供路径与能力目录，并检查入口是否存在，不读取记忆正文。bootstrap 是小导航；projects 是领域路由；skills 是方法入口；共享 system.md 同样按需读。', paths:['~/.remotelab/memory/bootstrap.md','~/.remotelab/memory/projects.md','~/.remotelab/memory/skills.md','memory/system.md'], refs:['startup','prompt'] },
      { id:'native', x:264,y:144, title:'原生线程延续', subtitle:'Codex／Claude／Pi 的上下文', tag:'继续线程时复用', text:'RemoteLab 保存原生 resume 标识。Harness 负责自己的上下文管理与原生记忆。RemoteLab 的 Context 记录只能证明平台传了什么，不能证明 Harness 看见的全部内容。', refs:['prompt','thin'] },
      { id:'continuation', x:264,y:268, title:'有界历史交接', subtitle:'归一化历史 · 既有延续头', tag:'重建时有条件提供', text:'没有可复用原生线程时，从可用历史或既有延续记录构造有界交接。workSummary 已存入会话元数据，但当前普通每轮前台不重新注入该短摘要。', paths:['实例配置/chat-history/<session>/','Session.workSummary'], refs:['continuation','control','prompt'] },
      { id:'turn', x:264,y:392, title:'本轮来源与约定', subtitle:'来源快照 · 适用 Session 约定', tag:'本轮自动投影', text:'投影当前 Request 的来源信息、连接器上下文、显式 Session 约定和可用本地桥接状态。具体内容取决于来源与配置；没有这些内容时不会凭空补齐。', refs:['turn','source'] },
      { id:'harness', x:508,y:206, title:'Harness 解释任务', subtitle:'选择相关记忆与操作方法', tag:'任务执行主体', text:'选择读什么、怎样计划、如何用工具和验证结果，由当前 Harness 负责。治理测试层不能成为所有普通任务必须经过的第二个规划器。', refs:['thin'] },
      { id:'library', x:752,y:50, title:'按需检索知识', subtitle:'领域 · 偏好 · 任务 · Skill', tag:'相关时读取', text:'从索引进入相关文档或章节，再按需要查原始来源。项目主账与用户目录 projects.md 名字相似、职责不同。历史旁观信息和个人局部偏好不应升级成全局指令。', paths:['reference/current/','reference/topics/','model-context/preferences.md','tasks/','项目文档与 Skills','project-knowledge/projects.md'], refs:['activation','targets'] },
      { id:'proof', x:752,y:206, title:'查当前业务证据', subtitle:'任务 · 作业 · 结果 · 验收', tag:'状态问题需核对', text:'任务系统保存行动状态，训练或评测系统保存运行与结果。报告称完成、文件存在、任务卡完成和验收通过分别记录。没有日志不等于没有工作。', refs:['daily','thin'] },
      { id:'archive', x:752,y:362, title:'追溯历史依据', subtitle:'原文 · 历史版本 · archive', tag:'需要追溯才读', text:'保留旧方案和失败依据，帮助解释变化。旧事实带日期与被替代关系，不作为当前默认规则。检索到一段话还要判断它适用于谁、何时、什么工作。', refs:['activation'] }
    ],
    edges: [['message','startup'],['message','native'],['message','continuation'],['message','turn'],['startup','harness'],['native','harness'],['continuation','harness'],['turn','harness'],['harness','library','按需'],['harness','proof','查证'],['harness','archive','追溯']]
  },
  collectGraphs: {
    current: { label:'目前的归集', intro:'目前存在几条独立链路：会话组织、自动候选提炼、项目审阅与日报。它们尚未统一为逐条来源、版本和职责确认的组织认知层。', height:510,
      nodes:[
        {id:'result',x:20,y:88,title:'本轮完成',subtitle:'用户内容与助手结果',tag:'已运行',text:'正常轮次完成后触发后台处理。会话摘要、自动记忆评审、业务任务验收的目的不同。',refs:['writeback','classifier']},
        {id:'classify',x:264,y:20,title:'会话分类',subtitle:'标题 · 归类 · 短摘要',tag:'后台异步',text:'分类器整理 Session 的共享元数据和发起者的个人视图。它不继续任务，也不构成业务结果验收。',refs:['classifier']},
        {id:'review',x:264,y:150,title:'记忆评审',subtitle:'截断对话 → 可复用线索',tag:'后台异步',text:'主要读取用户消息最多约 2000 字符、助手回答约 3000 字符。完整工具证据不直接输入；提炼后主要以短条目追加、按完全相同文本去重。',refs:['writeback']},
        {id:'meta',x:508,y:20,title:'Session 状态',subtitle:'workSummary · personViews',tag:'归类与恢复',text:'保存短摘要与个人会话排列。项目认识不能只依赖生成摘要；原始证据和业务系统仍需保持可达。',refs:['control','person']},
        {id:'candidate',x:508,y:150,title:'允许的写回目标',subtitle:'用户候选 · 系统候选 · 任务',tag:'配置决定',text:'代码默认发现最多 24 个任务文档；配置按目标 ID 禁用或替换。在本次实例审计中仍有 3 个任务目标、用户 inbox 和系统候选目标；这不是只进 inbox。目标资格不等于内容已验收。',paths:['writeback-targets.json','reference/inbox.md','memory/auto-system-memory.md','tasks/（依配置）'],refs:['targets','writeback']},
        {id:'sources',x:20,y:362,title:'已登记的项目来源',subtitle:'讨论 · 录音 · 会话 · 评论',tag:'实例项目流程',text:'现有日报来源有明确白名单与排除范围，不能代表全组织覆盖。采集检查点、分页和失败记录属于本机项目审阅资料。',refs:['daily']},
        {id:'ledger',x:264,y:362,title:'项目认知主账',subtitle:'认识 · 分歧 · 依据',tag:'人工与 Agent 维护',text:'将来源形成项目认识，保留改变结论的证据。用户目录的 projects.md 是导航；项目知识目录的 projects.md 是认知主账。',paths:['project-knowledge/projects.md'],refs:['daily']},
        {id:'daily',x:508,y:362,title:'日报与项目说明',subtitle:'日期视图 · 发布回执',tag:'可读投影',text:'日报解释现有任务与结果，出版、正文读回、评论绑定和送达分别核验。一个发布成功回执不能证明所有读者已收到或认可。',paths:['project-knowledge/daily/','project-review/daily/','project-review/publication-receipts/'],refs:['daily']},
        {id:'feedback',x:752,y:362,title:'人的纠正与反馈',subtitle:'评论 → 认识调整',tag:'已有部分反馈链路',text:'已有评论处理与局部修订。对每个条目、每个版本分别绑定项目负责人、相关个人和验收人的确认，仍是待建设能力。',refs:['daily']}
      ], edges:[['result','classify'],['result','review'],['classify','meta'],['review','candidate'],['sources','ledger'],['ledger','daily'],['daily','feedback'],['feedback','ledger','纠正']]
    },
    target: {label:'治理后的目标',intro:'全项目信息先进入独立测试层。共识草案、项目视图和个人视图由同一批可追溯记录生成；职责确认和正式执行后续分步启用。',height:510,
      nodes:[
        {id:'registry',x:20,y:35,title:'全项目来源目录',subtitle:'来源范围 · 覆盖与缺口',tag:'拟建设',text:'覆盖所有已登记项目。列清来源、读取授权、检查点、编辑/撤回能力、失败与排除理由。不可读就呈现缺口，不绕过边界也不标记完整。'},
        {id:'claims',x:264,y:35,title:'带来源的信息记录',subtitle:'事实 · 报告 · 承诺 · 判断',tag:'拟建设',text:'保留原出处、作者、发生时间、获知时间、项目/人员归属和版本；转发、日报与 Agent 摘要沿用来源谱系，不算多份独立佐证。'},
        {id:'reconcile',x:508,y:35,title:'状态与分歧核对',subtitle:'真实进展与证据程度分开',tag:'拟建设',text:'用相应业务系统核对状态。新结论指明替代谁，保留旧版本和分歧；未知留待核。计划、开跑、产物和验收不可自动越级。'},
        {id:'consensus',x:752,y:35,title:'组织共识草案',subtitle:'有效认识 · 版本 · 待确认',tag:'测试先产出',text:'明确来源的普通事实可自动核对。范围与优先级由项目负责人确认，责任承诺由相关个人确认，交付结果由验收人确认；无回应不等于认可。'},
        {id:'observe',x:264,y:220,title:'组织观察',subtitle:'好方法 · 重复建设 · 风险',tag:'拟建设',text:'观察真实工作流程、依赖与资源冲突。一次有价值的实践即可登记候选；方法推广另需真实独立复用。Agent 优先级建议附依据和反例，不改写人的排期承诺。'},
        {id:'frontier',x:20,y:365,title:'前沿研究与外部经验',subtitle:'内部问题 → 新依据 → 验证',tag:'后续接入',text:'优先读论文与官方材料；把建议连接到具体内部问题，列清适用条件、代价和最小验证。领域新闻不能直接证明内部方案有效。'},
        {id:'views',x:752,y:220,title:'项目与个人视图',subtitle:'同一认识的不同筛选',tag:'测试日报先运行',text:'组织视图看全局与跨项目依赖；项目视图看目标、里程碑与验收；个人视图看责任、承诺和本人偏好。视图不各写一份互相冲突的主账。'},
        {id:'correction',x:508,y:365,title:'反馈与版本更新',subtitle:'确认 · 更正 · 撤回',tag:'后续启用',text:'反馈回到对应条目及版本。实质修改后核对哪些确认失效、哪些报告需更新。用纠错速度、漏报率和实际复用收益检验优化。'},
        {id:'methods',x:264,y:365,title:'方法候选与 Skill',subtitle:'发现 → 比较 → 独立复用',tag:'分步启用',text:'优先核对已有流程，区别重复、分层复用与互补。活动 Skill 升级要有适用场景、验收、失败条件和真实复用结果。'}
      ],edges:[['registry','claims'],['claims','reconcile'],['reconcile','consensus'],['claims','observe','旁观'],['observe','views','建议'],['consensus','views'],['frontier','observe'],['observe','methods'],['views','correction','反馈'],['correction','reconcile','修订']]
    }
  },
  layers:[
    {id:'bootstrap',title:'启动与路由',group:'session',scope:'实例',status:'现有',paths:['bootstrap.md','projects.md','skills.md'],read:'新线程拿到指针；正文按需读',write:'明确整理导航，不追加业务流水',rule:'入口路径要能核实当前实例；索引只放最少定位信息。'},
    {id:'session',title:'会话工作上下文',group:'session',scope:'Session',status:'现有',paths:['chat-history/','workSummary','原生 resume 标识','activeAgreements'],read:'继续原生线程，或有条件重建延续',write:'运行事件与后台分类更新',rule:'Context 事件记录 RemoteLab 的投影，不声称捕获 Harness 全部上下文。'},
    {id:'local',title:'本地偏好与环境',group:'knowledge',scope:'机器／实例',status:'现有，范围待细化',paths:['model-context/preferences.md','reference/current/','reference/topics/'],read:'相关人物、主机或领域问题时',write:'有依据地整理与标记旧结论',rule:'本地 user 层不等于当前 Person 的专属偏好；局部习惯不能覆盖整个组织。'},
    {id:'task',title:'任务恢复笔记',group:'knowledge',scope:'任务／项目',status:'现有',paths:['tasks/index.md','tasks/*.md'],read:'恢复具体工作和历史决定时',write:'任务维护；当前后台也可能写入允许目标',rule:'保留时间与来源；任务实际状态仍回查原系统。新增文件不应自然获得正式自动写入资格。'},
    {id:'system',title:'平台共享经验',group:'knowledge',scope:'跨部署平台',status:'现有',paths:['memory/system.md'],read:'平台问题相关时',write:'稳定且跨部署适用的经验整理',rule:'排除个人授权、机密路径、某次事故残留和短期业务状态。'},
    {id:'inbox',title:'自动记忆候选',group:'knowledge',scope:'用户／系统候选',status:'现有，写入边界有缺口',paths:['reference/inbox.md','memory/auto-system-memory.md','writeback-targets.json'],read:'明确的治理与核验任务中',write:'后台提炼，目标由代码与配置决定',rule:'候选不自动成为正式规则；逐条补来源、适用范围和替代关系。'},
    {id:'ledger',title:'项目认知与日报',group:'project',scope:'跨项目',status:'实例已有',paths:['project-knowledge/projects.md','project-knowledge/daily/'],read:'项目审阅与相关任务时',write:'主账更新，日报做日期投影',rule:'导航与认知主账分开；当前认识和历史变更分别可读。'},
    {id:'review',title:'审阅证据与反馈',group:'project',scope:'来源／审阅轮次',status:'实例已有',paths:['project-review/'],read:'覆盖核对、评论处理、出版验收时',write:'来源检查点、局部修订与回执',rule:'来源读取、正文发布、送达、人的认可分别记录。'},
    {id:'skills',title:'操作方法与工作流',group:'methods',scope:'适用场景',status:'已有 Skill；观察治理待启用',paths:['Skills','WORKFLOW','方法审阅记录'],read:'方法与当前任务匹配时',write:'具体改善后用独立真实任务验证',rule:'第一次有用实践即可成为候选；发现方法和证明通用有效分别验收。'},
    {id:'archive',title:'原生记忆与历史',group:'session',scope:'Harness／历史',status:'现有',paths:['Harness 自身记忆','archive/','原始来源'],read:'由 Harness 决定，或需要追溯时',write:'按各自生命周期保留',rule:'历史事实不作为当前指令；来源权限变化要影响派生内容的可读范围。'},
    {id:'organization',title:'组织共识与来源登记',group:'project',scope:'组织',status:'拟建设',paths:['组织来源目录','带版本认知记录','共识快照'],read:'后台全项目审阅；前台仅相关时',write:'独立测试层先归集，确认后受控晋升',rule:'显示覆盖缺口、分歧、证据与职责确认；不把生成摘要称为组织已认可。'},
    {id:'people',title:'个人设置、协作偏好与项目关系',group:'project',scope:'Person × Project',status:'产品设置已有；协作记录拟建设',paths:['Person.preferences','协作偏好记录','项目成员／职责关系'],read:'产品设置由界面使用；协作记录供相关个人或项目视图读取',write:'本人设置或明确表达，区分默认值与确认；协作偏好附来源与范围',rule:'已有 Session 筛选、语音快捷键和移动输入模式设置。规范化默认值不证明本人明确认可。项目和个人是多对多关系；Agent 不能凭同账号或转述认领偏好。'}
  ],
  gaps:[
    ['写入边界', '改成明确允许列表，并在执行层限制测试写入。先处理说明“只进 inbox”而新任务仍可自动写入的偏差。'],
    ['逐条来源与版本', '补作者、发生/获知时间、原始引用、状态、替代与冲突关系；避免助手总结再次被当成独立证据。'],
    ['人物与项目归属', '现有 Person 登记、产品设置与会话分类继续使用；补协作偏好的来源、范围和确认，以及项目成员职责；归属不明就待核。'],
    ['全覆盖与观察', '把来源覆盖、工作流漏报、重复建设与跨项目依赖纳入检验；零候选不能作为没有好经验的证据。'],
    ['说明与运行一致', '启动指针、当前源码、摘要注入和实际目标都需读回；旧设计、未启用配置和历史事故单独标记。']
  ],
  recordFields:[
    ['性质','事实、口头报告、计划、承诺、结果、决定、Agent 判断、方法候选'],
    ['归属','项目与人员 ID；作者、提出人、执行者、记录者分别记录'],
    ['来源','原始引用与版本；转述沿同一来源谱系'],
    ['时间','发生时间、获知时间、生效及失效时间'],
    ['状态','业务执行状态、证据程度、确认状态分别维护'],
    ['版本与传播','版本、替代/冲突关系、职责确认、受影响视图与报告'],
    ['可见范围','来源权限与派生内容一致；公开说明不包含真实名单或私人偏好']
  ],
  roles:[
    ['项目负责人','目标、范围、优先级与跨项目依赖取舍'],
    ['相关个人','本人责任、时间与交付承诺，以及本人偏好'],
    ['验收人','标准与实际交付结果的验收']
  ],
  phases:[
    {label:'全覆盖测试',enabled:'全部已登记项目：来源归集、归属核对、状态分歧、组织观察、测试日报。',disabled:'新职责确认、个人外部推送、任务写入、业务执行、Skill 晋升与正式记忆写回暂时关闭。',accept:'来源目录逐项说明已读、部分、不可读和排除；重放不重复，旧结论可追溯；测试无法污染正式记忆。'},
    {label:'确认与反馈',enabled:'按事项性质和职责确认版本；项目、个人视图回收纠正。',disabled:'明确事实不要求所有人逐条点击；无回应不自动通过；新版本不能沿用已失效确认。',accept:'对责任、范围和验收分别确认；纠正能传到受影响条目与视图，人的负担可接受。'},
    {label:'受控进入正式协作',enabled:'验收通过后逐项启用正式更新、方法推广和获授权的行动。',disabled:'不增加所有普通任务必经的隐藏规划器，不凭建议改人的排期。',accept:'相对原流程，事实错误与漏报减少、纠错更快、方法有真实复用收益，前台成功率与延迟不退化。'},
    {label:'持续优化',enabled:'新来源、真实失败、意见分歧和方法复用提供下一轮优化线索。',disabled:'不按文档篇数、记忆大小或日报数量判断治理成功。',accept:'每轮记录目标、改动、收益、代价和仍未知事项；以实际协作效果决定保留、修订或撤回。'}
  ],
  isolation:'测试有独立存储、游标、索引、原生线程和记忆状态；服务端识别测试用途并跳过正式自动写回。写入限制由代码/权限保证，不能只靠提示词。复用现有读取能力，不启动第二个群消费者或 chat 控制面。并发、CPU、IO 和 token 有独立预算；前台不增加必经模型调用或全量记忆注入，观察到退化就暂停测试消费。上述隔离是实施要求，本页未部署该测试运行层。',
  metrics:[
    ['认识是否准确','来源覆盖、归属错配、事实错误、状态越级、过期结论与纠正传播时间'],
    ['观察是否有用','工作流漏报和误报、重复工作判断准确性、跨项目依赖发现、建议被采纳及其结果'],
    ['协作是否更省力','职责确认负担、无效打扰、交接与复用收益、前台任务成功率、延迟和资源成本']
  ],
  demoRecords:[
    {id:'示例-01',project:'数据转换',people:['成员甲'],title:'转换脚本已提交',execution:'产物已提交',verification:'待独立验收',source:'代码提交回执',kind:'结果报告'},
    {id:'示例-02',project:'数据转换',people:['成员乙'],title:'训练作业已开跑',execution:'进行中',verification:'有运行证据',source:'作业系统读回',kind:'运行事实'},
    {id:'示例-03',project:'团队协作',people:['成员甲','成员乙'],title:'To do 群 → 日报反馈的方法',execution:'已实践',verification:'方法候选',source:'讨论与一次真实使用',kind:'工作流线索'},
    {id:'示例-04',project:'团队协作',people:['成员乙'],title:'现场交互体验',execution:'待现场验证',verification:'待验证',source:'原行动承诺',kind:'待办'}
  ],
  references:[
    {id:'startup',title:'启动上下文',path:'chat/system-prompt.mjs',use:'确认只提供位置与能力，不读取记忆正文'},
    {id:'prompt',title:'首轮、续接与收尾入口',path:'chat/session-manager.mjs',use:'确认 fresh/resume、逐轮投影与后台写回调用'},
    {id:'turn',title:'本轮上下文',path:'chat/turn-context-hook.mjs',use:'来源、桥接和显式约定；短摘要不普通每轮重注入'},
    {id:'source',title:'连接器 Context 契约',path:'docs/connector-turn-context.md',use:'Request 来源快照和投影可观察范围'},
    {id:'continuation',title:'有界延续',path:'chat/session-continuation.mjs',use:'历史选择与截断'},
    {id:'control',title:'会话状态投影',path:'chat/session-control-state.mjs',use:'workSummary 的保存与延续关系'},
    {id:'classifier',title:'后台会话分类',path:'chat/session-state-classifier.mjs',use:'会话组织与业务验收的区别'},
    {id:'person',title:'个人 Session 视图',path:'chat/session-person-view.mjs',use:'视图归类不等于个人记忆或访问隔离'},
    {id:'personSettings',title:'已有个人产品设置',path:'lib/auth-config.mjs',use:'Person.preferences 的保存与默认值规范化；不等于完整的协作偏好库'},
    {id:'targets',title:'写回目标发现',path:'chat/memory-writeback-targets.mjs',use:'任务发现、禁用配置与候选目标'},
    {id:'writeback',title:'自动记忆提炼',path:'chat/session-memory-writeback.mjs',use:'输入范围、追加与文本去重'},
    {id:'activation',title:'记忆激活边界',path:'notes/current/memory-activation-architecture.md',use:'指针与正文、存储与使用分开'},
    {id:'thin',title:'控制面与 Harness 分工',path:'notes/current/thin-control-plane-architecture.md',use:'保持 Harness 对普通任务的解释与执行权'},
    {id:'daily',title:'已出版日报的条件式读取',path:'docs/feishu-daily-report-memory.md',use:'仅配置的 Jev 路径读取有回执和 hash 的有界日报片段，不代表每个 Session 都读日报'},
    {id:'preflight',title:'可选启动知识探测',path:'docs/session-start-preflight.md',use:'它不是本地记忆检索或权限验收；本次实例配置未启用'}
  ],
  external:[
    {title:'LangGraph：记忆范围与后台整理',url:'https://docs.langchain.com/oss/python/concepts/memory',use:'借鉴会话和长期知识分开、组织/个人命名空间；保留现有 Harness。'},
    {title:'Zep：有时间范围的事实',url:'https://help.getzep.com/facts',use:'记录获知、生效、失效与来源；有来源或模型提取不等于验收。'},
    {title:'Letta：用途明确的记忆块',url:'https://docs.letta.com/v1-sdk/memory/memory-blocks',use:'借鉴明确用途、容量与只读边界；按需激活相关内容。'},
    {title:'Microsoft：事件记录与派生视图',url:'https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing',use:'关键认知更正与确认保留历史；仅在有收益的部分采用，不全系统迁移。'}
  ],
  maintenance:[
    'guide-data.js 是本说明的内容源；网页与 Agent 参考 Markdown 使用同一份内容。',
    '改读取/写回入口、来源范围或 Person 模型时，同步更新状态与依据；旧方案明确标记为历史或未实施。',
    '本机审计证据、真实用户与偏好留在认证实例；共享文档只描述架构和经过脱敏的示例。',
    '用真实问题验证治理效果，并记录仍未证明的部分；这份说明会随目标和实现继续修订。'
  ]
};

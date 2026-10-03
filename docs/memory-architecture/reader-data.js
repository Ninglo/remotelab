// Canonical editorial explanation; the atlas reader imports this chapter.
export const memoryAudit = {
  version: '记忆阅读版 1.2 · 2026-10-03', commit: 'ebc76e1e（本轮基线）',
  scope: '本次补核项目指针v2、人员档案、旧偏好入口、实际自动写回目标及文件位置。旧消息章节和系统总览保留各自基线；不把本次核对日期当成全站重新验收。',
  sources: ['chat/project-memory-runtime.mjs', 'chat/turn-context-hook.mjs', 'chat/system-prompt.mjs', 'chat/session-memory-writeback.mjs', 'chat/memory-writeback-targets.mjs', 'chat/memory-context-view.mjs', 'chat/memory-file-catalog.mjs', 'chat/person-memory-context.mjs', 'docs/project-memory-rollout.md'],
};
export const memorySteps = [
  {title:'识别这次工作是谁、来自哪里', owner:'平台提供已核身份与来源；Harness解释本次请求', action:'个人身份看实际 Person / identity 绑定。群话题看连接器、群和话题绑定。标题相似、同一 Unix 用户、个人侧栏分组都不证明项目归属。', read:'当前输入、来源上下文、已核本轮发言人的Person档案指针、已存在的局部约定。', write:'原消息和执行事件留在本 Session；不在识别阶段重写项目结论。', next:'能精确匹配群或已明确绑定 Session，才带出项目指针；歧义保持待核。'},
  {title:'拿到入口，不全盘装载', owner:'RemoteLab 的启动与本轮上下文投影', action:'新原生线程获得 bootstrap、项目／Skill／任务／共享记忆的路径。续接复用原生上下文，适用的本轮来源与项目指针仍按当前输入投影。文件正文不会因为出现路径就自动读入。', read:'项目 runtime 配置，匹配的 projectIds、版本和入口。', write:'这一步不写业务记忆，也不调用新的分类模型。', next:'不匹配的普通任务沿旧指针；不用读全员偏好或全部日报。'},
  {title:'按本次问题读到具体依据', owner:'当前 Harness', action:'项目工作进入索引和原主账相应章节；追溯进程时读按时间排列的关键事件与原引用。涉及某个人再读其资料；就餐／出行再读公司背景。读取应定位到相关事项和中间段落，不能只取文件头尾。', read:'有效约定、事项的前后状态、当前任务，以及相关仓库规则／Skill；实时状态查实际系统。', write:'读到待核判断不自动变成事实。背景与项目正文并列存放，不互相复制。', next:'继续工作，解释依据；若历史互相冲突，核同一事项和证据时效。'},
  {title:'留下事件，并归到正确位置', owner:'平台存过程；Harness整理认识；既有后台收候选', action:'过程保存到 Session / Run。项目结果、决定、责任与范围回原项目主账。局部话题约定留话题，明确个人偏好按 Person 存，公司公共事实存公司背景。自动整理结果先看本实例写回配置，候选不等于已认可。', read:'原消息／工具回执、明确的项目或个人范围与既有条目。', write:'当前主账增量修订；背景记录和候选分开；被替代结论保留历史依据。', next:'同一事件发生时间与记忆录入时间分别记录，不靠文件修改时间猜创建时间。'},
  {title:'日报收反馈，同一条目修正', owner:'原日报流程与按职责参与的人', action:'讨论群、干活群和相关个人 Session 供给同一项目认识。项目／个人／总日报是同一认识的视图。普通可核事实沿原链路更新；范围、优先级、人的承诺与验收由相应职责确认。', read:'原主账、原来源与真实任务／验收结果；观察可复用工作流和重复工作。', write:'纠正回原事项，关联先前版本；无回复保持待核。', next:'本轮指针接入已发生；后续人的真实使用、职责认可与全成本效果仍逐项观察。'},
];
export const executionRows = [
  ['项目归属','已启用','9个登记节点、8个精确来源群；讨论和干活群可指向同一项目。当前治理 Session 有明确绑定。','登记包含主线、子项、探索和历史主题；不等于9个活跃项目或全组织覆盖。'],
  ['开工读取','已启用','本轮投影项目索引／主账／审阅规则指针，本会话已实际收到v1元数据；本轮v2只增时间进程规则，项目读取方式沿用。','指针送达不等于正文已读或已采用；无关任务不额外装载项目正文。'],
  ['原项目主账','持续在用','同一 projects.md 承载认识，索引定位章节；来源与有日期的更新已存在。','Claude Tag目前共享上级章节；不伪造一份已经单独维护的账本。'],
  ['项目时间线','首版补齐','从原有日期、原文与版本回填关键进程；登录后可按项目查看、按有明确人员证据的事件筛选。','这是来源受限的进程视图，未穷尽全部历史。发生、记录、更新与创建时间分开；来源变化会提示视图需刷新。'],
  ['日报增强','已接入原规则','复用既有04:00／18:00流程、同一主账和原反馈出口，未加第二个消费者。','规则进入原链路不代表下一轮执行已验；正式文档、发送和人认可各有证据。'],
  ['个人背景','开始按人登记','人员区按真实Person保存明确偏好；本轮当前消息身份匹配后提供该人档案指针，已取消公共AGENTS中的个人称呼条目。','不从旧机器共用身份继承全部成员偏好；尚未完成全员写作偏好与职责登记。'],
  ['公司背景','本轮补入','办公楼事实、地点来源、公共交通入口和周边待核线索分别保存，相关话题按需读取。','团队常去餐厅、集合门口仍需真实反馈。价格、营业、路线、到达时间行动前查。'],
  ['组织观察','既有流程继续补证','日报可发现风险、重复工作和优秀方法；候选需真实案例、适用条件和证据。','观察建议不是人的优先级承诺；没有新自动Skill升级或个人贡献排名。'],
  ['速度与成本','尚未证明收益','前台新增的是小型项目指针；后台沿原日报，旧版已冻结且有总／分项关闭入口。','局部代码耗时不等于完整回复速度；token、准确度和总成本按真实使用验，不能宣布已改善。'],
];
export const timeRules = [
  ['事件发生时间','人作出决定、工作执行或验收发生的时间；知道日期就只记日期，不补造时分。'],
  ['原记录／录入时间','何时留下或收到了该信息。旧记录无法核到录入时间就留空，不能拿本次整理时间代替。'],
  ['整理／更新时间','本次归集与生成视图的时间；用于判断视图是否落后于主账。'],
  ['事项与状态变化','同一事项用稳定标识关联：提出→开工→产物提交→验证→人的验收。反馈、暂停和改归属分别记录，不只把“完成”叠在最后。'],
  ['人员与职责','发言人、执行人、负责人、验收人分开。被提及不证明负责；身份不清时保留来源里的称呼。'],
  ['项目起点','明确创建／立项依据、最早已存在的依据、仍未知三种结果分开。只看到9月16日纳入，不能断言9月16日创建。'],
];
export const timelineExample = [
  ['9月10日','提出需求','在来源话题提出一个转换任务；还没有交付。'],
  ['9月12日','产物提交','执行人给出脚本；当时状态是待验证。'],
  ['9月14日','验证失败','发现字段不一致，回到修订；提交并未等于完成。'],
  ['9月16日','修订后验收','有新结果与验收人回执，原失败保留在过程里。'],
];
export const backgroundCases = [
  ['个人称呼／写作偏好','核实际Person→读其明确偏好→应用到相应人的任务。','某同事希望使用全名：仅对该人有效；本人后续纠正更新原条。'],
  ['公司位置／常用地点','读公司公共背景→按当次人数、预算、目的地补实时查询。','办公楼是稳定背景；团队常去餐厅需真实反馈，个人忌口归本人。'],
  ['杂事群中的介入','按既有唤醒与消息规则进入工作→核对讨论现状→有有用增量再建议。','谈午餐时可给近处候选和路程；不因饭点固定插话，不自动订餐或改日程。'],
  ['AGENTS.md 的边界','工作区／仓库的共同操作规则与简短入口；包含如何按身份读取人员区，不包含任何员工的个人偏好。','完整个人资料、地址、任务进度和餐厅表留专属资料；不把全员偏好堆成全局指令。'],
];

// Paths are public naming rules. Exact instance paths and real Person filenames
// are read only after the authenticated inspection button is clicked.
export const memoryFileMap = [
  ['规则','AGENTS.md','工作区/AGENTS.md；项目仓库/AGENTS.md；适用子目录/AGENTS.md','共同操作要求与简短入口；如保存已有工作、验证、交付、按身份读取人员区。','已认可且作用于该目录的共同规则由人或获授权Agent维护。个人称呼、写作口味、办公地址和业务进度均不进入。'],
  ['规则','system.md','源码仓库/memory/system.md','跨实例可复用的RemoteLab平台知识；不等于AGENTS，也不等于员工档案。','人工审阅跨部署适用性后维护；单个公司的偏好和机器故障记录不直接推广。'],
  ['导航','bootstrap.md','记忆目录/bootstrap.md','新线程得到路径；Harness按需读的小型开工入口。','只保留索引和稳定定位，不装全员档案或完整项目正文。'],
  ['导航','projects.md','记忆目录/projects.md','旧领域与任务的指针目录；与项目主账同名、路径不同。','按问题定位主题或任务；项目状态以项目知识目录的原主账为准。'],
  ['导航','skills.md','记忆目录/skills.md','方法与Skill入口。','路由到现行Skill，不复制操作全文或项目状态。'],
  ['导航','memory-layout.md','记忆目录/reference/memory-layout.md','实例分层、归档和读取边界。','治理更新；历史目录与现行入口明确分开。'],
  ['人员','index.md','记忆目录/reference/people/index.md','人员档案入口及身份读取规则。','Person来自当前消息身份或明确核实的同事；缺档不等于无偏好。'],
  ['人员','<personId>.md','记忆目录/reference/people/<personId>.md','这个人的称呼、写作、协作习惯、适用范围、本人来源与变更日期。','本人明确表达可更新原条；转述、推断和身份不清先待核；只对该人适用。当前用一个档案，不再嵌套每人一份preferences.md。'],
  ['人员','auth.json → Person.preferences','配置目录/auth.json','真实Person/identity映射及产品设置，如输入模式、语音快捷键。','由产品身份与设置流程维护；默认值不是本人表态。不把自然语言偏好或凭据复制到公开说明。'],
  ['背景','company.md','记忆目录/reference/company.md','办公地点、公共出行入口、团队确认的常用地点与来源。','相关话题按需读；个人忌口归本人，餐厅营业和实际路线行动前查询。'],
  ['背景','hosts.md；robodojo-platform.md','记忆目录/reference/current/','主机与评测平台当前事实入口。','事实修改需核当前部署/API；不把旧记录的机器状态当实时状态。'],
  ['背景','advisor.md；evaluation.md；foundation-model-training.md；remotelab.md；robotics.md；tools.md；training.md；work-management.md','记忆目录/reference/topics/','已有领域资料、局部约定和方法背景。','只在命中领域时读；有来源和适用范围。旧“用户要求”未核Person前不转成全员偏好。'],
  ['任务','index.md；<任务名>.md；daily-unresolved-feishu.json','记忆目录/tasks/','任务入口、局部决定、恢复资料和未处理事项。','先核真正任务/Run/验收系统；新建任务文件不会因文件存在自动获得记忆写回权限。登录清单列出实际任务文件名。'],
  ['项目','project-runtime.json','记忆目录/project-runtime.json','项目、群与明确Session的关联及开关、索引/主账/审阅规则路径。','精确来源或显式绑定；侧栏分组、标题相似和提到某项目不足以挂靠。'],
  ['项目','project-index.md；projects.md','项目知识目录/project-index.md；项目知识目录/projects.md','索引与唯一项目认识主账，讨论群、干活群和相关个人工作供给同一认识。','原链路增量更新，事实/承诺/验收/观察分开；稳定事项及引用连回来源。'],
  ['项目','<YYYY-MM-DD>.md','项目知识目录/daily/<YYYY-MM-DD>.md','项目、个人和总日报的日期投影。','从同一原认识生成；人的反馈回原事项，不另起竞争主账。'],
  ['项目','workflow.md；chronology.json','项目审阅目录/project-memory/releases/<release>/','当前审阅规则与来源受限的时间线视图。','配置指向当前release；时间线核主账版本、时间类型及前序关系。冻结旧release不随意覆盖。'],
  ['项目','<YYYY-MM-DD>.sources.md；<来源快照>','项目审阅目录/daily/；项目审阅目录/project-memory/releases/<release>/source-snapshots/','来源覆盖、失败、原文证据与不可变历史快照。','保存实际读到/未读到的边界；记录时间、事件时间和整理时间分开。'],
  ['候选','inbox.md','记忆目录/reference/inbox.md','自动提取的本实例待核信息，允许个人偏好候选。','不是默认规则或人员认可。新写回保留Session/Run/用户事件序号/录入时间；从原消息核作者，旧无来源条目不补造身份。'],
  ['候选','auto-system-memory.md','源码仓库/memory/auto-system-memory.md','自动提取的跨部署平台候选。','不收个人preference类别；内容误标仍有语义风险，人工审阅才进正式system.md，不直接升级AGENTS。'],
  ['候选','writeback-targets.json','记忆目录/writeback-targets.json','自动写回目标配置。','本实例allowedTargetIds仅允许user_auto_memory和system_auto_memory；实际用户目标是inbox。目标类别同时校验；允许列表之外的新任务被拒绝。其他实例配置需另核。'],
  ['来源','chat-sessions.json；meta.json；context.json；fork-context.json','配置目录/chat-sessions.json；配置目录/chat-history/<sessionId>/','Session元数据、历史索引和续接/分支上下文。','平台保存过程；Session总结与侧栏不等于项目共识，也不证明谁是本轮作者。'],
  ['来源','<seq>.json；<ref>.txt','配置目录/chat-history/<sessionId>/events/；同Session的bodies/','消息与执行事件及正文；本实例Session事件按JSON文件保存。','原始过程按时间和序号可追溯；继续原生线程可能仍含旧上下文。'],
  ['来源','manifest.json；status.json；result.json；spool.jsonl；artifacts/','配置目录/chat-runs/<runId>/','单次运行配置、状态、结果、输出流和工具产物。','Run结束不等于任务完成；原生provider home从对应运行配置核实，不凭Unix用户名猜。'],
  ['来源','events.jsonl；connector-message-index.json；<项目hash>.jsonl','连接器storageDir/；其project-message-streams/','群原文事件、消息索引和项目关联消息流。','两个群可供给同一项目；关联文本有限额，不保证全群历史已语义检索。登录后显示已登记storageDir，不重新启动采集器。'],
  ['历史','preferences.md','记忆目录/model-context/preferences.md → 记忆目录/archive/people-boundary-20261003/preferences.md','你记得的旧Preferences文件。现行文件保留历史导航，原混合正文已完整归档。','旧版机器级入口混合公共规则、局部约定和未核人的倾向；不作为全员偏好、不批量归给当前人。'],
  ['历史','auto-user-memory.md；global.md；automation.md','记忆目录/model-context/auto-user-memory.md；记忆目录/global.md；记忆目录/automation.md','旧索引与历史路由。auto-user-memory这个默认文件名已被本实例写回配置替换为inbox。','文件还存在不等于仍接收自动写入。只追溯原文，不恢复旧自动化授权或过期能力。'],
  ['历史','identity.md；migration-manifest.json；progress-tracker.md；group-eval-submissions.md','记忆目录/reference/personal/identity.md；reference/topics/migration-manifest.json；model-context/','旧共享身份、迁移出处和领域跟踪资料。','旧身份不是当前Person；跟踪记录不是实时状态。归档在archive/<批次>/，原文保留但不自动成为新规则。'],
  ['原生','AGENTS.md；MEMORY.md；memory_summary.md；原生会话/Skills','Harness运行配置选定的provider home；Codex常见于CODEX_HOME下','Harness自身指令、检索记忆、压缩摘要、会话与方法；独立于RemoteLab人员区。','由Harness控制加载。本次未批量改写原生记忆；其中旧路径/个人表述可能残留，发现后以已核Person和当前原档案纠正。平台指针不能抹除已加载上下文。'],
];

export const filingIncident = {
  cause: '第一次把个人称呼写进公共AGENTS，是人工把“长期需要记住”误当成“所有Session共同规则”。后来虽建立人员档案，我又保留了“全局兼容”副本；这是错误的例外，让个人正文和公共入口并存。本轮自动写回器不能直接写AGENTS，这次并非它自动分到了AGENTS。',
  correction: '个人正文只维护在对应Person档案；公共AGENTS保留读取入口。当前消息Person/identity匹配后投影该人的路径。旧preferences入口改为历史导航，原文完整归档；旧共享identity明确不代表当前作者。',
  recurrence: '仍有可能：Agent有手动文件编辑能力，语义可能判断错；原生旧线程或Harness记忆可能保留过时内容。我们缩小自动写入口、校验目标与类别、保留出处、纠正原条并核新一轮读取；没有宣称操作系统已经禁止所有人工错写。',
};
export const filingRisks = [
  ['旧偏好误套给全员','旧preferences曾以“用户”泛称多种来源，旧identity只有一个机器共用身份。','退出默认偏好入口；归档保真，未核身份保持待核，不给每个员工复制一份。'],
  ['自动写入新任务','旧配置只禁用了当时已知任务ID，新建的三份笔记仍出现在有效写回目录。','改为显式目标允许列表；用新增任务、额外目标与空列表做拒绝测试，配置之后再核实际目录。'],
  ['个人偏好进入跨部署候选','过去目标categories只有提示作用。','代码校验目标类别并拒绝system+preference；误标workflow仍需内容审阅，不能证明绝无语义错分。'],
  ['候选失去出处','旧自动条目只有短句和“用户”，未记独立来源。','新写入关联Session/Run/原用户事件与时间；旧条目不伪造时间/作者，不直接认可或迁移。'],
  ['旧上下文继续生效','改文件不会删除已经读入原生线程的内容；原生记忆也由Harness管理。','在当前轮说明更正，核新消息Person指针和原档案；真正需要重建线程时保留有用工作证据。'],
  ['领域约定或观察被升级为事实','主题文件中的历史习惯、项目建议、日期日报和运行状态用途不同。','先标来源、适用人员/项目、时间及确认状态；候选不覆盖正式决定，实时事实现场查证。'],
];

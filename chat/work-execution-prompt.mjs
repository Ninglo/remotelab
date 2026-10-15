export function executionTrialPrompt({ trialId, decisions = [], plans = [] }) {
  return [
    '## 本人的输入理解与执行安排试用',
    '适用本条已核发送者与已登记试点群。由当前 Harness 结合原讨论、已确认决定和实际工作状态理解输入；RemoteLab 只保存与运输工作，不另调用前置分类模型。区分输入理解、工作归属、执行安排、人的决定及回复位置。',
    '同一条消息可以包含问题、讨论、决定、明确交办、其他任务的补充和停止。保持当前原目标连续。简单问题和催问及时答；明确接续直接交回已核原工作。只有具体关联不清时有界查询 work context，查到候选后核原件，不逐条全局扫描或固定等补充。',
    '讨论已形成结论且人已明确要求执行时，携带总目标、已定方案、硬约束、来源、未决问题和验收要求直接开工；不要重复研究或重新询问已给出的授权。只有愿望、观点、引用或沉默不能当成开工决定，暂停项不能因被提及而恢复。',
    '执行可以留在原话题、接续已有工作或创建独立 Session。人的原话题保持为沟通与结果入口；不要因后台换执行处丢掉回复。快慢和并行按实际依赖决定：无依赖部分继续，只让确实依赖的部分等待。',
    '同群明确接续与群主线新工作沿用 work route new/continue（task、reason、targetSessionId、sourceRequestId）。跨话题/跨群信息影响使用 work route sync 草稿；展示目标、内容、影响、目标展示与回传范围，经人明确确认后复核。只允许本次个人试点登记的群；同步复核不自动授权新业务动作。',
    '对值得拆分的大任务，主动提出最多四条具体分工、依赖、各自修改范围及主话题汇总责任。先保存 work plan propose，再用原生用户提问工具让人选择全部、部分、串行或不拆。批准前不创建 Session。已有明确的一项开工指令可用 start，不能用它绕过多分支确认。',
    '入口：node "$REMOTELAB_PROJECT_ROOT/cli.js" work plan --file <JSON绝对路径> --json。每个包 sourceRequestId 必须指向本次执行实际接受的相关人类输入；原生追加不能冒用根输入。详细字段见 work --help。',
    'propose: {action:"propose",goal,context,reason,branches:[{id,name,task,writeScope,dependsOn:[]}]}。context 保留原决定与可查来源。分支按依赖排序；修改同一文件的分支应串行或分开工作区，不能只在文字里宣称互不影响。草稿完整展示后才能询问。',
    'approve: {action:"approve",planId,expectedVersion,selected:["分支id"],approval:"本次真实人类回复怎样确定选项"}。只在读取后续人类明确选择后调用；其他话题、他人的回复、系统通知、模糊讨论和没有回答都不能批准。串行需要重新提出带依赖的方案。平台核对作者、后续输入与版本，Harness负责判断语义符合具体提案。',
    'start: 与 propose 同字段，另含 authorization（这条已接受人类指令的授权依据），仅允许一个明确交办的独立任务；不把讨论成熟等同执行授权。新 Session 是可打开的 Web 工作记录，成果仍回本话题；告知实际返回的入口。',
    '分支结果、失败和等待问题自动记录，问题会送回主话题。work context 可读 executionPlans、运行/排队/等待状态及 pendingQuestion。依赖满足后推进下一分支，失败则不启动依赖方。选定分支结束后，原话题排队一次核验汇总；启动与模型结束都不等于业务完成。',
    '主话题收到补充或停止时先读最新计划，按实际影响使用 amend/stop：{action,planId,expectedVersion,selected:[...],text:"人的具体补充或停止要求"}。不得改动未选分支。stop会请求取消对应执行；需核对终态，不能把请求已发当成停止完成。已完成分支的修改另提明确后续工作，保留原成果。',
    '回答分支问题使用 answer：{action:"answer",planId,branchId,questionId,text:"人的原答案"}，必须先核当前待答问题和人的对应答案；不能替人选答案。已有背景即可解决的普通技术问题由主话题提供补充，人的授权决定不能代答。',
    '有实质归属或执行取舍时用 record 保存 {understanding,intent,where,approach,reason}。无需为每句闲聊制造记录或进展。真实失败保留回执，恢复同一方案用 resume，不重建重复计划。',
    '群主线追加输入仍分别承担回复责任：已 work route 移交的不要重复正文；plan 操作不转移原输入责任，主线用 work reply 说明实际安排。话题内正常回复；不要把规则和内部记录字段当作面向人的正文。',
    JSON.stringify({ trialId, recentDecisions: decisions.slice(-3), plans: plans.slice(-4).map(p => ({ id: p.id, version: p.version,
      state: p.state, goal: p.goal, branches: p.branches.map(b => ({ id: b.id, name: b.name, state: b.state, sessionId: b.sessionId })) })) }),
  ].join('\n');
}

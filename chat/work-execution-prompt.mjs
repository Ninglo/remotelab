export function executionTrialPrompt({ trialId, decisions = [], plans = [] }) {
  return [
    "## 本人的多项工作并行试用",
    "仅适用本条已核发送者和登记群。Harness判断意图与安排，RemoteLab只记录和运输。只在当前已授权目标内判断是否有适合独立推进的分工。普通追问、纠正和催问直接接续；提到“Session”、引用“并行”不构成拆分授权。主动分流试用已撤回，本开关不启用误发识别或自动转交。",
    "若有至少两个可独立验收、各需实质工作、无结果依赖且修改冲突可避免的部分，拆分能减少等待或便于跟进，应主动提出最多四项分工、依赖、成果、修改范围及主话题验收责任，不能因单人能做完而省略建议。同一成果的连续步骤和不可隔离的设备/文件操作留在原话题，不按列表数机械拆分。",
    "人已明确交办具体分工并要求并行则用 work plan start；否则先 propose，异步询问选择，同时立即继续原任务，不等待、不设时间窗、不把沉默当批准。只有阻塞式提问工具时先保留建议并继续。可选分支确认不能阻塞已授权主任务。只读分析不授权修改业务。",
    "保持当前目标和原话题回复。讨论已形成结论且明确要求执行则携带原决定、约束、证据、未决项和验收直接开工；愿望、引用、沉默及提及暂停项不授权启动。",
    "并行指独立RemoteLab子Session，不是原生子代理或并发工具。后台分支默认 web-silent，问题/结果回主话题；人要独立沟通入口才用 feishu-thread，话题投递绑定后启动。方案须说明入口，保留已有计划和运行位置。核 admissionNotices 实际投递，不重复创建通知。",
    "操作前读 `node \"$REMOTELAB_PROJECT_ROOT/cli.js\" work --help` 和 `$REMOTELAB_PROJECT_ROOT/docs/session-work-awareness.md` 的对应流程。work plan --file <JSON绝对路径> --json；sourceRequestId须为本次实际接受的相关人类输入，不冒用根输入。propose保留来源、上下文和依赖；相同文件需隔离或串行。",
    "approve只接受原本人后续明确选择且版本/含义不变；他人、其他话题、含糊同意、系统通知和Agent文字不批准。迟到确认先核进展，只移交仍未执行的适用部分；过期草稿stop后重提，已完成不再拆。默认原话题执行，不另造串行方案。",
    "补充/停止先核最新计划，用amend/stop仅修改选中分支，核对终态才称已停止；continue只接续明确授权的已结束且未停止分支，保留原Session成果。失败不启动依赖分支；resume复用失败方案。answer核对当前问题并传人的原答案，不代替授权决定。完成分支后主话题逐项核验汇总，启动或模型结束不等于完成。",
    "有实质分工安排取舍才用record记录理由。相关补充合并回答，独立问题及时答；统一feishu-response仅列实际回答的requestIds，不再另调work reply登记同一final。已移交输入不重复正文，plan操作不转移原输入责任。",
    JSON.stringify({ trialId, recentDecisions: decisions.slice(-3), plans: plans.slice(-4).map(p => ({ id: p.id, version: p.version,
      state: p.state, branchSurface: p.branchSurface || "web-silent", goal: p.goal, branches: p.branches.map(b => ({ id: b.id, name: b.name, state: b.state, sessionId: b.sessionId })) })) }),
  ].join('\n');
}

export function executionTrialPrompt({ decisions = [], plans = [] }) {
  return [
    "## 多项工作并行",
    "默认在原话题直接做完；不因可拆分而要求人选方案，也不把连续步骤拆成不同交付。只有拆分会实质改变交付或沟通入口、且需要本人选择时才提议，原任务不等待。",
    "人已明确交办各项并要求并行，直接用 work plan start 建独立 RemoteLab 子 Session。默认 web-silent，问题和结果回主话题；明确要求独立飞书入口才用 feishu-thread。Agent 提议的独立分支用 propose/approve，不把沉默、引用或自己的判断当批准。迟到确认仅移交尚未执行且仍适用的部分。",
    "需建分支、接续、补充或停止时，见 `remotelab work --help` 与 `docs/session-work-awareness.md`。用实际接受的 sourceRequestId 和当前计划版本；避免并行改同一处，核对分支结果并在主话题交付。",
    JSON.stringify({ recentDecisions: decisions.slice(-3), plans: plans.slice(-4).map(p => ({ id: p.id, version: p.version,
      state: p.state, branchSurface: p.branchSurface || "web-silent", goal: p.goal,
      ...(p.displayTrial ? { displayTrial: { personId: p.displayTrial.personId, endsAt: p.displayTrial.endsAt } } : {}),
      branches: p.branches.map(b => ({ id: b.id, name: b.name, state: b.state, sessionId: b.sessionId })) })) }),
  ].join('\n');
}

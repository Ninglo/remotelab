import { isStoppedAutomation } from './monitoring-status.mjs';

// Deterministic operating guidance from observed facts, not an executor or
// permission grant. Keep alert rendering and recovery prompts on the same rules.
export const monitoringPolicies = [
  { kind: 'service', title: '服务运行',
    warning: '只对已配置服务的真实失败预警，并按配置连续观测确认；启动中、计划停用和成功结束的一次性服务不算故障。',
    remedy: '先查服务状态、退出结果和依赖；低风险修复沿固定会话执行。重启前核对在途任务、服务归属和最新维护决定，可能打断业务时先给方案。',
    intervention: '需要批准时给出具体服务、影响及恢复办法；缺权限时明确所需权限。不会把所有异常都自动重启。' },
  { kind: 'api', title: 'API 调用与额度',
    warning: '调用量偏高和重复读取只作优化线索；5分钟内至少5次失败或慢请求且比例达到20%，连续观测确认后预警。管理员实测月额度80%预警、90%严重，采集日志不当作账单。',
    remedy: '脚本读取已有调用日志，定位接口和调用来源；不额外请求供应商验证额度。额度拒绝与短时拥堵分别处理，未知发送结果先回读。',
    intervention: '额度不足需要管理员提供受影响接口及真实额度、重置时间；扩容、停业务、换应用先给具体方案。短时异常先由维护方定位，不要求人处理正常消耗。' },
  { kind: 'automation', title: '自动化执行',
    warning: '启用任务真实失败才进入补救；重要任务连续确认后预警。暂停、条件未满足、已完成不算失败。',
    remedy: '沿原会话读取原产物和送达回执，只补失败步骤；已有执行先等结果，达到次数上限停止重复尝试。',
    intervention: '需批准的动作给具体方案；缺资料、登录或外部操作时说明要提供什么。点击查看不等于批准，不重复执行不确定的业务写入。' },
  { kind: 'accountContinuity', title: '账号连续性',
    warning: '正常耗尽不报警；20%检查备用准备，未知额度、无可用备用或切换持续未完成才提醒。',
    remedy: '已有账号观察脚本刷新闲置账号；自动切换开启时在10%预留线切换后续请求，在途任务继续用原账号。',
    intervention: '没有可用备用时选择登录已获授权账号或等待重置；切换未开启时由人选择。不会借用其他实例账号或自动购买。' },
  { kind: 'coverage', title: '采集与告警送达',
    warning: '数据缺失、过期、冲突标为未知，不能当作健康或耗尽；发送结果不确定单独留待核对。',
    remedy: '固定检查脚本输出采集缺口、观察器时间和送达状态；保留原消息回执，不盲目补发，也不用另一条告警形成发送循环。',
    intervention: '确需登录、授权或恢复采集入口时才请人提供明确帮助；告警暂停期间不发送也不修改卡片。' },
  { kind: 'usage', title: '用量与任务活跃度',
    warning: 'token消耗、长运行和高调用量本身不是故障，作为分析线索；不能单凭持续时间判断任务卡死。',
    remedy: '结合真实产物、进度和错误定位；常态结果留在监管页，不自动中断或降低模型。',
    intervention: '需要改变成本预算、停止业务或更换工作策略时，先提供影响和可选方案。' },
];

export function monitoringPolicyFor(item) {
  return monitoringPolicies.find(policy => policy.kind === item.kind) || null;
}

// Nothing here claims work has started. Running states require a real recovery
// admission; human approval requires a concrete plan from that execution.
export function monitoringDisposition(item) {
  if (item.kind === 'api') {
    if (item.code === 99991403 && item.notificationAvailable) return { type: 'notice', label: '查看受影响接口',
      summary: '消息投递已有成功证据；历史受限接口仍待核验，暂不需要你操作。' };
    if (item.code === 99991403) return { type: 'input', label: '查看接口与额度证据',
      summary: '需要管理员核对受影响接口的额度与重置时间；提供结果后再决定补救。' };
    if (item.id === 'feishu:tenant-quota') return { type: 'notice', label: '查看额度与调用来源',
      summary: '先定位主要调用来源；尚未执行停用或扩容，暂不需要批准。' };
    return { type: 'notice', label: '查看异常接口与来源',
      summary: '已记录调用异常，需定位调用来源；尚无已执行修复的回执。' };
  }
  if (item.kind === 'service') return { type: 'notice', label: '查看服务与补救记录',
    summary: '等待连续观测确认或补救准入；尚未重启服务，暂不需要你操作。' };
  if (item.kind === 'automation') return { type: 'notice', label: '查看任务与补救记录',
    summary: '先核对原产物和送达回执；尚无补救执行回执，暂不需要你操作。' };
  return null;
}

export function monitoringDiagnosticReport(snapshot, { kind, id } = {}) {
  const matches = item => (!kind || kind === item.kind) && (!id || id === item.id);
  const select = (items, resourceKind, key) => (items || []).map(item => ({ ...item, kind: resourceKind, id: item[key] })).filter(matches);
  return { generatedAt: snapshot.generatedAt, mode: 'read_only',
    observation: snapshot.observation, coverage: snapshot.coverage, alertDelivery: snapshot.alertDelivery,
    issues: (snapshot.attention || []).filter(matches).map(item => ({ ...item,
      policy: monitoringPolicyFor(item), nextStep: monitoringDisposition(item) })),
    resources: [...select(snapshot.services, 'service', 'unit'), ...select(snapshot.disks, 'disk', 'path'),
      ...select(snapshot.automations?.items, 'automation', 'id')].map(item => {
        // A diagnostic report does not export task prompts or saved credentials.
        const { kind: resourceKind, id: resourceId, status, state, label, title, lastResult, lastRunAt,
          availableBytes, usedPercent, inodeUsedPercent } = item;
        return { kind: resourceKind, id: resourceId, status, state, label: label || title, lastResult, lastRunAt,
          availableBytes, usedPercent, inodeUsedPercent };
      }),
    api: !kind || kind === 'api' ? snapshot.apiHealth : undefined,
    accountContinuity: !kind || kind === 'accountContinuity' ? snapshot.accountContinuity : undefined,
    recovery: (snapshot.recovery || []).filter(matches),
  };
}

// Opt-in validation phase: raise the risk threshold, then expose the actual
// recovery lifecycle in one card. Successful repair is not silently hidden.
export function monitoringNotificationDecision(item, { policy, repair, now = Date.now() } = {}) {
  const result = (notify, reason, confirmations) => ({ notify, reason, ...(confirmations ? { confirmations } : {}) });
  if (policy?.mode !== 'risk_only') return result(true, 'existing_policy');
  if (item.kind === 'disk' && (Number.isFinite(item.availableBytes) && item.availableBytes < 20 * 1024 ** 3
    || Number.isFinite(item.usedPercent) && item.usedPercent >= 97 || Number.isFinite(item.inodeUsedPercent) && item.inodeUsedPercent >= 97)) return result(true, 'disk_safety_margin', 1);
  const evidence = Array.isArray(repair?.evidence) && repair.evidence.length > 0;
  if (evidence && ['blocked', 'awaiting_confirmation'].includes(repair.status)
    && (repair.humanAction?.type === 'input' && typeof repair.humanAction.summary === 'string' && repair.humanAction.summary.trim()
      || repair.plan?.requiresConfirmation && ['medium', 'high'].includes(repair.plan.risk)
        && ['summary', 'target', 'impact', 'rollback', 'verification'].every(key => typeof repair.plan[key] === 'string' && repair.plan[key].trim()))) {
    return result(true, 'concrete_human_action', 1);
  }
  if (item.kind === 'disk') return result(item.severity === 'critical', 'disk_confirmed_pressure', 2);
  if (item.kind === 'accountContinuity') {
    const status = item.continuity?.status;
    if (status === 'unknown') return result(false, 'unknown_is_not_exhaustion');
    if (['no_backup', 'switch_disabled', 'switch_pending'].includes(status)) {
      return result(Number.isFinite(item.continuity.remainingPercent) && item.continuity.remainingPercent <= 10,
        status === 'switch_pending' ? 'switch_stalled' : 'account_reserve_without_backup', 3);
    }
    return result(false, 'normal_account_lifecycle');
  }
  if (item.kind === 'api') {
    if (item.id === 'feishu:tenant-quota') return result(false, 'consumption_without_impact');
    if (item.code === 99991403) {
      const rejectedAt = Date.parse(item.quotaRejectedAt || '');
      const freshRejection = rejectedAt <= now + 5000 && now - rejectedAt <= 15 * 60_000;
      return result(freshRejection && !item.notificationAvailable, freshRejection && !item.notificationAvailable ? 'affected_api_unverified' : 'historical_rejection', 1);
    }
    return result(item.signals?.errors === true && item.failed5m >= 10 && item.calls5m > 0 && item.failed5m / item.calls5m >= 0.5,
      'sustained_api_failures', 3);
  }
  if (item.kind === 'service') return result(true, 'confirmed_service_failure', 5);
  if (item.kind === 'automation') return result(true, 'confirmed_task_failure', 3);
  return result(false, 'local_observation_only');
}

// Names come from saved source observations; never query Feishu on page refresh.
// Project only destinations of monitored work, not private Session contents.
export function monitoringDestinations(config, sessions, tasks, repairs = []) {
  const saved = Array.isArray(sessions) ? sessions : [];
  const byId = new Map(saved.map(session => [session.id, session]));
  const names = new Map();
  for (const session of saved.slice().sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))) {
    const source = session.sourceContext;
    if (source?.chatId && typeof source.chatName === 'string' && source.chatName.trim()) names.set(source.chatId, source.chatName.trim().slice(0, 180));
  }
  const destination = conversation => {
    if (!conversation) return { mode: 'remotelab', label: '仅 RemoteLab 会话，未绑定飞书群' };
    const chatId = conversation.target?.chatId;
    if (conversation.connector !== 'feishu' || !chatId) return { mode: 'unknown', label: '回报出口未核实' };
    const chatName = names.get(chatId) || null;
    return { mode: 'feishu', chatId, chatName, nameSource: chatName ? 'saved_source_context' : null,
      threadId: conversation.target?.threadId || null,
      label: `${chatName || '飞书群（群名未核实）'}${conversation.target?.replyInThread || conversation.target?.threadId ? ' · 原话题' : ''}` };
  };
  const execution = id => {
    const session = byId.get(id);
    return { sessionId: id || null, sessionName: session?.name?.slice(0, 180) || null,
      result: session ? destination(session.conversation) : { mode: 'unknown', label: '处理会话尚未取得，出口未核实' } };
  };
  const alert = { ...destination(config.alertDelivery?.chatId ? { connector: 'feishu', target: { chatId: config.alertDelivery.chatId } } : null),
    configured: Boolean(config.alertDelivery?.chatId), enabled: config.alertDelivery?.enabled === true };
  // The dispatcher owns the incident card, independently of the executor's
  // Session binding. No binding must not imply that recovery has no report.
  const summary = { ...alert, updateMode: 'existing_incident_card',
    label: alert.configured ? `${alert.label} · 原预警卡${alert.enabled ? '' : '（推送暂停）'}` : '未配置预警接收群；记录留在监控器' };
  return {
    alert,
    resources: { ...execution(config.recovery?.coordinatorSessionId), summary },
    account: { executor: '本实例后台切换器', summary },
    api: { executor: '本实例固定检查脚本（只读诊断）', summary },
    automations: (tasks || []).filter(task => !isStoppedAutomation(task) && (task.kind === 'recurring'
      || repairs.some(repair => repair.kind === 'automation' && repair.id === task.id && repair.currentIssue)))
      .map(task => ({ id: task.id, title: String(task.title || '').slice(0, 180),
        ...execution(task.lastExecution?.sessionId || task.target?.sessionId),
        summary: (config.alertDelivery?.ignoreAutomationIds || []).includes(task.id)
          ? { mode: 'workflow', label: '沿原流程处理，不向统一群推送', enabled: false } : summary,
        // Actual resultDelivery is the execution contract; a Session binding
        // alone does not mean that this automation is allowed to send there.
        delivery: task.resultDelivery?.mode === 'conversation' ? destination(byId.get(task.lastExecution?.sessionId || task.target?.sessionId)?.conversation || task.resultDelivery)
          : config.automationReportLocations?.[task.id]?.label && config.automationReportLocations[task.id].evidence
            ? { mode: 'workflow', label: String(config.automationReportLocations[task.id].label).slice(0, 180),
              verifiedAt: config.automationReportLocations[task.id].verifiedAt || null }
            : task.resultDelivery?.mode === 'remotelab' ? { mode: 'remotelab', label: '自动回报仅留 RemoteLab；流程内投递待核实' } : { mode: 'unknown', label: '任务回报配置尚未核实' } })),
  };
}

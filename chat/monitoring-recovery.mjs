import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state);
const stopped = state => ['paused', 'cancelled', 'completed'].includes(state);
const trim = value => typeof value === 'string' ? value.trim() : '';
const stamp = value => Date.parse(value || '') || 0;
export const RECOVERY_FILE = join(CONFIG_DIR, 'monitoring-recovery.json');
export const recoveryLabels = { pending: '待补救', waiting: '已有工作进行中', admitting: '正在启动补救',
  running: '补救中', verifying: '待核验', resolved: '已验证恢复', blocked: '补救受阻', cancelled: '已停止补救' };

export function projectRecovery(state) {
  return Object.values(state?.incidents || {}).map(item => ({ key: item.key, kind: item.kind, id: item.id,
    subject: item.subject, status: item.status, label: recoveryLabels[item.status] || item.status,
    sessionId: item.sessionId || null, originRunId: item.originRunId || null,
    attempts: item.attempts?.length || 0, runId: item.attempts?.at(-1)?.runId || item.externalRunId || null,
    reason: trim(item.reason).slice(0, 240), summary: trim(item.summary).slice(0, 240),
    updatedAt: item.updatedAt, evidence: (item.evidence || []).slice(0, 5) }));
}

function healthy(snapshot, item) {
  return item.kind === 'disk' ? snapshot.disks.some(d => (d.path || d.label) === item.id && d.status === 'healthy')
    : item.kind === 'service' ? snapshot.services.some(s => (s.unit || s.label) === item.id && s.status === 'healthy') : false;
}

function promptFor(item, attempt, task, config) {
  return `处理现有警报器登记的故障，沿原任务的授权和工作流完成补救与验收。\n`
    + `对象：${item.subject}；类型：${item.kind}；ID：${item.id}；原失败Run：${item.originRunId || '无'}。\n`
    + `已观测问题：${item.error || item.reason || '见本轮监管快照'}。本次是第${item.attempts.length}次，最多${config.maxAttempts || 2}次；执行方不可再建恢复任务、日程或自我重试循环。\n`
    + (attempt.mode === 'verify' ? '已有一次后续执行结束。本次先只读核对该执行及真实产物；不能把整份任务从头再执行，不能重发已有成功消息。\n' : '')
    + `先核对现实：原任务是否已有人恢复、停止、被替代或已完成；查已保存材料和实际错误，保留已通过的检查。没有新的修正或证据，不重复失败动作。\n`
    + `模型以本轮Run记录为准，不能凭提示文字声称已换。沿原任务检查点继续，数据读取、代码/配置、执行、产物验收、对外送达分别核验。写入/发送结果不明先回读，避免重复提交、重复文档、重复消息。\n`
    + `保留原目标、数据、日程、话题、评论与历史证据。不擅自接管其他Run，不删除历史，不动其他用户的数据/服务，不扩大业务范围；execute_here=false、暂停和原任务禁发要求继续有效。权限缺口先查既有授权/备用入口；只有真正缺少授权、凭据或不可逆高风险动作才留给人，并说明最小动作。\n`
    + `服务故障先辨别正常停用、启动中与真实故障，只处理本实例已配置的服务；磁盘问题只沿已授权维护流程，不泛删目录。已有诊断/维护工作进行中就保存证据并说明依赖，不再起第二份。\n`
    + (config.workflowPaths?.[`${item.kind}:${item.id}`] ? `本对象现行工作流：${config.workflowPaths[`${item.kind}:${item.id}`]}。先完整读取。\n` : '')
    + (task ? `原任务现行提示（仅原范围；新的用户决定优先）：\n${task.prompt}\n` : '')
    + `本轮是补救或核验回报：默认不使用全员提及，不沿用原定时汇报的@所有人规则；只有用户对本次补救明确要求时才可全员提醒。此条优先于上方原任务的定时发送规则。\n`
    + `结束前写入 ${attempt.receiptFile}，JSON必须含key=${item.key}、requestId=${attempt.requestId}、status=resolved或blocked、summary、evidence（真实文件/回执/原始来源引用数组）、checks.task（实际任务验收布尔值）、checks.delivery（verified或not_required或unknown）、requiredHumanAction（若受阻，具体最小动作或外部依赖）。运行退出码0不算任务验收；模型能回复、再次提交成功不算恢复。\n`
    + `对外结果只走原绑定出口，回复说明修复了什么、如何验证、仍缺什么，不制造例行进度；原任务禁止发消息时继续禁止。资源诊断的常态结果仍并入原日报。`;
}

// The existing observer owns this ledger. Persist intent before admission; the
// native requestId deduplicates an acknowledgement lost across process restarts.
export async function processMonitoringRecovery({ config, snapshot, stateFile = RECOVERY_FILE,
  load = readRecord, save = writeDurableJson, request, now = Date.now(), dryRun = false } = {}) {
  if (!config?.enabled) return { enabled: false };
  const client = request ? null : createRemoteLabHttpClient({ baseUrl: config.baseUrl });
  const api = request || (async (path, options = {}) => {
    const response = await client.request(path, { ...options, signal: AbortSignal.timeout(5000) });
    if (!response.response.ok) throw Object.assign(new Error(response.json?.error || `HTTP_${response.response.status}`),
      { code: response.json?.code || `HTTP_${response.response.status}` });
    return response.json;
  });
  const state = await load(stateFile) || { version: 1, incidents: {}, resources: {} };
  const at = new Date(now).toISOString();
  const persist = async () => { state.observedAt = at; if (!dryRun) await save(stateFile, state); };
  const maxAttempts = Math.min(3, Math.max(1, config.maxAttempts || 2));
  const maxConcurrent = Math.min(3, Math.max(1, config.maxConcurrent || 1));
  const touch = (item, status, reason = '') => Object.assign(item, { status, reason, updatedAt: at });
  const taskById = new Map((snapshot.automations.items || []).map(t => [t.id, t]));
  const failures = snapshot.attention.filter(i => i.kind === 'automation'
    || ['disk', 'service'].includes(i.kind) && i.severity === 'critical'
      && !(config.ignoreUnits || []).includes(i.id));
  for (const [id, resource] of Object.entries(state.resources)) {
    const [kind, ...parts] = id.split(':');
    if (healthy(snapshot, { kind, id: parts.join(':') })) resource.active = false;
  }
  for (const failure of failures) {
    const id = failure.id || failure.subject;
    const task = taskById.get(id);
    if (failure.kind === 'automation' && (!task?.lastExecution?.runId || stopped(task.state)
      || config.automationIds && !config.automationIds.includes('*') && !config.automationIds.includes(id))) continue;
    const subjectKey = `${failure.kind}:${id}`;
    let generation = task?.lastExecution?.runId;
    if (!generation) {
      const resource = state.resources[subjectKey] ||= { cycle: 0, active: false };
      if (!resource.active) resource.cycle++;
      resource.active = true; generation = String(resource.cycle);
    }
    const key = hash(`${subjectKey}:${generation}`);
    state.incidents[key] ||= { key, kind: failure.kind, id, subject: failure.subject, status: 'pending',
      originRunId: task?.lastExecution?.runId || null, error: task?.lastExecution?.error || '',
      sessionId: task?.lastExecution?.sessionId || config.coordinatorSessionId || null,
      attempts: [], createdAt: at, updatedAt: at };
  }
  await persist();
  let active = 0, admitted = 0;
  const errors = [];
  const ordered = Object.values(state.incidents).sort((a, b) =>
    (a.kind === 'automation') - (b.kind === 'automation') || stamp(a.createdAt) - stamp(b.createdAt));
  // Reconcile every in-flight attempt before considering a new admission.
  for (const item of ordered) {
    if (item.status === 'admitting') { active++; continue; }
    if (['resolved', 'blocked', 'cancelled', 'pending', 'admitting'].includes(item.status)) continue;
    try {
      const attempt = item.attempts.at(-1);
      const runId = attempt?.runId || item.externalRunId;
      if (!runId) { touch(item, 'pending'); continue; }
      const { run } = await api(`/api/runs/${runId}`);
      if (!terminal(run.state)) { active++; continue; }
      if (!attempt) { item.mode = 'verify'; item.externalRunId = null; touch(item, 'pending', '后续执行已结束，先核验已有结果'); continue; }
      if (attempt.previousRuntime && !attempt.runtimeRestored && !dryRun) {
        const { session } = await api(`/api/sessions/${item.sessionId}`);
        if (session.model === attempt.model && session.effort === attempt.effort) {
          await api(`/api/sessions/${item.sessionId}`, { method: 'PATCH', body: attempt.previousRuntime });
        }
        attempt.runtimeRestored = true; await persist();
      }
      const receipt = await load(attempt.receiptFile);
      const valid = receipt?.key === item.key && receipt.requestId === attempt.requestId;
      if (valid && receipt.status === 'blocked') {
        item.evidence = receipt.evidence || []; item.summary = receipt.summary;
        touch(item, 'blocked', receipt.requiredHumanAction || receipt.summary || '补救执行方已核验阻塞'); continue;
      }
      if (run.state === 'cancelled') { touch(item, 'cancelled', '恢复执行被停止；不自动重开'); continue; }
      if (run.state === 'failed') {
        item.error = trim(run.failureReason || run.result?.error).slice(0, 1024);
        touch(item, item.attempts.length < maxAttempts ? 'pending' : 'blocked', '补救运行失败，原因保留在原运行记录'); continue;
      }
      const taskVerified = valid && receipt.status === 'resolved' && receipt.checks?.task === true
        && Array.isArray(receipt.evidence) && receipt.evidence.length > 0;
      if (!taskVerified) {
        item.mode = 'verify'; touch(item, item.attempts.length < maxAttempts ? 'pending' : 'blocked', '运行已结束，缺少有效产物验收回执'); continue;
      }
      if (item.kind !== 'automation' && !healthy(snapshot, item)) {
        touch(item, 'blocked', '补救运行结束，但本轮独立观测仍未确认恢复'); continue;
      }
      if (attempt.sourceDelivery) {
        const { deliveries } = await api(`/api/source-deliveries?sessionId=${item.sessionId}`);
        const final = deliveries.filter(d => d.runId === runId && d.surfaceKind === 'final');
        if (!final.some(d => d.state === 'delivered' && d.externalId)) {
          attempt.deliveryDeadlineAt ||= new Date(now + 10 * 60_000).toISOString();
          touch(item, final.some(d => ['failed', 'needs_review'].includes(d.state)) || now >= stamp(attempt.deliveryDeadlineAt) ? 'blocked' : 'verifying',
            '产物已核验，原出口最终消息送达仍待回读；不自动重发'); continue;
        }
      } else if (!['verified', 'not_required'].includes(receipt.checks.delivery)) {
        touch(item, 'blocked', '原任务送达验收未知'); continue;
      }
      item.evidence = receipt.evidence; item.summary = receipt.summary; touch(item, 'resolved');
    } catch (error) { item.reason = `补救状态读取失败：${error.code || 'UNAVAILABLE'}`; errors.push(item.reason); }
  }
  await persist();
  for (const item of ordered) {
    const heldSlot = item.status === 'admitting';
    if (!['pending', 'admitting'].includes(item.status) || !heldSlot && (active >= maxConcurrent || admitted >= 1)) continue;
    if (dryRun) continue;
    try {
      const brief = taskById.get(item.id);
      if (brief && stopped(brief.state)) { touch(item, 'cancelled', '原任务已停止'); continue; }
      if (healthy(snapshot, item)) {
        item.summary = '本轮独立观测确认已恢复，无需重复补救'; item.evidence = [snapshot.generatedAt];
        touch(item, 'resolved'); continue;
      }
      if (!item.sessionId) { touch(item, 'blocked', '未配置该资源的恢复会话'); continue; }
      let attempt = item.attempts.at(-1);
      if (item.status !== 'admitting') {
        const { session } = await api(`/api/sessions/${item.sessionId}`);
        if (session.archived) { touch(item, 'cancelled', '原会话已归档'); continue; }
        const latest = await api(`/api/sessions/${item.sessionId}/latest-run`);
        if (latest.runId && latest.runId !== item.originRunId) {
          const { run } = await api(`/api/runs/${latest.runId}`);
          if (!terminal(run.state)) {
            if (item.kind === 'automation') { item.externalRunId = run.id; touch(item, 'waiting', '原会话已有工作在执行，先等待其结果'); active++; }
            else item.reason = '恢复协调会话忙，稍后沿同一记录继续';
            continue;
          }
          if (item.kind === 'automation' && stamp(run.createdAt) > stamp(brief?.lastExecution?.completedAt) && run.state === 'completed') item.mode = 'verify';
        }
        if (session.activity?.run?.state !== 'idle' || session.activity?.queue?.count) { item.reason = '原会话忙，稍后沿同一记录继续'; continue; }
        if (item.attempts.length >= maxAttempts) { touch(item, 'blocked', '已达到本故障补救次数上限'); continue; }
        const task = item.kind === 'automation' ? (await api(`/api/automation-tasks/${item.id}`)).task : null;
        if (task && (stopped(task.state) || task.lastExecution?.runId !== item.originRunId)) { touch(item, 'cancelled', '原任务已停止或已有更新执行'); continue; }
        const origin = item.originRunId ? (await api(`/api/runs/${item.originRunId}`)).run : null;
        const models = (config.models || ['gpt-6-sol', 'gpt-5.6-sol']).filter(model => model !== origin?.model);
        const model = session.tool === 'codex' ? models[item.attempts.length] : session.model;
        if (!model) { touch(item, 'blocked', '没有尚未尝试的备用模型'); continue; }
        const requestId = `monitoring-recovery:${item.key}:${item.attempts.length + 1}`;
        attempt = { requestId, model, effort: session.tool === 'codex' ? 'high' : session.effort || '', mode: item.mode || 'repair',
          previousRuntime: { tool: session.tool, model: session.model || '', effort: session.effort || '', thinking: session.thinking === true },
          receiptFile: join(CONFIG_DIR, 'monitoring-recovery-receipts', `${item.key}-${item.attempts.length + 1}.json`),
          sourceDelivery: task?.resultDelivery?.mode === 'conversation' ? session.conversation || task.resultDelivery : null };
        item.attempts.push(attempt);
        attempt.body = { requestId, text: promptFor(item, attempt, task, config), tool: session.tool,
          model: attempt.model, effort: attempt.effort, ...(attempt.sourceDelivery ? { sourceDelivery: attempt.sourceDelivery } : {}) };
        touch(item, 'admitting'); await persist();
      }
      if (!attempt.runtimePinned) {
        await api(`/api/sessions/${item.sessionId}`, { method: 'PATCH', body: { model: attempt.model, effort: attempt.effort } });
        attempt.runtimePinned = true; await persist();
      }
      // Read back an uncertain admission first. A 404 permits the same native,
      // idempotent request; it never authorizes replaying a business write.
      let prior;
      try { prior = await api(`/api/sessions/${item.sessionId}/responses/${encodeURIComponent(attempt.requestId)}`); }
      catch (error) { if (error.code !== 'HTTP_404') throw error; }
      attempt.runId = prior?.replyPublication?.rootRunId;
      if (!attempt.runId) {
        const accepted = await api(`/api/sessions/${item.sessionId}/messages`, { method: 'POST', body: attempt.body });
        attempt.runId = accepted.run?.id;
      }
      if (!attempt.runId) throw Object.assign(new Error('No admission receipt'), { code: 'MISSING_RUN' });
      touch(item, 'running'); admitted++; if (!heldSlot) active++; await persist();
      const { run } = await api(`/api/runs/${attempt.runId}`);
      if (run.model && run.model !== attempt.model) {
        await api(`/api/runs/${attempt.runId}/cancel`, { method: 'POST' });
        const { session } = await api(`/api/sessions/${item.sessionId}`);
        if (session.model === attempt.model && session.effort === attempt.effort) {
          await api(`/api/sessions/${item.sessionId}`, { method: 'PATCH', body: attempt.previousRuntime });
        }
        attempt.runtimeRestored = true;
        touch(item, 'blocked', '实际运行模型与已选择的备用模型不同，已停止本次补救');
      }
    } catch (error) {
      item.reason = `补救准入待核：${error.code || 'UNAVAILABLE'}`;
      if (['HTTP_400', 'HTTP_403', 'HTTP_404'].includes(error.code)) touch(item, 'blocked', `恢复入口拒绝该请求：${error.code}；需核对配置、权限或原会话是否仍存在`);
      if (item.status === 'admitting' && !heldSlot) active++;
      errors.push(item.reason);
    }
    await persist();
  }
  await persist();
  return { enabled: true, admitted, active, dryRun, errors, incidents: projectRecovery(state) };
}

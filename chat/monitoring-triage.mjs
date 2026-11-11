import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isStoppedAutomation } from '../lib/monitoring-status.mjs';

const exec = promisify(execFile);
const terminal = state => ['completed', 'failed', 'cancelled'].includes(state);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const stamp = value => Date.parse(value || '') || 0;
const decision = (disposition, code, summary, evidence = {}, extra = {}) => ({
  disposition, code, summary, evidence, fingerprint: fingerprint([code, evidence.identity || null]), ...extra,
});

export function dependencyFailure(value) {
  const error = String(value || '').slice(-32768);
  if (/暂无可用的 Codex 账号|Codex 账号(?:额度已耗尽|正在限流冷却|未登录)/.test(error)) {
    return { code: 'codex_account_unavailable', summary: '执行依赖的Codex账号不可用；等待原账号观察器，不以新模型会话重复诊断。' };
  }
  if (/Permission denied \((?:publickey|password|keyboard-interactive)[^)]*\)|ssh_authentication_failed/i.test(error)) {
    return { code: 'ssh_authentication_failed', summary: 'SSH认证失败；等待接入维护方恢复现有授权，不重复启动诊断对话。',
      humanAction: { type: 'input', summary: '接入维护方核对并恢复该对象现有SSH公钥授权；恢复后由原采样脚本验证。' } };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(error)) {
    return { code: 'ssh_host_identity_failed', summary: 'SSH主机身份校验失败；保留验证，不自动删除或替换主机密钥。',
      humanAction: { type: 'input', summary: '接入维护方核实已登记主机的真实指纹及变更来源。' } };
  }
  if (/\b99991403\b/.test(error)) return { code: 'provider_quota_rejected',
    summary: '接口明确拒绝额度；保留原任务和未完成步骤，等待受影响接口的额度恢复证据。',
    humanAction: { type: 'input', summary: '应用管理员核对受影响接口的实际额度和恢复时间。' } };
  if (/\b99991672\b/.test(error)) return { code: 'provider_permission_missing',
    summary: '接口缺少明确权限；需核对既有权限和可用入口，交由一次Agent按现行授权流程处理。', agent: true };
  return null;
}

export async function probeService(unit, { execute = exec, now = Date.now() } = {}) {
  if (!/^[\w@.-]+\.(service|timer)$/.test(unit?.unit || '') || !['system', 'user'].includes(unit.scope)) throw Error('UNREGISTERED_SERVICE');
  const scope = unit.scope === 'user' ? ['--user'] : [];
  const options = { timeout: 3000, maxBuffer: 32768, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } };
  const { stdout } = await execute('systemctl', [...scope, 'show', unit.unit,
    '--property=LoadState,ActiveState,SubState,Result,Type,ExecMainStatus,InvocationID,Restart,RestartUSec,MainPID,ExecMainStartTimestamp'], options);
  const state = Object.fromEntries(stdout.trim().split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  let dependency = null, journalAvailable = false;
  // Scope classification to this invocation. Old authentication errors must not
  // misclassify a later unrelated failure. Raw logs never enter public receipts.
  if (/^[a-f0-9]{32}$/.test(state.InvocationID || '')) {
    try {
      const { stdout: journal } = await execute('journalctl', [...scope, '-u', unit.unit,
        `_SYSTEMD_INVOCATION_ID=${state.InvocationID}`, '-n', '60', '--no-pager', '-o', 'cat'], options);
      journalAvailable = Boolean(journal.trim()) && !journal.includes('No entries');
      dependency = dependencyFailure(journal);
    } catch { /* A missing journal remains a diagnostic gap, not a healthy reading. */ }
  }
  return { state, dependency, journalAvailable, observedAt: new Date(now).toISOString() };
}

export async function probeLocalHealth(url, { fetcher = fetch } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.username || target.password) throw Error('INVALID_LOCAL_HEALTH_URL');
  const response = await fetcher(target, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) return { healthy: false, status: response.status };
  let size = 0, body = '';
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 65536) throw Error('HEALTH_RESPONSE_TOO_LARGE');
    body += Buffer.from(chunk).toString('utf8');
  }
  return { healthy: JSON.parse(body).ok === true, status: response.status };
}

// This gate never creates a Session, retries a business operation, edits a
// provider receipt, changes credentials or chooses a new service target.
export async function triageMonitoringIncident({ item, snapshot, config = {}, task, origin,
  requestRecord, receipt, deliveries = [], latestRun, now = Date.now(),
  inspectService = probeService, health = probeLocalHealth, execute = exec,
  beforeAction = async () => { throw Error('ACTION_INTENT_REQUIRED'); } } = {}) {
  if (item.kind === 'service') {
    const current = snapshot.services.find(service => service.unit === item.id);
    const unit = config.services?.find(service => service.unit === item.id);
    if (current?.status === 'paused') return decision('cancelled', 'service_retired', '服务已登记停用；保留事故与处置历史。');
    if (!unit || !current || current.status === 'unknown') return decision('wait', 'service_observation_missing', '服务观测不完整，等待原观察器取得有效状态。');
    const policy = config.serviceActions?.[item.id];
    if (current.status === 'healthy') {
      if (current.recoveryReady === false) return decision('wait', 'service_stabilizing', '服务已经运行，脚本等待连续稳定窗口，不再启动修复对话。');
      if (policy?.healthUrl) {
        let check; try { check = await health(policy.healthUrl); } catch { check = { healthy: false }; }
        if (!check.healthy) return decision('agent', 'business_health_failed', '服务进程已运行，但登记的业务健康检查未通过。', { health: check });
      }
      return decision('resolved', 'service_verified', '独立服务观测及已登记业务健康检查通过。', { observedAt: current.observedAt });
    }
    const probe = await inspectService(unit, { now });
    const evidence = { identity: [item.id, probe.state.Result, probe.state.ExecMainStatus],
      state: probe.state, journalAvailable: probe.journalAvailable };
    if (probe.dependency) return decision(probe.dependency.agent ? 'agent' : 'blocked', probe.dependency.code,
      probe.dependency.summary, evidence, { humanAction: probe.dependency.humanAction });
    if (probe.state.ActiveState === 'active' || probe.state.ActiveState === 'activating'
      && now - stamp(item.createdAt) < (config.nativeRecoveryGraceMs ?? 120000)) {
      return decision('wait', 'native_service_recovery', '服务管理器正在启动或恢复；由脚本复查，不叠加重启和Agent。', evidence);
    }
    if (policy?.action === 'restart' && unit.unit.endsWith('.service') && !unit.maintenance?.reason && !item.triageAction
      && ['failed', 'inactive'].includes(probe.state.ActiveState) && probe.state.LoadState === 'loaded'
      && ['exit-code', 'signal', 'core-dump', 'timeout', 'watchdog', 'start-limit-hit', 'oom-kill'].includes(probe.state.Result)
      && probe.state.Type !== 'oneshot' && !item.attempts?.length) {
      await beforeAction({ kind: 'service_restart', unit: unit.unit, scope: unit.scope, startedAt: new Date(now).toISOString() });
      const argv = [...(unit.scope === 'user' ? ['--user'] : []), '--no-block', 'restart', unit.unit];
      try {
        await execute(unit.scope === 'system' ? 'sudo' : 'systemctl', unit.scope === 'system' ? ['-n', 'systemctl', ...argv] : argv,
          { timeout: 5000, maxBuffer: 8192 });
      } catch (error) {
        return decision('agent', 'service_restart_unverified', '已登记恢复动作未取得确定结果；保留执行意图，不自动重放。', { ...evidence, actionError: String(error.code || 'FAILED') });
      }
      return decision('wait', 'service_restart_requested', '已通过原服务管理器执行一次登记重启，等待后续独立观测和业务健康检查。', evidence);
    }
    return decision('agent', 'service_diagnosis_required', '固定服务检查已完成，当前故障不属于可自动处置的已知原因。', evidence);
  }
  if (item.kind !== 'automation') return decision('agent', 'specialist_required', '固定处置后仍需判断，沿原对象工作流处理。');
  if (!task) return decision('wait', 'task_observation_missing', '原任务读取未完成，保留事故，不以缺失判断完成。');
  if (isStoppedAutomation(task, now)) return decision('cancelled', 'task_stopped', '原任务已停止，保留原事故记录。');
  if (task.lastExecution?.runId && task.lastExecution.runId !== item.originRunId) return decision('cancelled', 'task_superseded', '原任务已有更新执行；旧失败保留，不再重复补救旧Run。');
  if (latestRun && !terminal(latestRun.state)) return decision('wait', 'original_work_running', '原会话仍有工作执行，脚本等待其结果，不启动第二份任务。', { identity: latestRun.id });
  const attempt = item.attempts?.at(-1);
  const valid = attempt && receipt?.key === item.key && receipt.requestId === attempt.requestId
    && ['resolved', 'blocked'].includes(receipt.status) && receipt.checks?.task === true
    && Array.isArray(receipt.evidence) && receipt.evidence.length > 0;
  if (valid) {
    const final = deliveries.filter(d => (d.runId === attempt.runId || d.responseId === attempt.requestId) && d.surfaceKind === 'final');
    const expected = Boolean(attempt.sourceDelivery);
    if (expected ? final.length && final.every(d => d.state === 'delivered' && d.externalId)
      : ['verified', 'not_required'].includes(receipt.checks.delivery)) {
      return decision('resolved', 'acceptance_and_delivery_verified', '原产物验收回执与对应投递记录已核对通过，无需再次启动验收对话。',
        { identity: attempt.runId, receiptFile: attempt.receiptFile, deliveryIds: final.map(d => d.externalId) });
    }
    if (final.some(d => ['pending', 'sending', 'retrying'].includes(d.state))
      && now - stamp(item.triage?.code === 'native_delivery_pending' ? item.triage.waitStartedAt : receipt.completedAt || item.updatedAt) < 10 * 60_000) {
      return decision('wait', 'native_delivery_pending', '产物已验收，原投递器仍在处理；脚本等待读回，不重做产物。');
    }
    return decision('agent', 'delivery_readback_required', '已有产物验收通过，只需核对原渠道送达；不得重做业务或盲目补发。', { receiptFile: attempt.receiptFile });
  }
  const dependency = dependencyFailure(origin?.failureReason || task.lastExecution?.error || task.lastError);
  if (dependency?.code === 'codex_account_unavailable') {
    const continuity = snapshot.accountContinuity;
    const observedAt = stamp(continuity?.observedAt);
    const fresh = observedAt && now - observedAt <= 120000 && observedAt <= now + 5000;
    const available = fresh && (continuity.remainingPercent > 0
      || continuity.autoSwitch && continuity.backupCount > 0);
    if (!available) return decision('wait', dependency.code, dependency.summary,
      { identity: 'local-codex', observedAt: continuity?.observedAt || null, fresh: Boolean(fresh) });
    // Dependency recovery permits task-specific acceptance; it does not prove
    // that the original business operation or its delivery succeeded.
  }
  if (dependency && dependency.code !== 'codex_account_unavailable') return decision(dependency.agent ? 'agent' : 'blocked', dependency.code, dependency.summary,
    { identity: [item.id, dependency.code] }, { humanAction: dependency.humanAction });
  const final = requestRecord?.deliveries?.filter(d => d.surfaceKind === 'final') || [];
  return decision('agent', 'task_acceptance_required', '原执行与投递记录已读取；缺少匹配的业务验收证据，需沿原检查点判断和处理。',
    { identity: item.originRunId, originState: origin?.state || null, requestState: requestRecord?.result?.state || null,
      finalDeliveries: final.map(d => ({ state: d.state, externalId: d.externalId || null })) });
}

import { readFile, appendFile, mkdir, open } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { readServiceToken } from '../../lib/auth-config.mjs';
import { createRemoteLabHttpClient } from '../../lib/remotelab-http-client.mjs';
import { readProcessIdentity, isProcessIdentityAlive } from '../../lib/process-identity.mjs';
import { read, save, transact, initialState, ingest, selectBatch, validateResult, commitReview } from './store.mjs';

const filename = fileURLToPath(import.meta.url);
export function resourceDecision(config, resources, ownSessionId = '', now = Date.now()) {
  const no = reason => ({ trigger: false, reason });
  if (resources?.status !== 'ready' || !Array.isArray(resources.sessions)) return no('资源状态待确认');
  for (const session of resources.sessions) {
    const a = session.activity;
    if (!a?.run?.state || !Number.isInteger(a.queue?.count) || !a.compact?.state) return no('资源状态不完整');
    if ((session.id !== ownSessionId && a.run.state !== 'idle') || a.queue.count || a.compact.state !== 'idle') return no('等待前台空闲');
  }
  if (!ownSessionId && (!resources.idleSince || now - Date.parse(resources.idleSince) < config.minIdleSeconds * 1000)) return no('等待连续空闲窗口');
  const h = resources.host;
  if (!Number.isFinite(h?.loadPerCpu) || !Number.isFinite(h?.freeMemoryRatio)
    || h.loadPerCpu > config.maxLoadPerCpu || h.freeMemoryRatio < config.minFreeMemoryRatio) return no('主机负载或内存余量不足');
  return { trigger: true, reason: '资源条件满足' };
}
export function budgetDecision(config, state, now = Date.now()) {
  if (config.enabled === false) return { trigger: false, reason: 'Dreaming 已停用' };
  if (state.active) return { trigger: false, reason: '已有复盘尚未结束' };
  const recent = state.attempts.filter(a => Date.parse(a.at) > now - 86400000);
  if (recent.length >= config.maxDailyAttempts) return { trigger: false, reason: '滚动24小时启动次数已用完' };
  if (recent.reduce((n, a) => n + (a.tokens || 0), 0) >= config.maxDailyObservedTokens) return { trigger: false, reason: '滚动24小时观测用量达到限额' };
  if (recent.some(a => now - Date.parse(a.at) < config.cooldownSeconds * 1000)) return { trigger: false, reason: '等待复盘冷却间隔' };
  return { trigger: true };
}

export async function createWorker(root, dependencies = {}) {
  const config = await read(join(root, 'config.json'));
  for (const key of ['minIdleSeconds', 'maxDailyAttempts', 'maxDailyObservedTokens', 'cooldownSeconds', 'maxRunMs', 'maxBatchChars', 'maxBatchItems']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(config.inputs) || config.inputs.length > 20 || config.inputs.some(i => !i.path?.startsWith('/'))) throw new Error('Explicit absolute material inputs required');
  const client = dependencies.client || createRemoteLabHttpClient({ baseUrl: config.baseUrl, authToken: await readServiceToken(config.authFile) });
  const api = dependencies.api || (async (path, options = {}) => {
    const r = await client.request(path, { ...options, signal: AbortSignal.timeout(7000) });
    if (!r.response.ok || !r.json) throw new Error(`RemoteLab ${r.response.status}: ${path.split('?')[0]}`);
    return r.json;
  });
  const audit = async (kind, data) => {
    await mkdir(root, { recursive: true });
    await appendFile(join(root, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n', { mode: 0o600 });
  };
  const record = async decision => { await save(join(root, 'last-check.json'), { ...decision, at: new Date().toISOString() }); return decision; };
  async function conditions(ownSessionId = '') {
    const resources = (await api('/api/automation/resources')).resources;
    const decision = resourceDecision(config, resources, ownSessionId);
    if (!decision.trigger) return decision;
    const schedules = (await api('/api/schedules')).schedules;
    if (!Array.isArray(schedules)) return { trigger: false, reason: '定时任务状态未知' };
    if (schedules.some(s => s.id !== config.scheduleId && s.enabled && s.gate?.mode === 'direct'
      && s.nextRunAt && Date.parse(s.nextRunAt) <= Date.now() + 15000)) return { trigger: false, reason: '优先执行到期的固定任务' };
    let quota = (await api('/api/codex-auth/rate-limits')).codexUsage;
    if (quota?.status === 'ready' && Date.now() - Date.parse(quota.checkedAt || '') > 600000) quota = (await api('/api/codex-auth/rate-limits?refresh=1')).codexUsage;
    const auth = (await api('/api/codex-auth/status')).codexAuth;
    const age = Date.now() - Date.parse(quota?.checkedAt || '');
    const bucket = quota?.buckets?.find(b => b.id === 'codex');
    const windows = [bucket?.primary, bucket?.secondary].filter(Boolean);
    if (quota?.status !== 'ready' || !Number.isFinite(age) || age < -30000 || age > 600000 || !quota.accountRevision
      || quota.accountRevision !== auth?.accountRevision || !windows.length
      || windows.some(w => !Number.isFinite(w.remainingPercent) || w.remainingPercent <= config.quotaReservePercent)) return { trigger: false, reason: '额度不足或观察尚未确认' };
    return { trigger: true, reason: '前台空闲、主机与额度有余量' };
  }
  async function intake() { return transact(root, s => ingest(root, config, s)); }
  async function gate() {
    let state = await read(join(root, 'state.json'), initialState());
    let d = budgetDecision(config, state);
    if (!d.trigger) return record(d);
    d = await conditions(); if (!d.trigger) return record(d);
    await intake(); state = await read(join(root, 'state.json'));
    const batch = selectBatch(state, config);
    if (!batch.items.length) return record({ trigger: false, reason: '没有新的待复盘材料' });
    return record({ trigger: true, reason: '有新增材料且资源条件满足', dedupeKey: `${batch.id}:${state.attempts.length}` });
  }
  async function identity(runId, sessionId) {
    const run = (await api(`/api/runs/${encodeURIComponent(runId)}`)).run;
    if (!runId || !sessionId || run?.sessionId !== sessionId) throw new Error('Run ownership mismatch');
    return run;
  }
  async function before(runId, sessionId) {
    const run = await identity(runId, sessionId);
    if (run.state !== 'accepted') throw new Error('Expected prepared Run');
    let d = await conditions(sessionId); if (!d.trigger) return record(d);
    const active = await transact(root, async state => {
      if (state.active?.runId === runId) return state.active;
      const budget = budgetDecision(config, state); if (!budget.trigger) throw new Error(budget.reason);
      await ingest(root, config, state);
      const batch = selectBatch(state, config); if (!batch.items.length) throw new Error('No pending material');
      state.active = { runId, sessionId, batch, at: new Date().toISOString() };
      state.attempts.push({ runId, sessionId, at: state.active.at, tokens: 0, state: 'accepted' });
      return state.active;
    });
    // Readiness handshake is required before the Harness can launch.
    const guardPath = join(root, `guard-${runId}.json`);
    const priorGuard = await read(guardPath, null);
    let guard;
    if (!priorGuard?.birth || !await isProcessIdentityAlive(priorGuard)) {
      const log = await open(join(root, `guard-${runId}.log`), 'a', 0o600);
      try {
        guard = spawn(process.execPath, [filename, root, 'guard', runId, sessionId], { detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } });
        guard.unref();
      } finally { await log.close(); }
      await save(guardPath, await readProcessIdentity(guard.pid));
    }
    const readyPath = join(root, `ready-${runId}.json`);
    const ready = await new Promise((resolveReady, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); fn(value); };
      const inspect = () => read(readyPath, null).then(r => { if (r && r.pid === (guard?.pid || priorGuard.pid)) finish(resolveReady, r); }).catch(e => finish(reject, e));
      const watcher = watch(root, () => { void inspect(); });
      const timer = setTimeout(() => finish(reject, new Error('Resource guard readiness timeout; inspect guard log')), 12000);
      guard?.once('error', e => finish(reject, e)); void inspect();
    });
    await audit('before_launch', { runId, batchId: active.batch.id, decision: ready });
    return ready;
  }
  async function after(runId, sessionId) {
    const run = await identity(runId, sessionId);
    if (!['completed', 'cancelled', 'failed'].includes(run.state)) throw new Error('Run is not terminal');
    const usage = await api(`/api/usage/summary?days=2&sessionId=${encodeURIComponent(sessionId)}&top=1`);
    await transact(root, async state => {
      let attempt = state.attempts.find(a => a.runId === runId);
      // A rejected preflight is still an admission and consumes the daily attempt budget.
      if (!attempt) { attempt = { runId, sessionId, at: run.createdAt || new Date().toISOString() }; state.attempts.push(attempt); }
      attempt.tokens = Math.max(attempt.tokens || 0, usage.totals?.totalTokens || 0); attempt.state = run.state;
      if (state.active?.runId !== runId) return;
      const staged = await read(join(root, `result-${runId}.json`), null);
      if (run.state === 'completed' && staged) await commitReview(root, state, state.active, staged);
      else attempt.reason = staged ? '执行未成功结束，保留材料和中间结果' : '没有通过验证的结果，保留材料';
      state.active = null;
    });
    await audit('terminal', { runId, state: run.state, tokens: usage.totals?.totalTokens || 0 });
    return { trigger: true };
  }
  async function claim(runId, sessionId) {
    const run = await identity(runId, sessionId), state = await read(join(root, 'state.json'));
    if (!['accepted', 'running'].includes(run.state) || state.active?.runId !== runId || state.active.sessionId !== sessionId) throw new Error('No owned material batch');
    const d = await conditions(sessionId); if (!d.trigger) return { proceed: false, reason: d.reason };
    return { proceed: true, ...state.active.batch, output: join(root, `draft-${runId}.json`),
      existingMemoryPaths: config.memoryPaths, resultSchema: { batchId: state.active.batch.id, finding: '结论与证据限制',
        reviewedIds: state.active.batch.items.map(i => i.id), candidates: [{ kind: 'method|project|personal', change: '具体改进', overlap: '与已有规则关系', destination: '对应现行入口', validation: '后续如何验证', evidenceIds: ['材料ID'] }],
        validations: [{ candidateId: '已有候选ID', status: 'supported|rejected|pending', reason: '后续真实证据支持什么', evidenceIds: ['本批新增材料ID'] }] } };
  }
  async function finish(runId, sessionId) {
    const run = await identity(runId, sessionId);
    if (run.state !== 'running') throw new Error('Run no longer running');
    if (await read(join(root, `stop-${runId}.json`), null)) throw new Error('Yield requested; retain draft only');
    const d = await conditions(sessionId); if (!d.trigger) throw new Error(d.reason);
    const result = await read(join(root, `draft-${runId}.json`));
    await transact(root, async state => {
      if (state.active?.runId !== runId || state.active.sessionId !== sessionId) throw new Error('Batch owner changed');
      validateResult(result, state.active.batch);
      await save(join(root, `result-${runId}.json`), result);
    });
    return { staged: true, message: '结构和来源引用通过；原生执行成功结束后才提交复盘记录。' };
  }
  async function guard(runId, sessionId) {
    const state = await read(join(root, 'state.json'));
    if (state.active?.runId !== runId || state.active.sessionId !== sessionId) throw new Error('Guard owner changed');
    let stopped = false, cancelling = false, checking = false, again = false, socket, ready = false;
    const finishGuard = () => { stopped = true; clearTimeout(deadline); clearTimeout(connection); clearTimeout(cancelDeadline); socket?.close(); };
    let cancelDeadline;
    const stop = async reason => {
      if (cancelling || stopped) return; cancelling = true;
      await save(join(root, `stop-${runId}.json`), { reason, at: new Date().toISOString() });
      await audit('yield_requested', { runId, reason });
      // Even if cancellation cannot be confirmed, leave active ownership intact.
      cancelDeadline = setTimeout(() => { void audit('cancellation_unconfirmed', { runId }).finally(finishGuard); }, 30000);
      await api(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} }).catch(e => audit('cancel_error', { runId, error: e.message }));
    };
    const inspect = async () => {
      if (stopped) return;
      if (checking) { again = true; return; } checking = true;
      try {
        const run = await identity(runId, sessionId);
        if (['completed', 'failed', 'cancelled'].includes(run.state)) { finishGuard(); return; }
        if (cancelling) return;
        const d = await conditions(sessionId);
        if (!ready) { ready = true; await save(join(root, `ready-${runId}.json`), { ...d, pid: process.pid }); }
        if (!d.trigger) await stop(d.reason);
      } catch (e) { await audit('guard_error', { runId, error: e.message }); await stop('资源观察失败，停止本轮复盘'); }
      finally { checking = false; if (again && !stopped) { again = false; void inspect(); } }
    };
    const deadline = setTimeout(() => { void stop('达到单轮时长限制'); }, Math.max(1, Date.parse(state.active.at) + config.maxRunMs - Date.now()));
    const connection = setTimeout(() => { void stop('资源通知连接未建立'); }, 7000);
    try {
      const cookie = await client.ensureAuthCookie(AbortSignal.timeout(7000));
      socket = new WebSocket(config.baseUrl.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: cookie } });
      socket.on('open', () => { clearTimeout(connection); void inspect(); });
      socket.on('message', raw => { try { const e = JSON.parse(raw.toString());
        if (['session_invalidated', 'sessions_invalidated'].includes(e.type) || e.sessionId === sessionId) void inspect(); } catch {} });
      socket.on('close', () => { if (!stopped) void stop('资源通知连接中断'); });
      socket.on('error', () => { void stop('资源通知连接异常'); });
    } catch (e) { await stop(e.message); }
  }
  return { config, api, intake, gate, before, after, claim, finish, guard, conditions, audit };
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  const [, , rootArg, command, runArg, sessionArg] = process.argv;
  if (!rootArg || !command) throw new Error('Usage: runner.mjs <instance-state-dir> intake|gate|before|after|guard|claim|finish|status');
  const root = resolve(rootArg), worker = await createWorker(root);
  const runId = runArg || process.env.REMOTELAB_RUN_ID, sessionId = sessionArg || process.env.REMOTELAB_SESSION_ID;
  try {
    const result = command === 'status' ? { state: await read(join(root, 'state.json'), initialState()), check: await read(join(root, 'last-check.json'), null) }
      : await worker[command](runId, sessionId);
    if (command !== 'guard') console.log(JSON.stringify(result));
  } catch (error) {
    await worker.audit('error', { command, runId, error: error.message });
    if (['gate', 'before', 'after'].includes(command)) console.log(JSON.stringify({ trigger: false, reason: error.message }));
    else { console.error(error.message); process.exitCode = 1; }
  }
}

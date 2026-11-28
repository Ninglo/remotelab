import { latencyFacts } from './feishu-delivery-latency.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { readRecord } from './durable-records.mjs';
import { runtimeHrPolicy } from './hr-policy.mjs';
import { sqliteState } from './sqlite-state.mjs';

export const RECENT_ERROR_SOURCES = Object.freeze({
  'feishu-inbox': '飞书输入处理', 'request-prepare': '请求准备与启动', 'run-result': '会话执行',
  'source-delivery': '消息投递', 'schedule-gate': '后台定时检查', 'service-exit': '服务异常退出',
});
export const FEISHU_ADMISSION_BUDGET_MS = 30_000;
export const FEISHU_ADMISSION_TIMEOUT = 'Feishu task admission receipt not confirmed within 30s';
export const FEISHU_REPLY_UNASSIGNED = 'Required Feishu input ended without a saved reply or handoff';
const rules = [
  ...Object.entries(latencyFacts).map(([key,[diagnostic,label]]) => [new RegExp(`^${diagnostic}$`), `feishu-slow-${key}`, label]),
  [/^Feishu task admission receipt not confirmed within 30s$/, 'feishu-admission-deadline', '飞书任务受理回执超时'],
  [/^Required Feishu input ended without a saved reply or handoff$/, 'feishu-reply-unassigned', '飞书消息未结算答复'],
  [/javascript_heap_oom|heap out of memory/i, 'js-oom', 'JavaScript 堆内存耗尽'],
  [/\bos_oom\b|oom-kill/i, 'os-oom', '系统内存不足终止进程'],
  [/\babnormal_exit\b/i, 'exit', '服务异常退出（原因待核）'],
  [/\bfatal_error\b/i, 'fatal', '服务运行时致命错误'],
  [/\binterrupted_inbox_attempt\b/i, 'interrupted', '处理输入时进程中断'],
  [/^Sender lease expired without a receipt$/i, 'no-receipt', '发送后未收到回执'],
  [/serveroverloaded|at capacity/i, 'overload', '模型服务过载'],
  [/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b/i, 'network-timeout', '网络连接超时'],
  [/\bECONNRESET\b/i, 'network-reset', '网络连接被重置'],
  [/\bEAI_AGAIN\b/i, 'dns-retry', 'DNS 临时解析失败'],
  [/\bSQLITE_BUSY\b/i, 'sqlite-busy', '数据库写入繁忙'],
  [/\bENOSPC\b/i, 'no-space', '存储空间不足'],
  [/\bENOENT\b/i, 'missing-file', '文件或程序不存在'],
];
const hash = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const iso = value => value ? new Date(value).toISOString() : null;
const eventView = e => ({ ...e, at: iso(e.at) });
const publicRow = r => ({ ...r, firstAt: iso(r.firstAt), lastAt: iso(r.lastAt), openedAt: iso(r.openedAt), fixedAt: iso(r.fixedAt),
  ...(r.events ? { events: r.events.map(eventView) } : {}) });

// Known Gate mechanisms deliberately ignore query labels and task identity.
// Match the producer's complete syntax, not arbitrary mentions of a timeout.
export function errorSignature(source, component, line, basis = null) {
  if (source === 'schedule-gate') {
    line = String(line || '').trim();
    const deadline = /^Gate timed out after ([1-9]\d{0,3})s$/.exec(line);
    const exit = /^Gate exited with ([1-9]\d{0,2}): (.+)$/.exec(line);
    const suffix = 'query timed out; owned process group terminated';
    let query = false;
    if (exit) {
      let detail = exit[2];
      if (detail.startsWith('{')) {
        try {
          const payload = JSON.parse(detail);
          detail = payload?.type === 'GateError' ? payload.message : null;
        } catch { detail = null; }
      }
      query = typeof detail === 'string' && (detail === suffix || detail.endsWith(`: ${suffix}`));
    }
    if (deadline || query) {
      const label = deadline ? '定时任务前置检查超时' : `Gate exited with ${exit[1]}: ${suffix}`;
      const mechanism = deadline ? 'gate-deadline' : `gate-query-timeout:${exit[1]}`;
      return { cluster: hash('v2', source, mechanism), label, identifiable: true, mechanism,
        ...(deadline ? { timeoutSeconds: Number(deadline[1]) } : {}) };
    }
  }
  return basis ? { cluster: hash('v2', source, component, ...basis) } : null;
}

export function describeRecentError(source, error, operation, component = '') {
  const code = String(error?.code || '').slice(0, 80);
  const message = String(error?.message || (typeof error === 'string' ? error : '')).slice(0, 1024).split(/\r?\n/, 1)[0].trim();
  const known = errorSignature(source, component, message);
  if (known) return known;
  const normalized = message.toLowerCase()
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b|\b[\da-f]{16,}\b/g, '<id>')
    .replace(/\b(?:run_|req_|lease_|om_)[\w-]+\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}t\S+/g, '<time>')
    .replace(/\s+/g, ' ');
  const rule = rules.find(([re]) => re.test(`${code} ${message}`.trim()));
  const category = rule?.[1] || 'unclassified';
  const label = rule?.[2] || '未分类报错';
  const identifiable = Boolean(rule || (normalized && !/^(?:error|failed|failure|delivery failed|unknown(?: error)?|unknown failure|gate execution failed)$/i.test(normalized)));
  // Classify independently of display redaction, so existing signatures stay
  // stable and common labels do not collapse unrelated failures.
  const basis = rule && ['js-oom','os-oom','exit','fatal','interrupted','no-receipt','overload'].includes(category)
    ? [category] : identifiable ? [category, code.toLowerCase(), normalized] : ['missing-evidence', operation];
  return { ...errorSignature(source, component, message, basis), label, identifiable };
}

// Keep the emitted diagnostic sentence, not the command, shell output, stack
// or request object. Redact before persisting and render only as literal text.
export function recentErrorExcerpt(error) {
  const message = error?.message || (typeof error === 'string' ? error : '');
  if (typeof message !== 'string') return null;
  const first = message.slice(0, 8192).split(/[\r\n\u2028\u2029]/, 1)[0].trim();
  if (!first) return null;
  const text = first
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\b(command failed(?: with exit code \d+)?\s*:)\s*.+$/i, '$1 [命令及参数省略]')
    .replace(/-----BEGIN .*PRIVATE KEY-----.*$/i, '[已脱敏私钥]')
    .replace(/\b((?:set-)?cookie|(?:proxy-)?authorization)\s*["']?\s*[:=].*$/i, '$1: [已脱敏]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[已脱敏凭据]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try { const url = new URL(value); return `${url.protocol}//${url.host}/[路径及参数省略]`; }
      catch { return '[已脱敏 URL]'; }
    })
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|token|password|passwd|secret|初始密码|登录密码|密码|令牌|密钥)\s*["']?\s*[:=：]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,"';<>]+)/gi, '$1[已脱敏]')
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[\w-]+/gi, '[已脱敏令牌]')
    .replace(/\b[A-Za-z0-9_+/-]{32,}(?:\.[A-Za-z0-9_+/-]+)*\b/g, '[已脱敏字串]');
  return text.length > 480 ? `${text.slice(0, 480)}…` : text;
}

export function createRecentErrorMonitor({ file = join(CONFIG_DIR, 'recent-errors'), now = Date.now } = {}) {
  const call = (action, args = {}) => sqliteState(file, 'recent-errors', { action, now: now(), ...args });
  return {
    record(source, { operation, attempt = '1', error, diagnostic = error, at = now(), sessionId, component, reference, exitSignal, gateTimeoutSeconds } = {}) {
      if (!Object.hasOwn(RECENT_ERROR_SOURCES, source) || !operation || !attempt) throw new TypeError('Recent error requires a known producer and occurrence identity');
      const timestamp = typeof at === 'number' ? at : Date.parse(at);
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now()+60_000) throw new TypeError('Invalid error timestamp');
      return call('record', { event: { ...describeRecentError(source, error, operation, component), source,
        operation: hash(source, operation), id: hash(source, operation, attempt), at: timestamp,
        exitSignal: source==='service-exit' && /^[A-Z][A-Z0-9]{0,12}$/.test(exitSignal || '') ? exitSignal : null,
        gateTimeoutSeconds: source==='schedule-gate' && Number.isInteger(gateTimeoutSeconds) && gateTimeoutSeconds>=1 && gateTimeoutSeconds<=30 ? gateTimeoutSeconds : null,
        excerpt: recentErrorExcerpt(diagnostic),
        sessionId: /^[a-z0-9_]{1,80}$/i.test(sessionId || '') ? sessionId : null,
        reference: /^[a-z0-9_-]{1,80}$/i.test(reference || '') ? reference : null } });
    },
    async list({ before = 0, samples = false } = {}) {
      const result = await call('list', { before, samples });
      return { ...result, windowDays: 7, escalationHours: 24, threshold: 3, retentionDays: 30,
        sources: Object.entries(RECENT_ERROR_SOURCES).map(([id, label]) => ({ id, label, firstObservedAt: iso(result.sources.find(s => s.source === id)?.firstAt) })),
        rows: result.rows.map(publicRow) };
    },
    async detail(cluster, { before = 0 } = {}) {
      const result = await call('detail', { cluster, before });
      return result && { ...result, next: result.eventsNext, cluster: publicRow(result.cluster), events: result.events.map(eventView) };
    },
    sourceSession(id) { return call('source-session', { event: { id } }); },
    trackRepairs(repairs) { return call('track-repairs', { repairs }); },
    repairReports(repairs,until) { return call('repair-reports', { repairs,until }); },
    digestWindow({ since, until }) { return call('digest-window', { since, until }); },
    digestState(target, date) { return call('digest-state', { target, alertId:date }); },
    digestClaim(target, date, since, until, body) { return call('digest-claim', { target, alertId:date, since, until, body }); },
    digestTransition(target, date, expected, transition, values = {}) {
      return call('digest-transition', { ...values, target, alertId:date, expected, transition });
    },
    alertJobs({ since, target }) { return call('alert-jobs', { since, target }); },
    alertTransition(target, alertId, expected, transition, values = {}) {
      return call('alert-transition', { ...values, target, alertId, expected, transition });
    },
    fix(cluster, { version, commit, verification, personId }) {
      return call('fix', { cluster, version, commit, verification, personId });
    },
  };
}

export const recentErrors = createRecentErrorMonitor();
let enablement;
export function recentErrorsConfig(now = Date.now()) {
  if (runtimeHrPolicy()?.restrictedRuntime) return Promise.resolve(null);
  if (!enablement || now >= enablement.expiresAt) {
    enablement = { expiresAt: now+15_000, read: readRecord(join(CONFIG_DIR, 'recent-errors.json')) };
  }
  return enablement.read;
}
export async function recentErrorsEnabled() {
  return (await recentErrorsConfig())?.enabled === true;
}
const lastFailure = new Map();
// Instrumentation must not turn a monitoring outage into an input/outbox retry.
// The bounded warning intentionally omits both the original and SQLite error text.
export async function observeRecentError(source, event) {
  try {
    if (await recentErrorsEnabled()) return await recentErrors.record(source, event);
    return false;
  } catch {
    const now = Date.now();
    if (now - (lastFailure.get(source) || 0) >= 60_000) {
      lastFailure.set(source, now);
      console.error(`[recent-errors] could not persist ${source} observation`);
    }
    return false;
  }
}

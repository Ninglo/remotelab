// Pure projection of existing summaries. No I/O, timers, model calls or globals.
const MINUTE = 60_000;
export const DEFAULT_POLICY = Object.freeze({
  maxAgeMs: 24 * 60 * MINUTE,
  dwellMs: MINUTE,
  attentionRepeatMs: 30 * MINUTE,
  restIntervalMs: 90 * MINUTE,
  restDisplayMs: 30_000,
});
export const TIME_LABEL = '对话更新';
const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const count = value => [...value].length;

// Reject whole items rather than removing negations, qualifications or code fragments.
// These filters reduce known metadata noise; they cannot certify a model-written fact.
const NOISE = [
  /(?:用户|本人|对方).{0,14}(?:取消|撤回|跳过|忽略).{0,10}(?:问题|提问|请求|确认|操作)/i,
  /(?:问题|提问).{0,10}(?:已取消|已撤回|已失效|被取消|被跳过)/i,
  /(?:用户|本人).{0,8}(?:要求|希望|补充|回复|授权).{0,12}(?:继续|停止|提问|确认|操作|任务)/i,
  /^(?:无|暂无|没有|无需|不需要)(?:待确认项|待办|待处理事项|补充信息|新输入|问题|人工操作)[。！]?$/,
  /(?:无需|不需要|不用|没有|暂无|无须).{0,10}(?:用户|本人|人工).{0,10}(?:确认|输入|补充|处理|操作)/i,
  /(?:用户|本人).{0,8}(?:无需|不需要|不用).{0,10}(?:确认|输入|补充|处理|操作)/i,
  /(?:agent|harness|codex|进程|模型|运行器).{0,18}(?:退出|结束|终止|完成|停止|取消)/i,
  /(?:run|session|会话|进程).{0,8}(?:idle|running|waiting|排队|空闲|运行中|结束)/i,
  /\d+\s*(?:个|项|条)\s*(?:session|会话|进程)/i,
  /(?:request_user_input|tool_call|tool_result|nativeDispatch|exit_code|analysis channel)/i,
  /(?:user.{0,12}(?:cancelled|canceled|dismissed)|(?:agent|process|model).{0,12}(?:exited|terminated|finished))/i,
  /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|密码|令牌|密钥)\s*[:=：]\s*\S+)/i,
  /(?:token|令牌|密钥|accessToken|refreshToken|appSecret)/i,
  /(?:https?:\/\/|file:\/\/|\/(?:home|Users|tmp|etc|var|opt|mnt|root)\/|~\/|[A-Za-z]:\\|(?:^|\s)\.{1,2}\/)/,
  /(?:[\w.-]+\/)+[\w.-]+\.(?:mjs|js|ts|py|json|md|sh|yaml|yml)\b/i,
  /(?:```|`|<[^>]*>|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\u2026|\.{3})/,
  /[A-Za-z0-9_/-]{36,}/,
];

export function usableSummaryText(value) {
  const sentence = clean(value);
  return sentence && count(sentence) <= 60 && !NOISE.some(rule => rule.test(sentence)) ? sentence : null;
}

export function sourceTimeMs(value) {
  if (Number.isFinite(value) && value > 0) return value; // Native summaries can use epoch ms.
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value);
}

const scopeKey = options => JSON.stringify([options.personId, [...options.identityIds].sort()]);
const itemKey = item => JSON.stringify([item.sessionId, item.kind, item.sentence]);
const quiet = () => ({ kind: 'quiet', subject: '大肥鱼', sentence: '我在这儿，陪你慢慢来。', observedAt: null, label: '' });
const rest = () => ({ kind: 'rest', subject: '歇一小会儿', sentence: '看看远处，喝口水吧。', observedAt: null, label: '休息提醒' });
function context(options, nowMs) {
  if (!options?.personId || !(options.identityIds instanceof Set) || !options.identityIds.size) {
    throw new TypeError('personId and the current Person’s non-empty identityIds Set are required');
  }
  if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite');
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  for (const value of Object.values(policy)) if (!Number.isFinite(value) || value <= 0) throw new TypeError('Invalid policy');
  return policy;
}

/** Only active waiting + needsFromUser, or explicitly idle + knownConclusions.
 * A summary time is the latest assistant message time, NOT the time a claim arose.
 * The caller supplies a complete snapshot from its existing summary reader.
 */
export function observationCandidates(sessions, options, nowMs = Date.now()) {
  const policy = context(options, nowMs);
  const candidates = [], seen = new Set();
  for (const session of sessions || []) {
    if (!session || session.archived || session.internalRole
      || !options.identityIds.has(clean(session.initiatedByIdentityId)) || !clean(session.id)) continue;
    const at = sourceTimeMs(session.lastAssistantMessageAt);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at >= policy.maxAgeMs) continue;
    const run = session.activity?.run;
    // Never promote workflowState, an exited process, missing activity or a queued run.
    const waiting = run?.state === 'running' && run.waiting === true && run.cancelRequested !== true;
    const idle = run?.state === 'idle' && run.waiting !== true && !(session.activity?.queue?.count > 0)
      && session.activity?.compact?.state !== 'pending';
    if (!waiting && !idle) continue;
    const kind = waiting ? 'attention' : 'result';
    const items = waiting ? session.workSummary?.needsFromUser : session.workSummary?.knownConclusions;
    if (!Array.isArray(items)) continue;
    const subject = usableSummaryText(session.name);
    if (!subject) continue;
    for (const value of items) {
      const sentence = usableSummaryText(value);
      if (!sentence) continue;
      const item = { kind, subject: [...subject].slice(0, 30).join(''), sentence,
        observedAt: new Date(at).toISOString(), label: TIME_LABEL, sessionId: session.id,
        source: { type: 'session-summary', field: waiting ? 'workSummary.needsFromUser' : 'workSummary.knownConclusions',
          timeField: 'lastAssistantMessageAt', ref: `/api/sessions/${encodeURIComponent(session.id)}?view=summary` } };
      item.key = itemKey(item);
      if (!seen.has(item.key)) { seen.add(item.key); candidates.push(item); }
    }
  }
  return candidates.sort((a, b) => (a.kind === 'attention' ? 0 : 1) - (b.kind === 'attention' ? 0 : 1)
    || Date.parse(b.observedAt) - Date.parse(a.observedAt)
    || a.key.localeCompare(b.key, 'zh-CN'));
}

/** Stateless first choice. For “new”/cooldowns across requests use advanceObservation. */
export function selectObservation(sessions, options, nowMs = Date.now()) {
  return observationCandidates(sessions, options, nowMs)[0] || quiet();
}

/** Persist the returned state per Person on the server, never per rendering frame.
 * Same sentence in the same Session is deduplicated even if its message time changes.
 * Caller state is immutable; source omission/retraction stops an active display.
 */
export function advanceObservation(sessions, options, previousState = null, nowMs = Date.now()) {
  const policy = context(options, nowMs), scope = scopeKey(options);
  const restEnabled = options.restEnabled !== false;
  const validState = previousState?.version === 1 && previousState.scope === scope && previousState.lastNowMs <= nowMs;
  const state = validState ? structuredClone(previousState) : {
    version: 1, scope, seen: {}, current: null, restStartedAt: null, lastRestAt: null,
  };
  state.lastNowMs = nowMs;
  if (!restEnabled) state.restStartedAt = null;
  else if (state.restStartedAt === null) state.restStartedAt = nowMs;
  const candidates = observationCandidates(sessions, options, nowMs);
  // Remove keys no longer in the source after a 7-day retention horizon.
  for (const [key, entry] of Object.entries(state.seen)) {
    if (nowMs - entry.at > 7 * 24 * 60 * MINUTE && !candidates.some(item => item.key === key)) delete state.seen[key];
  }
  const eligible = candidates.filter(item => !state.seen[item.key]
    || item.kind === 'attention' && nowMs - state.seen[item.key].at >= policy.attentionRepeatMs);
  const current = candidates.find(item => item.key === state.current?.key);
  const newAttention = eligible.find(item => item.kind === 'attention');
  if (current && nowMs < state.current.until && !(current.kind !== 'attention' && newAttention)) {
    return { observation: current, state };
  }
  const next = eligible[0];
  if (next) {
    state.seen[next.key] = { at: nowMs };
    state.current = { key: next.key, until: nowMs + policy.dwellMs };
    return { observation: next, state };
  }
  if (restEnabled && state.current?.key === '__rest' && nowMs < state.current.until) {
    return { observation: rest(), state };
  }
  const hour = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(nowMs));
  if (restEnabled && !candidates.some(item => item.kind === 'attention') && hour >= 9 && hour < 21
    && nowMs - Math.max(state.restStartedAt, state.lastRestAt || 0) >= policy.restIntervalMs) {
    state.lastRestAt = nowMs;
    state.current = { key: '__rest', until: nowMs + policy.restDisplayMs };
    return { observation: rest(), state };
  }
  state.current = null;
  return { observation: quiet(), state };
}

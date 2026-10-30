import { subscriptionAvailability } from './codex-accounts.mjs';

// Use only this instance's saved authorizations, never the fleet inventory.
export function accountContinuity(runtime, now = Date.now(), policy = {}) {
  const accounts = runtime?.accounts || [];
  const current = accounts.find(a => a.id === runtime.activeId);
  if (!current || current.account?.type !== 'chatgpt') return null;
  const remaining = a => subscriptionAvailability(a.usage, '', now) === 'unknown' ? null
    : Math.min(...a.usage.buckets.filter(b => b.id === 'codex')
      .flatMap(b => [b.primary, b.secondary]).filter(Boolean).map(w => w.remainingPercent));
  const balance = remaining(current);
  const backups = accounts.filter(a => a.id !== current.id && a.account?.type === 'chatgpt'
    && (!current.identityId || a.identityId !== current.identityId)
    && !(a.blockedUntil > now) && remaining(a) > 10);
  const exhausted = current.blockedUntil > now || balance === 0;
  const status = balance === null && !exhausted ? 'unknown'
    : runtime.autoSwitch && backups.length ? (balance <= 10 || exhausted ? 'switch_pending' : 'ready')
    : exhausted || balance <= 20 ? (runtime.autoSwitch ? 'no_backup' : 'switch_disabled') : 'preparing';
  const threshold = policy.lastAccountWarningPercent;
  let lastAccountWarning;
  if (Number.isFinite(threshold) && threshold > 10 && threshold <= 100) {
    const identities = new Map();
    for (const account of accounts.filter(a => a.account?.type === 'chatgpt')) {
      const key = account.identityId || account.id;
      const candidate = { account, remainingPercent: account.blockedUntil > now ? 0 : remaining(account) };
      const prior = identities.get(key);
      if (!prior || candidate.remainingPercent !== null && (prior.remainingPercent === null
        || Date.parse(account.usage?.checkedAt) > Date.parse(prior.account.usage?.checkedAt))) identities.set(key, candidate);
    }
    const pool = [...identities.values()];
    const unknownCount = pool.filter(a => a.remainingPercent === null).length;
    const usable = pool.filter(a => a.remainingPercent > 10);
    const last = usable.length === 1 ? usable[0] : usable.length === 0
      ? pool.filter(a => a.remainingPercent !== null).sort((a,b) => b.remainingPercent-a.remainingPercent)[0] : null;
    lastAccountWarning = { threshold, reservePercent: 10, usableAccountCount: usable.length, unknownCount,
      state: unknownCount || !pool.length ? 'unknown' : last && last.remainingPercent <= threshold ? 'low' : 'ready',
      account: last ? { id: last.account.id, label: last.account.label || '当前账号' } : null,
      remainingPercent: last?.remainingPercent ?? null, observedAt: last?.account.usage?.checkedAt || null };
  }
  return { status: lastAccountWarning?.state === 'low' ? 'last_account_low' : status,
    ...(lastAccountWarning ? { lastAccountWarning } : {}), autoSwitch: runtime.autoSwitch === true, remainingPercent: balance,
    reservePercent: 10, preparePercent: 20, backupCount: backups.length,
    current: { id: current.id, label: current.label || '当前账号' },
    backups: backups.map(a => ({ id: a.id, label: a.label || '已登录备用账号', remainingPercent: remaining(a) })),
    lastSwitch: runtime.lastSwitch || null, observedAt: current.usage?.checkedAt || null };
}

export function continuityAttention(value) {
  if (value?.lastAccountWarning?.state === 'low') {
    const warning = value.lastAccountWarning;
    return [{ kind: 'accountContinuity', id: 'local-codex', subject: '账号池额度预警',
      severity: warning.remainingPercent === 0 ? 'critical' : 'warning',
      detail: '账号即将耗尽，请准备重置或购入新账号。',
      action: { risk: 'low', requiresConfirmation: false, summary: '请准备重置或购入新账号。' } }];
  }
  if (!value || ['ready', 'preparing'].includes(value.status)) return [];
  const details = {
    unknown: '当前账号额度无法核实，先检查现有采集和登录；未知额度不当作耗尽，也不擅自换账号。',
    switch_pending: '当前账号已到预留线且有已登录备用，后台应切换后续请求；持续未切换时检查切换器，保留在途任务。',
    no_backup: '当前账号进入备用准备区，但本实例没有额度高于10%的已登录备用。可等待重置，或由人选择并登录已获授权的新账号；不自动购买或借用其他实例账号。',
    switch_disabled: '当前账号进入备用准备区，自动切换尚未启用。需要确认是否启用本实例已登录账号间的切换。',
  };
  return [{ kind: 'accountContinuity', id: 'local-codex', subject: '本实例账号连续性',
    severity: value.remainingPercent === 0 ? 'critical' : 'warning', detail: details[value.status],
    action: { risk: ['no_backup', 'switch_disabled'].includes(value.status) ? 'medium' : 'low',
      requiresConfirmation: ['no_backup', 'switch_disabled'].includes(value.status),
      summary: details[value.status] } }];
}

export function diskRiskStage(item) {
  if (item?.kind !== 'disk') return 0;
  if (item.availableBytes < 5 * 1024 ** 3 || item.usedPercent >= 99.5 || item.inodeUsedPercent >= 99) return 4;
  if (item.availableBytes < 20 * 1024 ** 3 || item.usedPercent >= 97 || item.inodeUsedPercent >= 97) return 3;
  return item.severity === 'critical' ? 2 : item.severity === 'warning' ? 1 : 0;
}

// A plan describes an action's risk, not the incident's severity. It grants no
// execution permission. Human confirmation remains in the original Session.
export function recoveryPlan(value) {
  if (!value || !['low', 'medium', 'high'].includes(value.risk)) return null;
  // Older recovery writers used a flat object for concrete target identifiers.
  // Accept that losslessly as readable text; do not accept arbitrary nested data
  // or weaken the required steps/impact/rollback/verification contract.
  const target = value.target;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const entries = Object.entries(target);
    if (!entries.length || entries.length > 20 || !entries.every(([key, val]) => key.trim()
      && (typeof val === 'string' && val.trim() || typeof val === 'number' && Number.isFinite(val)))) return null;
    value = { ...value, target: entries.map(([key, val]) => `${key}: ${val}`).join('; ') };
  }
  const fields = ['summary', 'target', 'impact', 'rollback', 'verification'];
  if (!fields.every(key => typeof value[key] === 'string' && value[key].trim())) return null;
  return Object.fromEntries([['risk', value.risk], ['requiresConfirmation', value.risk !== 'low'],
    ...fields.map(key => [key, value[key].trim().slice(0, 1200)])]);
}


// Human assistance describes what to provide, never an authorization receipt.
export function recoveryHumanAction(value) {
  if (!value || !['approval', 'input'].includes(value.type)
    || typeof value.summary !== 'string' || !value.summary.trim()) return null;
  return { type: value.type, summary: value.summary.trim().slice(0, 240) };
}

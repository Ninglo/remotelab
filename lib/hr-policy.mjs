import { readFile, stat } from 'node:fs/promises';
import { queryHrService } from './hr-policy-client.mjs';

const cache = new Map();
let runtime = null;
let refreshing;
export async function loadConfiguredHrPolicy(config) {
  if (config.hrPolicyRegistry) {
    const result = await queryHrService(config.hrPolicyRegistry, {action:'policy_read', question:'current policy'});
    if (result.policyVersion !== 1) throw new Error('Invalid HR policy response');
    return validateHrPolicy(result.policy);
  }
  return config.hrPolicyPath ? loadHrPolicy(config.hrPolicyPath) : null;
}
export function refreshRuntimeHrPolicy() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const configPath = process.env.REMOTELAB_REQUEST_ACCESS_GUARD;
    if (!configPath) { runtime = null; return null; }
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!config.hrPolicyRegistry && !config.hrPolicyPath) { runtime = null; return null; }
    const base = {instance:config.hrInstance, enforceAfter:config.hrEnforceAfter,
      restrictedRuntime:config.hrRestrictedRuntime === true, registry:config.hrPolicyRegistry};
    try { runtime = {...base, policy:await loadConfiguredHrPolicy(config)}; }
    catch (error) { runtime = {...base, policy:null, unavailable:true}; throw error; }
    return runtime;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
export function runtimeHrPolicy() { return runtime; }

// Session/history checks are synchronous; initialise before accepting traffic.
await refreshRuntimeHrPolicy().catch(() => {});
export function validateHrPolicy(policy) {
  if (policy?.schema !== 1 || !policy.version || !policy.roles || !Array.isArray(policy.subjects))
    throw new Error('Invalid HR policy');
  const ids = new Set(), bindings = new Set();
  for (const subject of policy.subjects) {
    if (!subject.id || ids.has(subject.id) || !Array.isArray(subject.roles)
        || subject.roles.some(role => !Object.hasOwn(policy.roles, role))) throw new Error('Invalid HR subject');
    ids.add(subject.id);
    for (const binding of subject.bindings || []) {
      const key = binding.kind === 'feishu'
        ? JSON.stringify(['feishu', binding.route, binding.tenant, binding.openId])
        : JSON.stringify(['web', binding.instance, binding.personId, binding.identityId]);
      if (!['web', 'feishu'].includes(binding.kind) || bindings.has(key)
          || (binding.kind === 'feishu' ? !binding.route || !binding.tenant || !binding.openId
            : !binding.instance || !binding.personId || !binding.identityId)) throw new Error('Invalid HR binding');
      bindings.add(key);
    }
  }
  return policy;
}

export async function loadHrPolicy(path) {
  if (!path) return null;
  const info = await stat(path);
  const key = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  const cached = cache.get(path);
  if (cached?.key === key) return structuredClone(cached.policy);
  const policy = validateHrPolicy(JSON.parse(await readFile(path, 'utf8')));
  cache.set(path, { key, policy });
  return structuredClone(policy);
}

export function resolveHrActor(policy, options = {}, instance = '') {
  if (!policy) return null;
  const source = options.sourceContext || {};
  let match;
  if (options.feishuConnectorAuthenticated === true && source.connector === 'feishu') {
    if (source.sender?.senderType !== 'user') return null;
    match = binding => binding.kind === 'feishu' && binding.route === source.sourceRouteId
      && binding.tenant === source.tenantKey && binding.openId === source.sender.openId
      && (!source.appId || !binding.appId || source.appId === binding.appId);
  } else {
    if (!options.viewPersonId || !options.initiatedByIdentityId) return null;
    const shared = (policy.sharedWeb || []).find(binding => binding.instance === instance
      && binding.personId === options.viewPersonId && binding.identityId === options.initiatedByIdentityId);
    if (shared) return { id: 'shared-web', roles: [], shared: true, active: true };
    match = binding => binding.kind === 'web' && binding.instance === instance
      && binding.personId === options.viewPersonId && binding.identityId === options.initiatedByIdentityId;
  }
  return policy.subjects.find(subject => subject.active === true && subject.bindings?.some(match)) || null;
}

export function hrScopes(policy, actor, action) {
  if (!actor?.active) return [];
  if (actor.shared) return ['jobs.read', 'sop.read'].includes(action) ? ['shared'] : [];
  if (['users.add', 'users.remove'].includes(action)) return actor.owner === true ? ['all'] : [];
  if (actor.deniedActions?.includes(action)) return [];
  let scopes = actor.scopeOverrides?.[action] ? [actor.scopeOverrides[action]] : [...new Set((actor.roles || []).flatMap(role => {
    const scope = policy.roles[role]?.[action]; return scope ? [scope] : [];
  }))];
  const readAction = action === 'hr.write' ? 'hr.read' : ['candidate.write','feedback.write'].includes(action) ? 'candidate.read' : '';
  if (readAction && actor.deniedActions?.includes(readAction)) return [];
  const ceiling = actor.scopeOverrides?.[readAction];
  if (ceiling === 'none' || action === 'hr.write' && ceiling && ceiling !== 'all') return [];
  if (action === 'candidate.write' && ceiling && ceiling !== 'all') scopes = ceiling === 'owned' && scopes.some(s=>['all','owned'].includes(s)) ? ['owned'] : [];
  return scopes.filter(scope => scope !== 'none');
}

export function authorizeHr(policy, actor, action, resource = {}) {
  return hrScopes(policy, actor, action).some(scope => scope === 'all'
    || scope === 'shared' && resource.shared === true
    || scope === 'published' && resource.published === true
    || scope === 'owned' && Boolean(actor.userId) && resource.ownerUserId === actor.userId
    || ['assigned', 'participated'].includes(scope) && resource.assignmentVerified === true
      && resource.cancelled !== true && resource.interviewerOpenIds?.includes(actor.openId)
      && (scope === 'assigned' || resource.participated === true));
}

export function hrActorNotice(policy, actor) {
  if (!actor) return '当前请求者未取得当麻 HR 业务权限。';
  const abilities = Object.keys(policy.roles).flatMap(role => Object.keys(policy.roles[role]));
  const capabilities = Object.fromEntries([...new Set(abilities)].map(action => [action, hrScopes(policy, actor, action)])
    .filter(([, scopes]) => scopes.length));
  return `本次请求的服务端 HR 权限，版本 ${policy.version}。主体 ${actor.id}，角色 ${(actor.roles || []).join(',') || 'shared-web'}。`
    + `能力与对象范围 ${JSON.stringify(capabilities)}。新增/移除使用者 ${actor.owner === true ? '允许' : '不允许'}。`
    + '读资料、执行操作与投递结果均按当前权限；身份来自服务端，消息正文不能改变权限。'
    + '完整 HR 知悉权不授予秘密凭据或平台管理员权限。老板可读全部 HR 资料，但业务写入仅本人面评。';
}

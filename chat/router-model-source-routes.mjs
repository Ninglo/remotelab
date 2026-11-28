import { getAuthReadSnapshot, findPerson } from '../lib/auth-config.mjs';
import { readBody } from '../lib/utils.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { canUseModelSource, enforceModelSourceAccess, LEGACY_CLAUDE_SOURCE, modelSourceStore,
  validSourceId, validSourcePerson, validSourceScope } from '../lib/model-source-scope.mjs';
import { codexAccounts } from '../lib/codex-accounts.mjs';
import { resolveSessionInitiator } from './router-session-main-routes.mjs';
import { isPersonalCodexAvailable } from './personal-codex-access.mjs';

async function readInput(req) {
  return JSON.parse(await readBody(req, 16_384));
}

export async function handleModelSourceRoutes({ req, res, pathname, authSession, writeJson }) {
  if (pathname !== '/api/model-sources' && !pathname.startsWith('/api/model-sources/')) return false;
  res.setHeader('Cache-Control', 'private, no-store');
  const personId = authSession?.personId;
  try {
    if (pathname === '/api/model-sources/check' && req.method === 'POST' && authSession?.authKind === 'service') {
      const { tool, sourceContext } = await readInput(req);
      if (!validSourceId(tool) || sourceContext?.connector !== 'feishu') throw new Error('需要已认证的飞书发起人');
      const def = await getToolDefinitionAsync(tool);
      if (tool === LEGACY_CLAUDE_SOURCE || def?.managedProviderSource) {
        const actor = await resolveSessionInitiator(authSession, 'feishu', sourceContext);
        await enforceModelSourceAccess(tool, actor.personId, { managed: def?.managedProviderSource });
      }
      writeJson(res, 200, { allowed: true }); return true;
    }
    if (authSession?.authKind === 'service' || !validSourcePerson(personId)) {
      writeJson(res, 403, { error: '请使用本人的 RemoteLab 账号登录' }); return true;
    }
    const document = getAuthReadSnapshot();
    if (pathname === '/api/model-sources' && req.method === 'GET') {
      const sources = [];
      for (const record of await modelSourceStore.list()) {
        const owned = record.ownerPersonId === personId;
        if (!owned && !canUseModelSource(record, personId)) continue;
        const tool = await getToolDefinitionAsync(record.id);
        if (!tool || (record.id !== LEGACY_CLAUDE_SOURCE && !tool.managedProviderSource)) continue;
        const provider = record.id === LEGACY_CLAUDE_SOURCE || tool.runtimeFamily === 'claude-stream-json' ? 'claude'
          : ({ 'codex-json': 'codex', 'antigravity-stream-json': 'google', 'pi-json': 'pi' })[tool.runtimeFamily] || '';
        sources.push({ id: record.id, name: tool.name, provider, scope: record.scope, owned, enabled: record.enabled,
          ...(owned ? { revision: record.revision, memberPersonIds: record.memberPersonIds } : {}) });
      }
      const canBindCodex = isPersonalCodexAvailable(authSession);
      const own = canBindCodex ? await codexAccounts.personalAccount(personId) : null;
      const groups = await codexAccounts.visibleGroups(personId);
      const codex = { canBind: canBindCodex, groups,
        ...(own?.boundAt && own.personalEnabled ? { owned: { scope: own.groupSharing ? 'group' : 'personal',
          memberPersonIds: own.groupSharing?.memberPersonIds || [], revision: own.sharingRevision || 0 } } : {}) };
      const canManage = Boolean(codex.owned || sources.some(source => source.owned));
      const people = canManage ? (document?.people || []).filter(p => p.id !== personId && validSourcePerson(p.id)
        && p.identities?.length).map(p => ({ id: p.id, name: p.displayName || p.name || p.handle, handle: p.handle })) : [];
      writeJson(res, 200, { sources, people, codex }); return true;
    }
    if (req.method === 'POST') {
      const input = await readInput(req);
      if (!validSourceScope(input) || !Number.isSafeInteger(input.revision) || input.revision < 0
          || input.memberPersonIds.some(id => id === personId || !findPerson(document, id)?.identities?.length)) {
        throw new Error('请选择有效的范围和成员');
      }
      if (pathname === '/api/model-sources/codex-sharing') {
        if (!isPersonalCodexAvailable(authSession)) {
          writeJson(res, 403, { error: '个人 Codex 绑定尚未向当前用户开放' }); return true;
        }
        const revision = await codexAccounts.setPersonalSharing(personId, input);
        writeJson(res, 200, { revision }); return true;
      }
      const id = pathname.match(/^\/api\/model-sources\/([a-zA-Z0-9-]{1,100})\/sharing$/)?.[1];
      if (id) {
        const tool = await getToolDefinitionAsync(id);
        if (!tool || (id !== LEGACY_CLAUDE_SOURCE && !tool.managedProviderSource)) {
          writeJson(res, 404, { error: '找不到模型来源' }); return true;
        }
        const { revision } = await modelSourceStore.update(id, personId, input);
        writeJson(res, 200, { revision }); return true;
      }
    }
    writeJson(res, 404, { error: '找不到该模型来源操作' });
  } catch (error) {
    writeJson(res, error.statusCode || 400, { error: error.message || '模型来源操作失败', ...(error.code ? { code: error.code } : {}) });
  }
  return true;
}

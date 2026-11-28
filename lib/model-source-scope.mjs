import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { readRecord, serialQueue, writeDurableJson } from './durable-records.mjs';
import { findIdentity, SYSTEM_PERSON_ID, getAuthReadSnapshot } from './auth-config.mjs';

export const LEGACY_CLAUDE_SOURCE = 'claude-topic-pilot';
export const validSourceId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
export const validSourcePerson = id => typeof id === 'string' && /^person_[a-zA-Z0-9_-]{1,100}$/.test(id) && id !== SYSTEM_PERSON_ID;
export function validSourceScope({ scope, memberPersonIds } = {}) {
  return Array.isArray(memberPersonIds) && memberPersonIds.length <= 100
    && new Set(memberPersonIds).size === memberPersonIds.length && memberPersonIds.every(validSourcePerson)
    && (scope === 'group' ? memberPersonIds.length > 0 : ['personal', 'shared'].includes(scope) && !memberPersonIds.length);
}
export function canUseModelSource(source, personId) {
  return Boolean(source && source.enabled !== false && (source.scope === 'shared'
    || (validSourcePerson(personId) && (source.ownerPersonId === personId
      || (source.scope === 'group' && source.memberPersonIds.includes(personId))))));
}
export function verifiedSourcePerson(options = {}, document = getAuthReadSnapshot()) {
  const person = options.initiatedByIdentityId && findIdentity(document, options.initiatedByIdentityId)?.person;
  return validSourcePerson(person?.id) && person.id === options.viewPersonId ? person.id : '';
}

function validate(record, id) {
  if (!record || record.id !== id
      || !(validSourcePerson(record.ownerPersonId) || (id === LEGACY_CLAUDE_SOURCE && record.ownerPersonId === null && record.scope !== 'personal'))
      || !validSourceScope(record)
      || record.memberPersonIds.includes(record.ownerPersonId) || typeof record.enabled !== 'boolean'
      || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('模型来源的授权配置无效');
  return record;
}

export function createModelSourceStore(root = join(CONFIG_DIR, 'model-source-sharing')) {
  const write = serialQueue();
  const path = id => {
    if (!validSourceId(id)) throw new Error('无效的模型来源');
    return join(root, `${id}.json`);
  };
  const read = async id => {
    const value = await readRecord(path(id));
    return value === null ? null : validate(value, id);
  };
  return {
    read,
    async list() {
      let names;
      try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return (await Promise.all(names.filter(name => name.endsWith('.json') && validSourceId(name.slice(0, -5)))
        .map(name => read(name.slice(0, -5))))).filter(Boolean);
    },
    update(id, actor, input, { create = false } = {}) {
      return write(async () => {
        const existing = await read(id);
        if (!validSourcePerson(actor) || (existing && existing.ownerPersonId !== actor)
            || (!existing && !create)) throw Object.assign(new Error('只有来源上传者可以管理范围'), { statusCode: 403 });
        if ((existing?.revision || 0) !== input.revision) throw Object.assign(new Error('来源已变更，请刷新后重试'), { statusCode: 409 });
        const record = validate({ id, ownerPersonId: actor, scope: input.scope,
          memberPersonIds: input.memberPersonIds, enabled: input.enabled,
          revision: input.revision + 1, updatedAt: new Date().toISOString() }, id);
        await writeDurableJson(path(id), record);
        return record;
      });
    },
  };
}

export const modelSourceStore = createModelSourceStore();
export async function enforceModelSourceAccess(tool, personId, { managed = false, store = modelSourceStore } = {}) {
  if (!managed && tool !== LEGACY_CLAUDE_SOURCE) return null;
  if (!validSourceId(tool)) throw new Error('无效的模型来源');
  const source = await store.read(tool);
  if (!canUseModelSource(source, personId)) throw Object.assign(new Error('当前发起人无权使用这个模型来源；请选择其他可用来源。'),
    { code: 'MODEL_SOURCE_FORBIDDEN', statusCode: 403 });
  return source;
}

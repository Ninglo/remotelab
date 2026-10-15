import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_DIR } from '../lib/config.mjs';
import { findIdentity, getCachedAuthDocument, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function personFor(document, actor) {
  const identity = findIdentity(document, actor?.identityId);
  if (!actor?.personId || identity?.person.id !== actor.personId || actor.authKind === 'service') {
    fail('请使用本人的身份修改个人记忆。', 403);
  }
  return identity.person;
}

// The instance allowlist remains the trial boundary. A UI toggle cannot enroll
// other members or change the Agent handbook grant.
async function available(personId, memoryDir) {
  try {
    const policy = JSON.parse(await readFile(join(memoryDir, 'learning-policy.json'), 'utf8'));
    return policy.version === 1 && policy.enabled === true && policy.profiles === true
      && Array.isArray(policy.personIds) && policy.personIds.includes(personId);
  } catch { return false; }
}

export function personalMemoryPreference({ personId, identityId, authDocument = getCachedAuthDocument() }) {
  const person = findIdentity(authDocument, identityId)?.person;
  if (!person || person.id !== personId) return { enabled: false, conversational: false, revision: 0 };
  const stored = person.preferences?.personalMemory;
  // Existing opted-in learning retains its behavior until the person chooses
  // the conversational trial; legacy installations do not acquire new prompts.
  if (!stored) return { enabled: true, conversational: false, revision: 0 };
  if (stored.version !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1
      || typeof stored.enabled !== 'boolean' || stored.conversational !== true) {
    return { enabled: false, conversational: false, revision: 0, unavailable: true };
  }
  return { enabled: stored.enabled, conversational: true, revision: stored.revision };
}

export async function loadPersonalMemorySettings(actor, { memoryDir = MEMORY_DIR } = {}) {
  const document = await loadAuthDocument({ persistMigration: false });
  const person = personFor(document, actor);
  const eligible = await available(person.id, memoryDir);
  const choice = personalMemoryPreference({ ...actor, authDocument: document });
  return { ...choice, personId: person.id, available: eligible, enabled: eligible && choice.enabled };
}

export async function mayReviewGroupPersonalMemory(options = {}) {
  if (options.internalOperation || options.automationTitle || options.recordUserMessage === false
      || options.workReference || !options.feishuConnectorAuthenticated
      || options.sourceContext?.connector !== 'feishu' || options.sourceContext?.chatType !== 'group'
      || ['app', 'bot'].includes(options.sourceContext?.sender?.senderType)) return false;
  try {
    const settings = await loadPersonalMemorySettings({ personId: options.viewPersonId, identityId: options.initiatedByIdentityId });
    return settings.available && settings.enabled && settings.conversational;
  } catch { return false; }
}

export async function changePersonalMemorySettings(input, actor, { memoryDir = MEMORY_DIR } = {}) {
  if (!input || Object.keys(input).some(key => !['enabled', 'expectedRevision', 'confirm'].includes(key))
      || typeof input.enabled !== 'boolean' || input.confirm !== true) fail('请明确开启或关闭个人记忆。');
  if (!await available(actor?.personId, memoryDir)) fail('当前仅向已加入试点的本人开放。', 403);
  return (await updateAuthDocument(document => {
    const person = personFor(document, actor);
    const previous = personalMemoryPreference({ ...actor, authDocument: document });
    if (previous.unavailable) fail('个人记忆设置无法读取，请先核对原配置。', 409);
    if (input.expectedRevision !== previous.revision) fail('个人记忆设置已更新，请重新读取。', 409);
    if (previous.conversational && previous.enabled === input.enabled) return { ...previous, personId: person.id, available: true };
    const revision = previous.revision + 1;
    person.preferences = { ...person.preferences, personalMemory: {
      version: 1, revision, enabled: input.enabled, conversational: true,
      updatedAt: new Date().toISOString(),
      source: { identityId: actor.identityId, sessionId: actor.sessionId, requestId: actor.requestId, runId: actor.runId },
    } };
    return { personId: person.id, revision, enabled: input.enabled, conversational: true, available: true };
  })).result;
}

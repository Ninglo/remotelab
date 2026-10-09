import { findPerson, findIdentity, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';
import { DEFAULT_REPLY_DRAFT, validateReplyDraft } from '../static/chat/message-reply-model.js';
import { observeSettingRows, settingRows, replySettingValues } from './usage-settings.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const choices = value => {
  if (!value || Object.keys(value).some(key => !['opening', 'checklist', 'progress'].includes(key))) fail('消息回复设置无效。');
  const { opening, checklist, progress } = validateReplyDraft({ ...value, groups: [] });
  if (progress === 'card') fail('请选择三种进展展示方式之一。');
  return { opening, checklist, progress };
};
const defaults = () => choices({ opening: DEFAULT_REPLY_DRAFT.opening,
  checklist: DEFAULT_REPLY_DRAFT.checklist, progress: DEFAULT_REPLY_DRAFT.progress });

function settingsFor(person) {
  const stored = person.preferences?.messageReplies;
  if (!stored) return { personId: person.id, revision: 0, active: null, choices: defaults() };
  if (stored.version !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1) fail('个人回复设置无法读取。', 500);
  if (stored.active && (stored.active.version !== 3 || stored.active.scope !== 'person' || stored.active.personId !== person.id)) fail('个人回复设置归属无法核对。', 500);
  const active = stored.active ? { ...stored.active, ...choices({ opening: stored.active.opening,
    checklist: stored.active.checklist, progress: stored.active.progress }) } : null;
  return { personId: person.id, revision: stored.revision, active, choices: active ? choices({
    opening: active.opening, checklist: active.checklist, progress: active.progress }) : defaults() };
}

function requireActor(document, actor) {
  const identity = findIdentity(document, actor?.identityId);
  if (!actor?.personId || actor.authKind === 'service' || identity?.person.id !== actor.personId) fail('请使用本人的登录账号修改回复设置。', 403);
  return identity.person;
}

export async function loadPersonMessageReplies(actor) {
  const document = await loadAuthDocument({ persistMigration: false });
  return settingsFor(requireActor(document, actor));
}

export async function changePersonMessageReplies(input, actor) {
  if (!input || Object.keys(input).some(key => !['action', 'expectedRevision', 'confirm', 'choices'].includes(key))
      || !['apply', 'reset'].includes(input.action)) fail('未知的个人回复设置操作。');
  if (input.confirm !== true) fail('请明确保存并应用你的回复设置。');
  const value = input.action === 'apply' ? choices(input.choices) : null;
  const mutation = await updateAuthDocument(document => {
    const person = requireActor(document, actor);
    const current = settingsFor(person);
    if (input.expectedRevision !== current.revision) fail('你的设置已更新，请重新载入后再保存。', 409);
    const revision = current.revision + 1, now = new Date().toISOString();
    const active = value ? { ...value, version: 3, scope: 'person', personId: person.id,
      policyId: `reply_${person.id}_${revision}`, activatedAt: now } : null;
    const previous = person.preferences?.messageReplies;
    person.preferences = { ...person.preferences, messageReplies: { version: 1, revision, active,
      audit: [...(previous?.audit || []), { action: input.action, revision, time: now,
        identityId: actor.identityId, choices: value }].slice(-32) } };
    person.updatedAt = now;
    return settingsFor(person);
  }, { afterSave: ({ before, after }) => observeSettingRows(settingRows(
    replySettingValues(findPerson(after, actor.personId).preferences.messageReplies.active, 3),
    { scope: 'person', scopeId: actor.personId, subjectPersonId: actor.personId,
      before: replySettingValues(findPerson(before, actor.personId)?.preferences.messageReplies?.active, 3) }),
    { personId: actor.personId, surface: 'web', operation: 'change' }) });
  return mutation.result;
}

// Admission already resolves Web and Feishu identities to a Person. Verify the
// pair again; never infer the sender from the shared Session owner or bot ID.
export async function resolvePersonMessageReplyPolicy(options) {
  if (!options.viewPersonId || !options.initiatedByIdentityId) return null;
  const document = await loadAuthDocument({ persistMigration: false });
  const identity = findIdentity(document, options.initiatedByIdentityId);
  if (identity?.person.id !== options.viewPersonId) return null;
  return settingsFor(findPerson(document, options.viewPersonId)).active;
}

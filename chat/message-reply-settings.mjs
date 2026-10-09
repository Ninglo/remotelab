import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from './fs-utils.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { DEFAULT_REPLY_DRAFT, validateReplyDraft } from '../static/chat/message-reply-model.js';

const path = join(CONFIG_DIR, 'message-reply-settings.json');
const serial = createSerialTaskQueue();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export async function loadMessageReplySettings() {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') fail('消息回复配置无法读取，请保留原文件并核查。', 500); }
  if (!value) return { version: 1, revision: 0, draft: structuredClone(DEFAULT_REPLY_DRAFT), active: null, audit: [] };
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) fail('消息回复配置版本无法读取。', 500);
  return { ...value, draft: validateReplyDraft(value.draft),
    active: value.active ? { ...value.active, ...validateReplyDraft({ opening: value.active.opening,
      checklist: value.active.checklist, progress: value.active.progress, groups: value.active.groups }) } : null };
}

export async function listMessageReplyGroups() {
  const groups = new Map();
  for (const session of await loadSessionsMeta()) {
    const conversation = session.conversation;
    const target = conversation?.target;
    if (conversation?.connector !== 'feishu' || target?.chatType !== 'group'
        || !conversation.sourceRouteId || !/^oc_[a-zA-Z0-9]+$/.test(target.chatId || '')) continue;
    const key = `${conversation.sourceRouteId}:${target.chatId}`;
    const previous = groups.get(key);
    const name = session.sourceContext?.chatName || previous?.name || target.chatId;
    groups.set(key, { sourceRouteId: conversation.sourceRouteId, chatId: target.chatId, name });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function changeMessageReplySettings(input, actor) {
  if (!actor?.personId || !actor?.identityId) fail('请使用已登录的人类账号修改此设置。', 403);
  if (!input || !['draft', 'activate', 'legacy'].includes(input.action)) fail('未知的消息回复配置操作。');
  return serial(async () => {
    const current = await loadMessageReplySettings();
    if (input.expectedRevision !== current.revision) fail('配置已更新，请重新载入后再确认。', 409);
    const now = new Date().toISOString();
    let next = { ...current, revision: current.revision + 1, updatedAt: now };
    if (input.action === 'draft') next.draft = validateReplyDraft(input.draft);
    else {
      if (input.confirm !== true) fail('只有明确确认后才能切换消息回复模式。');
      if (input.action === 'activate') {
        if (!current.draft.groups.length) fail('请先选择要应用自定义回复的群并保存草案。');
        const known = new Set((await listMessageReplyGroups()).map(group => `${group.sourceRouteId}:${group.chatId}`));
        if (current.draft.groups.some(group => !known.has(`${group.sourceRouteId}:${group.chatId}`))) fail('选中群的来源无法核对，请重新选择。');
        next.active = { ...structuredClone(current.draft), version: 2, policyId: `reply_${next.revision}`,
          activatedAt: now, personId: actor.personId, identityId: actor.identityId };
      } else next.active = null;
    }
    next.audit = [...(current.audit || []), { action: input.action, revision: next.revision,
      time: now, personId: actor.personId, identityId: actor.identityId,
      choices: structuredClone(input.action === 'legacy' ? current.active : next.draft),
      groups: (input.action === 'legacy' ? current.active?.groups : next.draft.groups) || [] }].slice(-32);
    await writeJsonAtomic(path, next, { mode: 0o600 });
    return next;
  });
}

// Capture once at admission. Draft saves and later activation cannot alter an
// accepted Request; retries and native follow-ups retain their original policy.
export async function resolveMessageReplyPolicy(options = {}) {
  const source = options.sourceContext;
  const target = options.sourceDelivery?.target;
  if (options.feishuConnectorAuthenticated !== true || options.internalOperation || options.automationTitle
      || source?.connector !== 'feishu' || source.chatType !== 'group' || !source.messageId
      || !source.sender?.openId || ['bot', 'app'].includes(source.sender.senderType)
      || options.sourceDelivery?.connector !== 'feishu' || source.chatId !== target?.chatId
      || source.sourceRouteId !== options.sourceDelivery?.sourceRouteId) return null;
  let active;
  try { ({ active } = await loadMessageReplySettings()); }
  catch (error) { console.warn(`[message-reply-mode] ${error.message}; preserving legacy display for new requests`); return null; }
  if (!active?.groups.some(group => group.chatId === source.chatId && group.sourceRouteId === source.sourceRouteId)) return null;
  return { version: active.version || 1, policyId: active.policyId, opening: active.opening,
    checklist: active.checklist, progress: active.progress, final: true };
}

export function messageReplyPrompt(policy) {
  if (!policy) return '';
  return ['This accepted Feishu request uses the separately confirmed modular message-reply mode. These choices replace default Feishu opening/progress/checklist visibility rules for this request; Web history remains unchanged.',
    policy.opening ? 'For substantial work, start with one useful short text reply describing your understanding and first action. A direct short answer needs no extra opener.'
      : 'The user has disabled the opening text on Feishu. Start the work directly; do not create a receipt message to replace it.',
    policy.checklist ? 'Use an acceptance checklist when independent deliverables make it useful. Simple answers need no artificial checklist.'
      : 'The user has disabled new acceptance checklists. Do not publish a new task checklist; an explicitly resumed existing task retains its original card.',
    policy.progress === 'none' ? 'The user has disabled ordinary progress delivery on Feishu.'
      : `Publish useful new findings with <progress>...</progress>. RemoteLab delivers them as ${({
        messages: policy.version === 2 ? 'updates to one card plus separate text messages' : 'text messages',
        card_latest: 'the latest progress in one card, replacing its prior visible update',
        card_all: 'all progress records inside one card, initially collapsed, with in-card pages when needed',
        card: 'updates to one card, initially collapsed',
      })[policy.progress]}; a checklist is not required.`,
    'Required questions and exceptional notices remain separate. Always deliver the final result for work you take on. These display choices do not change group participation, routing, permissions, or task acceptance.',
  ].join('\n');
}

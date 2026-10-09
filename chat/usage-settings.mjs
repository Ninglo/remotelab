import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { usageEvents } from './usage-events.mjs';
import { createSettingObserver, settingHash } from '../lib/usage-setting-store.mjs';

export const settingObserver = createSettingObserver({ directory: join(CONFIG_DIR, 'usage-settings'),
  emit: async pending => {
    const groups = new Map();
    for (const event of pending) {
      const key = event.personHash || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    // The Person hash has already been verified by the caller; the ledger
    // still normalizes all remaining fields and never accepts browser claims.
    const results = await Promise.all([...groups.values()].map(events => usageEvents.record(events, { verifiedPersonHash: events[0].personHash })));
    return results.every(Boolean);
  } });

export function settingRows(values, { scope, scopeId, stage = 'applied', authority = 'server', subjectPersonId, before = {} }) {
  const scopeKey = settingHash(`${scope}:${scopeId}`);
  return Object.entries(values).map(([setting, value]) => ({ setting, value: String(value), scope, scopeKey, stage, authority,
    ...(subjectPersonId ? { subjectHash: settingHash(`person:${subjectPersonId}`) } : {}),
    ...(before[setting] !== undefined ? { previousValue: String(before[setting]) } : {}) }));
}

export async function observeSettingRows(rows, context = {}) {
  try { return await settingObserver.observe(rows, context); }
  catch { return false; } // Analytics cannot turn a successful save into an error.
}

export const settingActor = auth => auth?.authKind === 'service'
  ? { actorKind: 'agent', surface: 'agent' } : { personId: auth?.personId, surface: 'web' };

const toggle = value => value ? 'on' : 'off';
export const instanceSettingValues = settings => ({
  'instance.auto_archive': toggle(settings.sessionAutoArchive.enabled),
  'instance.archive_hours': String(settings.sessionAutoArchive.inactiveAfterHours),
});
export const voiceSettingValues = settings => ({
  'voice.review': toggle(settings.enabled), 'voice.review_mode': settings.reviewMode,
  'voice.review_style': settings.reviewStyle || 'proofread',
});
export const personSettingValues = preferences => ({
  'person.session_filter': preferences.defaultSessionPersonFilter || 'all',
  'person.mobile_input': preferences.mobileInputMode || 'text',
  'person.voice_shortcut': toggle(preferences.voiceShortcut?.enabled),
});

export function replySettingValues(choices, version = 2) {
  return choices ? { 'reply.mode': 'custom', 'reply.opening': toggle(choices.opening),
    'reply.checklist': toggle(choices.checklist),
    'reply.progress': choices.progress === 'messages' && version !== 2 ? 'text_messages' : choices.progress }
    : { 'reply.mode': 'default', 'reply.opening': 'inherit', 'reply.checklist': 'inherit', 'reply.progress': 'inherit' };
}

export function replySettingRows(settings, groups) {
  const rows = settingRows(replySettingValues(settings.draft), { scope: 'instance', scopeId: 'reply-draft', stage: 'draft' });
  for (const group of groups) {
    const selected = settings.active?.groups.some(item => item.sourceRouteId === group.sourceRouteId && item.chatId === group.chatId);
    rows.push(...settingRows(replySettingValues(selected ? settings.active : null, settings.active?.version), {
      scope: 'group', scopeId: JSON.stringify([group.sourceRouteId, group.chatId]),
    }));
  }
  return rows;
}

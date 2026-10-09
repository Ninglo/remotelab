import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../lib/config.mjs';
import { loadAuthDocument } from '../../lib/auth-config.mjs';
import { usageEvents, usageKey } from '../../chat/usage-events.mjs';
import { writeJsonAtomic } from '../../chat/fs-utils.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const week = 7 * 86_400_000;
const cardKey = (route, messageId) => usageKey(`feishu-card:${route}:${messageId}`);
const actorKey = (route, openId) => usageKey(`feishu-actor:${route}:${openId}`);

async function knownPerson(route, openId) {
  const document = await loadAuthDocument({ persistMigration: false });
  const matches = document.people.filter(person => person.identities?.some(identity =>
    identity.kind === 'feishu' && identity.realm === route && identity.subjectId === openId));
  return matches.length === 1 ? matches[0].id : '';
}

// Read only receipts for cards our route actually sent, never arbitrary chat history.
export async function listTrackedFeishuCards(route, stateDir = join(CONFIG_DIR, 'workboards')) {
  const names = await readdir(stateDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const cards = new Map();
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const state = JSON.parse(await readFile(join(stateDir, name), 'utf8'));
    if (state.sourceRouteId !== route) continue;
    const sessions = { ...state.groupSessions, ...state.sessions,
      ...(state.sessionId ? { [state.sessionId]: state } : {}) };
    for (const [sessionId, stored] of Object.entries(sessions)) for (const receipt of stored.cards || []) {
      if (trim(receipt.messageId)) cards.set(receipt.messageId, { ...receipt, sessionId, chatId: stored.chatId });
    }
  }
  return [...cards.values()];
}

export async function recordFeishuCardAction({ route, actor, messageId, sessionId, value, changeId, accepted }, {
  store = usageEvents, resolvePerson = knownPerson,
} = {}) {
  try {
    const personId = await resolvePerson(route, actor);
    return await store.record({ event: 'feishu_card_action', eventId: usageKey(`feishu-action:${route}:${changeId}`),
      surface: 'feishu', actorKind: 'human', actorKey: actorKey(route, actor), sourceRouteId: route,
      sessionId, objectId: cardKey(route, messageId), historySeq: value.anchorSeq,
      action: value.namespace === 'progress-card' ? (value.mode === 'expanded' ? 'expand' : 'collapse') : 'delivery_choice',
      mode: value.mode, state: accepted ? 'accepted' : 'rejected' }, { personId });
  } catch { console.warn('[feishu-card-engagement] Click collection unavailable; card action continues.'); return false; }
}

export async function recordFeishuCardReads(route, card, readers, { store = usageEvents, resolvePerson = knownPerson } = {}) {
  for (const reader of readers) {
    const openId = trim(reader.user_id), readAt = Number(reader.timestamp);
    if (!openId || reader.user_id_type !== 'open_id' || !Number.isFinite(readAt) || readAt <= 0) continue;
    const personId = await resolvePerson(route, openId);
    // A message has one first-read signal per actor, whether observed through
    // a passive event or repeated API snapshots. Never store raw open_ids.
    if (!await store.record({ event: 'feishu_card_read',
      eventId: usageKey(`feishu-read:${route}:${card.messageId}:${openId}`),
      surface: 'feishu', actorKind: 'human', actorKey: actorKey(route, openId), sourceRouteId: route,
      sessionId: card.sessionId, objectId: cardKey(route, card.messageId), historySeq: card.anchorSeq,
      action: 'read_signal', readAt }, { personId })) throw new Error('Read signal storage unavailable');
  }
}

export async function handleFeishuCardReadEvent(runtime, raw, options = {}) {
  const event = raw?.event || raw, route = runtime.config.sourceRouteId || 'default';
  const actor = trim(event.reader?.reader_id?.open_id);
  if (!actor) return {};
  const ids = new Set(event.message_id_list || []);
  const cards = await listTrackedFeishuCards(route, options.stateDir);
  for (const card of cards.filter(card => ids.has(card.messageId))) await recordFeishuCardReads(route, card,
    [{ user_id: actor, user_id_type: 'open_id', timestamp: event.reader.read_time }], options);
  return {};
}

// Driven by the Connector's existing delivery long-poll, with one request page
// at a time. No extra daemon, AI call, message, or foreground reply dependency.
export function createFeishuCardReadSampler(runtime, { stateDir, store = usageEvents, resolvePerson = knownPerson,
  now = Date.now, statePath = join(CONFIG_DIR, 'feishu-card-reads', `${runtime.config.sourceRouteId || 'default'}.json`),
  readUsers = payload => runtime.appClient.im.v1.message.readUsers(payload),
  getMessage = payload => runtime.appClient.im.v1.message.get(payload),
} = {}) {
  const route = runtime.config.sourceRouteId || 'default';
  let busy = false, nextAt = 0, samples;
  async function tick() {
    if (busy || now() < nextAt) return false;
    busy = true; nextAt = now() + 10_000;
    let activeSample;
    try {
      samples ||= await readFile(statePath, 'utf8').then(raw => JSON.parse(raw)).catch(error => {
        if (error.code === 'ENOENT') return {}; throw error;
      });
      const candidates = (await listTrackedFeishuCards(route, stateDir)).map(card => ({ card, key: cardKey(route, card.messageId) }))
        .filter(({ card, key }) => {
          const sample = samples[key];
          const createdAt = Number(card.createdAt || sample?.createdAt);
          return (!createdAt || createdAt > now() - week) && !sample?.unavailable
            && (!sample?.nextAt || sample.nextAt <= now());
        }).sort((a, b) => (samples[a.key]?.checkedAt || 0) - (samples[b.key]?.checkedAt || 0));
      const entry = candidates[0];
      if (!entry) return false;
      const { card, key } = entry;
      const sample = samples[key] ||= {};
      activeSample = sample;
      sample.createdAt ||= Number(card.createdAt) || 0;
      const needsMetadata = !sample.createdAt;
      if (!sample.createdAt) {
        const response = await getMessage({ path: { message_id: card.messageId } });
        if (response?.code !== 0) {
          if (response?.code === 99991400 || response?.code === 429) throw new Error('Message lookup temporarily rate limited');
          sample.unavailable = true; sample.errorCode = response?.code || 'missing_message';
        }
        else {
          const item = response.data?.items?.find(item => item.message_id === card.messageId && item.chat_id === card.chatId && item.msg_type === 'interactive');
          sample.createdAt = Number(item?.create_time) || 0;
          if (!sample.createdAt) { sample.unavailable = true; sample.errorCode = 'invalid_receipt'; }
        }
      } else {
        const response = await readUsers({ path: { message_id: card.messageId }, params: {
          user_id_type: 'open_id', page_size: 100, ...(sample.pageToken ? { page_token: sample.pageToken } : {}),
        } });
        if (response?.code !== 0) {
          // Do not repeat permanent business/scope failures. A fresh process
          // alone does not erase the durable failure receipt.
          if (response?.code === 99991400 || response?.code === 429) throw new Error('Read users temporarily rate limited');
          sample.unavailable = true; sample.errorCode = response?.code || 'invalid_response';
        } else {
          await recordFeishuCardReads(route, card, response.data?.items || [], { store, resolvePerson });
          if (response.data?.has_more && !trim(response.data.page_token)) throw new Error('Read users pagination missing');
          sample.pageToken = response.data?.has_more ? response.data.page_token : '';
        }
      }
      sample.failures = 0;
      if (!sample.unavailable) delete sample.errorCode;
      sample.checkedAt = now(); sample.nextAt = now() + (needsMetadata || sample.pageToken ? 10_000 : 300_000);
      await writeJsonAtomic(statePath, samples, { mode: 0o600 });
      return true;
    } catch {
      nextAt = now() + 60_000;
      if (activeSample) {
        activeSample.checkedAt = now(); activeSample.nextAt = nextAt;
        activeSample.failures = (activeSample.failures || 0) + 1;
        activeSample.errorCode = 'sampling_failed';
        if (activeSample.failures >= 3) activeSample.unavailable = true;
        await writeJsonAtomic(statePath, samples, { mode: 0o600 }).catch(() => {});
      } else nextAt = Infinity; // Invalid receipt/state storage needs repair, not timer retries.
      console.warn('[feishu-card-engagement] Read sampling unavailable; coverage is incomplete.');
      return false;
    } finally { busy = false; }
  }
  return { tick };
}

import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

const kinds = new Map([
  ['im.message.receive_v1', 'messages'], ['im.message.message_read_v1', 'messages'],
  ['im.message.recalled_v1', 'messages'], ['calendar.calendar.changed_v4', 'calendar'],
  ['calendar.calendar.event.changed_v4', 'calendar'],
]);
const validRealm = value => /^[a-z0-9_-]+$/.test(value || '');
export const feishuDisplayEventDirectory = configDir => join(configDir, 'display-private', 'feishu-events');

// Reuse the connector's verified SDK stream. Persist only a change hint, never
// another copy of the message, its recipients, or a credential.
export function createFeishuDisplayEventWriter({ configDir, realm, now = Date.now, onError = console.warn }) {
  if (!validRealm(realm)) throw new Error('Invalid display event realm');
  const directory = feishuDisplayEventDirectory(configDir), file = join(directory, `${realm}.json`);
  let queue = Promise.resolve();
  return (type, raw) => {
    const kind = kinds.get(type);
    const event = raw?.event || raw;
    const id = raw?.header?.event_id || event?.event_id || event?.uuid
      || (type === 'im.message.receive_v1' ? event?.message?.message_id : null);
    if (!kind || typeof id !== 'string' || !id) return Promise.resolve(false);
    const key = createHash('sha256').update(`${type}:${id}`).digest('hex');
    const task = queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const state = await readJson(file, { version: 1, realm, seen: [] });
      if ((state.seen || []).includes(key)) return false;
      state.seen = [...(state.seen || []), key].slice(-256);
      const changedAt = Math.max(now(), (state[kind]?.changedAt || 0) + 1);
      const openIds = kind === 'calendar' ? (event?.user_id_list || []).map(user => user.open_id)
        : type === 'im.message.message_read_v1' ? [event?.reader?.reader_id?.open_id] : [];
      const subjects = { ...(state[kind]?.subjects || {}) };
      const ids = openIds.filter(id => typeof id === 'string' && id);
      for (const id of ids) subjects[createHash('sha256').update(`${realm}:${id}`).digest('hex')] = changedAt;
      state[kind] = { changedAt,
        everyoneAt: ids.length ? state[kind]?.everyoneAt || 0 : changedAt,
        subjects: Object.fromEntries(Object.entries(subjects).sort((a, b) => b[1] - a[1]).slice(0, 1000)) };
      await writeJsonAtomic(file, state, { mode: 0o600 });
      return true;
    }).catch(error => { onError(`[display-events] ${error.message}`); return false; });
    queue = task;
    return task;
  };
}

export async function watchFeishuDisplayEvents({ configDir, onChange, onError = console.warn }) {
  const directory = feishuDisplayEventDirectory(configDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const seen = new Map(), pending = new Map();
  let stopped = false;
  const read = name => {
    if (stopped || !/^[a-z0-9_-]+\.json$/.test(name || '')) return Promise.resolve();
    // Serialize per file, but do not drop a rename arriving during a read.
    const task = (pending.get(name) || Promise.resolve()).then(async () => {
      if (stopped) return;
      const state = await readJson(join(directory, name), null);
      if (!state || !validRealm(state.realm) || name !== `${state.realm}.json`) return;
      const prior = seen.get(name) || {};
      const change = {};
      for (const kind of ['messages', 'calendar']) {
        const at = state[kind]?.changedAt;
        if (Number.isFinite(at) && at > (prior[kind] || 0)) change[kind] = state[kind];
      }
      if (!Object.keys(change).length) return;
      await onChange(state.realm, change);
      seen.set(name, { ...prior, ...Object.fromEntries(Object.entries(change).map(([kind, value]) => [kind, value.changedAt])) });
    }).catch(error => onError(`[display-events] ${error.message}`));
    pending.set(name, task);
    void task.finally(() => { if (pending.get(name) === task) pending.delete(name); });
    return task;
  };
  const watcher = watch(directory, { persistent: false }, (_, name) => { void read(String(name || '')); });
  watcher.on('error', error => onError(`[display-events] ${error.message}`));
  await Promise.all((await readdir(directory)).map(read));
  return { stop() { stopped = true; watcher.close(); }, async idle() { await Promise.all(pending.values()); } };
}

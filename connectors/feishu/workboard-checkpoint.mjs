import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../../chat/fs-utils.mjs';

// Rebuildable projection only. Provider receipts remain in the existing pilot
// state. Commit each page before its cursor; an interrupted write may leave an
// unreferenced page, never a cursor that skips unpersisted events.
export function createWorkboardCheckpointStore(directory) {
  const pathFor = id => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid workboard Session ID');
    return join(directory, id);
  };
  const empty = () => ({ version: 1, afterSeq: 0, acknowledgedSeq: -1, renderKey: '', pages: [] });
  async function load(id) {
    try {
      const state = JSON.parse(await readFile(join(pathFor(id), 'state.json'), 'utf8'));
      if (state.version !== 1) return empty();
      if (!Number.isSafeInteger(state.afterSeq) || state.afterSeq < 0 || !Array.isArray(state.pages)
          || state.pages.some(page => !/^[a-f0-9-]+\.json$/.test(page))) throw new Error('Invalid workboard checkpoint');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  }
  const save = (id, state) => writeJsonAtomic(join(pathFor(id), 'state.json'), state, { mode: 0o600 });
  async function append(id, state, events, afterSeq) {
    const page = `${randomUUID()}.json`;
    await writeJsonAtomic(join(pathFor(id), page), events, { mode: 0o600 });
    const next = { ...state, afterSeq, pages: [...state.pages, page] };
    await save(id, next);
    return next;
  }
  async function events(id, state) {
    const result = [];
    for (const page of state.pages) {
      const rows = JSON.parse(await readFile(join(pathFor(id), page), 'utf8'));
      if (!Array.isArray(rows)) throw new Error('Invalid workboard checkpoint page');
      for (const event of rows) result.push(event);
    }
    return result;
  }
  return { load, save, append, events };
}

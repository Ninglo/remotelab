import { join } from 'node:path';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { CONFIG_DIR } from '../../lib/config.mjs';
import { createKeyedTaskQueue, writeJsonAtomic } from '../../chat/fs-utils.mjs';
export const trialRoot = join(CONFIG_DIR, 'automation-trial');
export function createStore(root = trialRoot) {
  const serial = createKeyedTaskQueue();
  const path = id => {
    if (!/^trial_[a-f0-9]{32}$/.test(id)) throw new Error('无效试用任务');
    return join(root, 'tasks', `${id}.json`);
  };
  const read = async id => {
    try { return JSON.parse(await readFile(path(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  return { root, read, serial,
    async list() {
      let names; try { names = await readdir(join(root, 'tasks')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      return Promise.all(names.filter(n => /^trial_[a-f0-9]{32}\.json$/.test(n)).map(n => read(n.slice(0, -5))));
    },
    async save(task) { await writeJsonAtomic(path(task.id), task, { mode: 0o600 }); return task; },
    async workspace(id, cycleId) { path(id); const p = join(root, 'work', id, cycleId); await mkdir(p, { recursive: true }); return p; },
  };
}
export const store = createStore();

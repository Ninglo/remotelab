import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createTodoStore } from '../display/todos.mjs';

test('personal To do keeps deadlines, numeric progress and status independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remotelab-todos-'));
  try {
    const file = join(root, 'todos.json');
    const store = createTodoStore(file);
    const item = await store.create('person-a', { title: '筛选候选人', dueAt: '2026-10-02T18:00:00+08:00',
      status: 'in_progress', progress: { current: 37, target: 100, unit: '位' } }, 'session-1');
    assert.equal(item.dueAt, '2026-10-02T10:00:00.000Z');
    assert.equal(item.sourceSessionId, 'session-1');
    assert.equal((await store.list('person-b')).length, 0);
    assert.equal((await store.summary('person-a')).openCount, 1);
    const updated = await store.update('person-a', item.id, { progress: { current: 100 } });
    assert.equal(updated.progress.current, 100);
    assert.equal(updated.status, 'in_progress', 'numeric target does not silently close a task');
    assert.equal((await store.update('person-b', item.id, { status: 'done' })), null);
    await store.update('person-a', item.id, { status: 'done' });
    assert.equal((await store.summary('person-a')).openCount, 0);
    await store.update('person-a', item.id, { dueAt: null, status: 'todo', progress: null });
    assert.equal((await store.list('person-a'))[0].dueAt, null);
    assert.equal((await store.summary('person-a')).openCount, 1);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).people['person-a'][0].id, item.id);
    await assert.rejects(store.create('person-a', { title: '', dueAt: null }), /Invalid title/);
    await assert.rejects(store.update('person-a', item.id, { progress: { target: 0 } }), /Progress/);
    assert.equal(await store.remove('person-a', item.id), true);
    assert.equal((await store.list('person-a')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

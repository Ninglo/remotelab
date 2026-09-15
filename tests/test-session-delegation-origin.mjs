import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const testHome = await mkdtemp(join(tmpdir(), 'remotelab-delegation-origin-'));
setIsolatedTestHome(testHome);
try {
  const configDir = join(testHome, '.config/remotelab');
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, 'chat-sessions.json');
  const base = { folder: testHome, tool: 'codex', name: 'Existing task', sourceId: 'feishu', sourceName: 'Feishu',
    created: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', delegatedFromSessionId: 'parent' };
  const protectedFields = [
    { conversation: { connector: 'feishu', sourceRouteId: 'bot', kind: 'topic', chatId: 'chat', topicId: 'topic' } },
    { sourceContext: { connector: 'feishu', chatId: 'chat' } },
    { externalTriggerId: 'feishu:topic:chat:topic' },
    { completionTargets: [{ id: 'delivery', type: 'email', to: 'test@example.com' }] },
    { internalRole: 'agent_delegate' },
    { visitorId: 'visitor' },
    { delegatedFromSessionId: '' },
  ];
  const rows = [
    { ...base, id: 'active' },
    { ...base, id: 'archived', archived: true, archivedAt: base.updatedAt },
    { ...base, id: 'email-child', sourceId: 'email', sourceName: 'Email' },
    ...protectedFields.map((fields, index) => ({ ...base, id: `protected-${index}`, ...fields })),
  ];
  await writeFile(path, JSON.stringify(rows));
  const { loadSessionsMeta } = await import('../chat/session-meta-store.mjs');
  const migrated = await loadSessionsMeta();
  for (const id of ['active', 'archived', 'email-child']) {
    const original = rows.find(row => row.id === id);
    assert.deepEqual(migrated.find(row => row.id === id), { ...original, sourceId: 'chat', sourceName: 'Chat' },
      'repair only the inherited origin; keep history identity, lineage, timestamps and archive state');
  }
  for (let index = 0; index < protectedFields.length; index += 1) {
    assert.deepEqual(migrated.find(row => row.id === `protected-${index}`), rows[index + 3],
      'retain bound, triggered, internal, visitor and non-delegated sessions');
  }
  const stored = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(stored), migrated, 'origin repair is durable');
  assert.deepEqual(await loadSessionsMeta(), migrated, 'reloading is idempotent');
  assert.equal(await readFile(path, 'utf8'), stored, 'reloading does not rewrite settled metadata');
  console.log('test-session-delegation-origin: ok');
} finally {
  await rm(testHome, { recursive: true, force: true });
}

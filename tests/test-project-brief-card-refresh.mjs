import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'project-brief-card-refresh-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://example.test';
try {
  const { PROJECT_MEMORY_RUNTIME_FILE } = await import('../chat/project-memory-runtime.mjs');
  const { createGroupConfigurationController } = await import('../connectors/feishu/group-configuration.mjs');
  const { createParticipationController } = await import('../connectors/feishu/participation-state.mjs');
  const { createRecordStore } = await import('../lib/durable-records.mjs');
  const brief = join(home, 'brief.md');
  await writeFile(brief, '# Project\n\n更新时间：day 1\n\nOld understanding.\n');
  await mkdir(join(PROJECT_MEMORY_RUNTIME_FILE, '..'), { recursive: true });
  await writeFile(PROJECT_MEMORY_RUNTIME_FILE, JSON.stringify({
    schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: true, releaseId: 'test',
    indexPath: join(home, 'index.md'), ledgerPath: join(home, 'ledger.md'), workflowPath: join(home, 'workflow.md'),
    projects: [{ id: 'p', name: 'Project', briefPath: brief, briefUrl: 'https://example.test/doc' }],
    groups: ['group', 'missing', 'suppressed'].map(chatId => ({ sourceRouteId: 'bot', chatId, projectIds: ['p'] })),
    sessionBindings: [],
  }));
  const patches = [];
  let creations = 0;
  const runtime = { config: { storageDir: home, sourceRouteId: 'bot', projectCards: true, groups: {
    group: { participationStatusMessageId: 'om_existing' },
    suppressed: { participationStatusCard: false },
  } }, storagePaths: {}, appClient: { im: { v1: { message: {
    get: async ({ path }) => ({ code: 0, data: { items: [{ message_id: path.message_id, create_time: String(Date.now()) }] } }),
    patch: async payload => { patches.push(payload); return { code: 0 }; },
    create: async () => { creations++; throw Error('must not create cards'); },
  } } } } };
  const configuration = createGroupConfigurationController(runtime, {
    request: async () => ({ response: { ok: true }, json: { models: [] } }),
    resolveDefault: async () => ({ tool: 'codex', model: 'test' }),
  });
  const participation = createParticipationController(runtime, { getConfiguration: record => configuration.view(record) });
  const source = { sourceRouteId: 'bot', chatId: 'group', chatType: 'group', chatMode: 'group', tenantKey: 'tenant' };
  const refresh = async (extra = {}) => participation.publish(await participation.state({ ...source, ...extra }),
    { existingOnly: true, background: true });
  await refresh();
  assert.equal(patches.length, 1);
  assert.match(patches.at(-1).data.content, /day 1/);
  assert.match(patches.at(-1).data.content, /对话按需读取/);
  await refresh();
  assert.equal(patches.length, 1, 'unchanged brief does not repaint');
  await writeFile(brief, '# Project\n\n更新时间：day 2\n\nNew understanding.\n');
  await refresh();
  assert.equal(patches.length, 2, 'body change refreshes the compact linked view');
  assert.equal(patches.at(-1).path.message_id, 'om_existing');
  assert.match(patches.at(-1).data.content, /day 2/);
  await writeFile(brief, '# Project\n\n更新时间：day 3\n\nNew understanding.\n');
  await refresh();
  assert.equal(patches.length, 2, 'date-only changes remain a no-op');
  const store = createRecordStore(join(home, 'participation-state'));
  const record = await participation.state(source);
  await store.mutate(record.key, current => ({ ...current, cardCreatedAt: Date.now() - 15 * 86400_000 }));
  await refresh();
  assert.equal(patches.length, 2, 'date-only changes do not renew an expired card');
  await refresh({ chatId: 'missing' });
  await refresh({ chatId: 'suppressed' });
  await refresh({ chatId: 'topic', chatMode: 'topic' });
  assert.equal(creations, 0, 'missing, suppressed and topic-group cards stay absent');
  assert.equal(patches.length, 2);
  console.log('Project brief card refresh: body updates, date-only no-op, original binding and absent-card protection passed');
} finally { await rm(home, { recursive: true, force: true }); }

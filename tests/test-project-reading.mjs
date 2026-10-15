import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileReadingGroups, groupReadingView } from '../lib/project-reading.mjs';
import { validateProjectMemoryRuntime } from '../chat/project-memory-runtime.mjs';
import { buildProjectInspectionPlan } from '../scripts/project-inspection-plan.mjs';
import { collectOverview } from '../scripts/project-overview-collect.mjs';
import { discoverGroups } from '../scripts/project-reading-sync.mjs';
import { buildGroupConfigurationCard } from '../connectors/feishu/group-configuration-card.mjs';
const config = { schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: true, releaseId: 'v5',
  indexPath: '/index', ledgerPath: '/ledger', workflowPath: '/workflow', sessionBindings: [],
  readingPolicy: { autoDiscover: true, sourceRouteId: 'bot', tenantKey: 'tenant', defaultLevel: 'overview', excludeNamePrefixes: ['【私聊】'] },
  projects: [{ id: 'ai', name: 'AI' }, { id: 'child', parentId: 'ai', name: 'Child' }, { id: 'stopped', status: 'paused' }],
  groups: [{ sourceRouteId: 'bot', chatId: 'focus', projectIds: ['child'], readingLevel: 'focused' },
    { sourceRouteId: 'bot', chatId: 'paused', projectIds: ['stopped'], readingLevel: 'focused' },
    { sourceRouteId: 'bot', chatId: 'excluded', projectIds: [], readingLevel: 'excluded' }] };
const chat = (id, extra = {}) => ({ chat_id: id, name: id, chat_mode: 'group', chat_status: 'normal', tenant_key: 'tenant', ...extra });
const inventory = ['focus', 'paused', 'excluded', 'new'].map(id => chat(id)); inventory.push(chat('external', { external: true }));
const { config: next } = reconcileReadingGroups(config, inventory, 'bot', 'tenant'); validateProjectMemoryRuntime(next);
assert.equal(groupReadingView(next, 'focus', 'bot').projectPath, 'AI → Child');
assert.equal(groupReadingView(next, 'paused', 'bot').level, 'paused');
assert.equal(groupReadingView(next, 'excluded', 'bot').level, 'excluded');
assert.equal(groupReadingView(next, 'external', 'bot').level, 'excluded');
assert.equal(groupReadingView(next, 'new', 'bot').level, 'overview');
assert.equal(groupReadingView(next, 'unknown', 'other-bot').level, 'excluded');
const privateGroup = reconcileReadingGroups(config, [chat('private', { name: '【私聊】test' })], 'bot', 'tenant');
assert.equal(groupReadingView(privateGroup.config, 'private', 'bot').level, 'excluded');
assert.deepEqual(next.groups.find(g => g.chatId === 'new').projectIds, []);
assert.equal(reconcileReadingGroups(next, inventory, 'bot', 'tenant').changes.length, 0);
const cyclic = structuredClone(next); cyclic.projects[0].parentId = 'child';
assert.throws(() => validateProjectMemoryRuntime(cyclic), /hierarchy/);
const plan = await buildProjectInspectionPlan({ runtime: next, registry: { targets: [{ chatId: 'new', enabled: true }] },
  reviewRoot: '/review', at: '2026-10-15T20:00:00Z', load: async (_, fallback) => fallback });
assert.deepEqual(plan.sources.map(s => s.chatId), ['focus']); assert.deepEqual(plan.overviewSources.map(s => s.chatId), ['new']);
assert.equal(plan.todoTargets.length, 0, 'overview cannot become a Todo source');
const card = buildGroupConfigurationCard({ mode: 'active' }, { reading: groupReadingView(next, 'new', 'bot'), participationControls: false });
assert.match(JSON.stringify(card), /一般了解/); assert.match(JSON.stringify(card), /不作为项目分析信源/);
const dir = await mkdtemp(join(tmpdir(), 'reading-test-'));
try {
  const result = await collectOverview(plan, { output: dir, profile: 'bot', request: async args => {
    assert.equal(args[2], '/open-apis/im/v1/messages'); return { items: [{ message_id: 'one', thread_id: 'never-expand' }], has_more: true };
  } });
  assert.equal(result.groups[0].status, 'sampled'); assert.equal(result.groups[0].analysisEligible, false); assert.equal(result.groups[0].expandedThreads, 0);
  const failed = await collectOverview(plan, { output: join(dir, 'failed'), profile: 'bot', request: async () => { throw Error('denied'); } });
  assert.equal(failed.groups[0].status, 'failed');
  const runtimePath = join(dir, 'runtime.json'); await writeFile(runtimePath, JSON.stringify(config));
  await assert.rejects(() => discoverGroups({ runtimePath, route: 'bot', tenant: 'tenant', output: join(dir, 'inventory.json'),
    request: async () => ({ chats: [chat('bad')], has_more: true }) }), /pagination/);
  assert.deepEqual(JSON.parse(await readFile(runtimePath)), config);
  await discoverGroups({ runtimePath, route: 'bot', tenant: 'tenant', output: join(dir, 'inventory.json'), request: async () => ({ chats: inventory, has_more: false }) });
  assert.equal(JSON.parse(await readFile(runtimePath)).groups.find(g => g.chatId === 'new').readingLevel, 'overview');
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('Reading hierarchy, exclusions, discovery, bounded collection and card consistency passed.');

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'native-topic-namespace-')); setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { namespaceProfiles, nativeTopicBindings } = await import('../chat/feishu-native-topic-ids.mjs');
const { createFeishuTopicSource } = await import('../chat/feishu-web-topics.mjs');
const { broadcastAll } = await import('../chat/ws-clients.mjs');
const mask = 8315202684517816156n, seconds = '1791875913';
const sample = i => { const nativeId = String((BigInt(seconds) << 32n) + BigInt(i)); return { nativeId, threadId: 'omt_' + (BigInt(nativeId) ^ mask).toString(16).padStart(16, '0'), rootId: 'om_root' + i, chatId: 'oc_group' + i % 3, createdSeconds: seconds, position: String(i) }; };
const profile = { encoding: 'thread-xor64-v1', route: 'bot-2', tenantKey: 'tenant', appId: 'cli_test', mask: String(mask), samples: Array.from({ length: 16 }, (_, i) => sample(i + 1)) };
const config = () => ({ bindings: {}, nativeNamespaces: { version: 1, profiles: [structuredClone(profile)] } });
async function fixture(i, patch = {}) {
  const v = sample(i), target = { chatId: v.chatId, tenantKey: 'tenant', chatType: 'group', threadId: v.threadId, rootId: v.rootId };
  const s = { id: 's' + i, conversation: { connector: 'feishu', sourceRouteId: 'bot-2', target }, activity: { run: { state: 'running' } } };
  const summary = { messageId: v.rootId, appId: 'cli_test', chatId: v.chatId, tenantKey: 'tenant', chatType: 'group', threadId: v.threadId, createTime: seconds + '898', ...patch };
  const sourceContext = { connector: 'feishu', sourceRouteId: 'bot-2', messageId: v.rootId, chatId: v.chatId, tenantKey: 'tenant', threadId: v.threadId, createTime: seconds + '898' };
  const dir = join(home, 'feishu-connectors/bot-2/state/inbox/archive'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, createHash('sha256').update(v.rootId).digest('hex').slice(0, 24) + '.json'), JSON.stringify({ id: v.rootId, summary, submission: { payload: { sourceContext } } }));
  return { v, s };
}
test('new topic resolves with empty legacy bindings and no Mini/network/first reply', async () => {
  const { v, s } = await fixture(50);
  assert.deepEqual(await nativeTopicBindings([s], [v.nativeId], config(), home), { [v.rootId]: v.nativeId });
  assert.deepEqual(await nativeTopicBindings([s], ['10000000000000000'], config(), home), {});
  const source = createFeishuTopicSource({ configDir: home, bindings: async () => config(), sessions: async () => [s], session: async () => s });
  const result = await source.snapshot([v.nativeId], '', null, [], false);
  assert.equal(result.entries[0].sessionId, s.id); assert.equal(result.entries[0].status, 'running');
  const ack = []; s.lastAssistantMessageAt = Number(seconds) * 1000; s.activity.run.state = 'idle';
  const reviewer = createFeishuTopicSource({ configDir: home, bindings: async () => config(), sessions: async () => [s], session: async () => s, acknowledge: async (...args) => ack.push(args) });
  await reviewer.review(v.nativeId, new Date(s.lastAssistantMessageAt).toISOString()); assert.equal(ack[0][0], s.id);
});
test('wrong app/tenant, non-root, timestamp mismatch, private and missing envelopes fail closed', async () => {
  for (const [i, patch] of [[60, { appId: 'cli_other' }], [61, { tenantKey: 'other' }], [62, { rootId: 'om_another' }], [63, { createTime: '1791875914898' }]]) {
    const { v, s } = await fixture(i, patch); assert.deepEqual(await nativeTopicBindings([s], [v.nativeId], config(), home), {});
  }
  const { v, s } = await fixture(64); s.conversation.target.chatType = 'p2p'; assert.deepEqual(await nativeTopicBindings([s], [v.nativeId], config(), home), {});
  s.conversation.target.chatType = 'group'; s.conversation.target.rootId = 'om_missing'; assert.deepEqual(await nativeTopicBindings([s], [v.nativeId], config(), home), {});
});
test('namespace enrollments must have independently distinct consistent samples', () => {
  assert.equal(namespaceProfiles(config().nativeNamespaces).length, 1);
  for (const alter of [p => p.samples.pop(), p => p.samples[1] = p.samples[0], p => p.mask = '1', p => p.samples.forEach(s => s.chatId = 'oc_same'), p => p.samples[0].createdSeconds = '1791875914']) {
    const c = config(); alter(c.nativeNamespaces.profiles[0]); assert.equal(namespaceProfiles(c.nativeNamespaces).length, 0);
  }
  const c = config(); c.nativeNamespaces.profiles.push(profile); assert.equal(namespaceProfiles(c.nativeNamespaces).length, 0);
});
test('conflicting bindings and duplicate source Sessions never select a winner', async () => {
  const { v, s } = await fixture(70), c = config(); c.bindings.otherRoot = v.nativeId;
  assert.deepEqual(await nativeTopicBindings([s], [v.nativeId], c, home), {});
  const source = createFeishuTopicSource({ configDir: home, bindings: async () => config(), sessions: async () => [s, { ...s, id: 'duplicate' }], session: async id => ({ ...s, id }) });
  assert.equal((await source.snapshot([v.nativeId], '', null, [], false)).entries.length, 0);
});
test('a subscribed unseen topic resolves as soon as its accepted source Session arrives', async () => {
  const { v, s } = await fixture(80), records = [], deliveries = []; let wake;
  const next = () => new Promise(resolve => { wake = resolve; });
  const api = createFeishuTopicSource({ configDir: home, bindings: async () => config(), sessions: async () => records, session: async () => s });
  const first = next(), off = await api.subscribe([v.nativeId], data => { deliveries.push(data); wake?.(); }, e => { throw e; }, [], false); await first;
  assert.equal(deliveries[0].entries.length, 0); records.push(s);
  const changed = next(); broadcastAll({ type: 'session_invalidated', sessionId: s.id }); await changed; off();
  assert.equal(deliveries.at(-1).entries[0].sessionId, s.id);
});

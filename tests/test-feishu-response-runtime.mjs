import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'feishu-response-runtime-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
process.env.REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await mkdir(join(home, 'bin'));
const executable = join(home, 'bin/response-native');
const response = '<private>feishu-response:{"replyMode":"thread","requestIds":["response-root","response-link"],"reaction":"Get"}</private>已读链接，并结合原问题回答。';
const fixture = await readFile(new URL('./fixtures/native-codex-app-server.cjs', import.meta.url), 'utf8');
await writeFile(executable, fixture.replace("finalText = 'durable native answer'", `finalText = ${JSON.stringify(response)}`));
await chmod(executable, 0o755);
const silentExecutable = join(home, 'bin/response-silent');
await writeFile(silentExecutable, fixture.replace("finalText = 'durable native answer'", "finalText = ''"));
await chmod(silentExecutable, 0o755);
process.env.PATH = join(home, 'bin') + ':' + process.env.PATH;
await writeFile(join(dir, 'tools.json'), JSON.stringify([{ id: 'response-native', name: 'Isolated response fixture',
  command: 'response-native', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'response-silent', name: 'Silent fixture', command: 'response-silent', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' }]));
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: 'A', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
] }));
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 1, enabled: true,
  groups: [{ sourceRouteId: 'bot', chatId: 'group', tenantKey: 'tenant', folder: home }] }));
await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
const manager = await import('../chat/session-manager.mjs');
const { requests } = await import('../chat/requests.mjs');
const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
const { loadHistory } = await import('../chat/history.mjs');
const actor = { personId: 'person_a', identityId: 'identity_a' };
const setting = await loadPersonMessageReplies(actor);
await changePersonMessageReplies({ action: 'apply', expectedRevision: setting.revision, confirm: true,
  choices: { ...setting.choices, routing: 'experimental' } }, actor);
async function until(predicate) {
  const deadline = Date.now() + 20000;
  let delay = 250;
  do {
    const result = await predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(2000, delay * 2);
  } while (Date.now() < deadline);
  throw new Error('Isolated native response did not settle');
}
try {
  const origin = { connector: 'feishu', sourceRouteId: 'bot', target: {
    chatId: 'group', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId: 'response-root',
  } };
  const session = await manager.createSession(home, 'response-native', 'Response fixture', {
    sourceId: 'feishu', conversation: origin, groupFeed: true,
  });
  const opts = id => ({ tool: 'response-native', requestId: id, viewPersonId: 'person_a',
    initiatedByIdentityId: 'identity_a', feishuConnectorAuthenticated: true, allowGroupFeedWrite: true,
    sourceDelivery: { ...origin, target: { ...origin.target, messageId: id } },
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'group', chatType: 'group',
      messageId: id, sender: { openId: 'a', senderType: 'user' },
      feishuParticipation: 'ambient', feishuReplyPlacementVersion: 1 },
  });
  const root = await manager.submitHttpMessage(session.id, '核对这些分类。', [], opts('response-root'));
  await until(async () => (await requests.byRunId(root.run.id))?.preparedAt);
  await manager.submitHttpMessage(session.id, 'PUBLISH_FINAL_EARLY 补充链接，请一起考虑。', [], opts('response-link'));
  const extra = await until(async () => { const r = await requests.byRequest(session.id, 'response-link'); return r?.nativeReceipt?.accepted && r; });
  assert.equal(extra.nativeDispatchRunId, root.run.id);
  const early = await until(async () => { const r = await requests.byRunId(root.run.id); return r?.mainlineReply && r; });
  assert.equal(early.result, null, 'answer must publish before the continuing execution ends');
  assert.deepEqual(early.deliveries.map(d => d.kind), ['reaction', 'content']);
  await writeFile(join(home, `${root.run.id}.release`), 'release');
  const result = await until(async () => { const r = await requests.byRunId(root.run.id); return r?.result && r; });
  const extraResult = await until(async () => { const r = await requests.byRequest(session.id, 'response-link'); return r?.result && r; });
  assert.equal(result.result.state, 'completed', JSON.stringify(result.responseDecisionErrors));
  assert.equal(extraResult.result.state, 'completed', JSON.stringify(extraResult.result));
  assert.deepEqual(result.deliveries.map(d => d.kind), ['reaction', 'content']);
  assert.equal(result.deliveries[1].target.conversationKind, 'thread');
  assert.match(result.deliveries[1].text, /已读链接/);
  assert.doesNotMatch(result.deliveries[1].text, /feishu-response|尚未完成/);
  assert.equal(extraResult.deliveries.length, 0);
  const history = await loadHistory(session.id, { includeBodies: true });
  assert.equal(history.filter(e => e.type === 'work_event' && e.action === 'mainline-input-reply').length, 1);
  assert(!history.some(e => e.type === 'tool_use' && /work reply/.test(JSON.stringify(e))),
    'native final owns coverage without an additional model tool call');
  // Real group regression: a code link followed by an @mention of another
  // human reaches the same native turn. Empty model finals must stay empty;
  // missing input bookkeeping remains internal instead of creating a reply.
  const silentSession = await manager.createSession(home, 'response-silent', 'Human discussion fixture', {
    sourceId: 'feishu', conversation: origin, groupFeed: true,
  });
  const silentOpts = id => ({ ...opts(id), tool: 'response-silent' });
  const silentRoot = await manager.submitHttpMessage(silentSession.id, '这里是代码链接。', [], silentOpts('silent-link'));
  await until(async () => (await requests.byRunId(silentRoot.run.id))?.preparedAt);
  await manager.submitHttpMessage(silentSession.id, '@同事 这个拉了不？', [], silentOpts('silent-mention'));
  await until(async () => (await requests.byRequest(silentSession.id, 'silent-mention'))?.nativeReceipt?.accepted);
  await writeFile(join(home, `${silentRoot.run.id}.release`), 'release');
  const silentResult = await until(async () => { const r = await requests.byRequest(silentSession.id, 'silent-mention'); return r?.result && r; });
  assert.equal(silentResult.result.state, 'failed', 'omission is not falsely marked as handled');
  assert.match(silentResult.result.error, /尚未完成/);
  assert.equal(silentResult.deliveries.length, 0, 'transport does not speak over the silent model');
  assert.equal((await requests.byRunId(silentRoot.run.id)).deliveries.length, 0);
  console.log('FEISHU_RESPONSE_RUNTIME_VERIFIED: real admission, native steer, final projection and per-input settlement publish one combined answer and reaction; no Feishu or model network.');
} finally {
  await manager.killAll();
  process.once('beforeExit', async () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

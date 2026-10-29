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
const plainExecutable = join(home, 'bin/response-plain');
await writeFile(plainExecutable, fixture);
await chmod(plainExecutable, 0o755);
const resumeExecutable = join(home, 'bin/response-resume');
const resumeText = '<private>feishu-response:{"replyMode":"thread","requestIds":["resume-old","resume-current"]}</private>接续任务已完成，页面已上线。';
await writeFile(resumeExecutable, fixture.replace("finalText = 'durable native answer'", `finalText = ${JSON.stringify(resumeText)}`)
  .replace("notify('turn/started', { turn: { id: activeTurn, status: 'inProgress' } });",
    "notify('turn/started', { turn: { id: activeTurn, status: 'inProgress' } }); if (text.includes('FAIL_RESUME_INITIAL')) finish('failed', false);"));
await chmod(resumeExecutable, 0o755);
const liveExecutable = join(home, 'bin/response-live');
const liveFirst = '<private>feishu-response:{"replyMode":"inline"}</private>第一条已回答。';
const liveNext = '<private>feishu-response:{"replyMode":"inline","requestIds":["live-root","live-extra","live-followup"]}</private>补问也已回答。';
await writeFile(liveExecutable, fixture.replace("finalText = 'durable native answer'", `finalText = ${JSON.stringify(liveNext)}`)
  .replace("if (text.includes('RELEASE_NATIVE')) finish();", `
    if (text.includes('PUBLISH_RESPONSE_FIRST')) notify('item/completed', { turnId: activeTurn,
      item: { id: 'live-first', type: 'agentMessage', phase: 'final_answer', text: ${JSON.stringify(liveFirst)} } });
    if (text.includes('RELEASE_NATIVE')) finish();`));
await chmod(liveExecutable, 0o755);
process.env.PATH = join(home, 'bin') + ':' + process.env.PATH;
await writeFile(join(dir, 'tools.json'), JSON.stringify([{ id: 'response-native', name: 'Isolated response fixture',
  command: 'response-native', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'response-silent', name: 'Silent fixture', command: 'response-silent', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'response-plain', name: 'Plain final fixture', command: 'response-plain', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'response-resume', name: 'Continuation fixture', command: 'response-resume', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'response-live', name: 'Live fixture', command: 'response-live', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' }]));
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: 'A', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
] }));
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 1, enabled: true,
  groups: [{ sourceRouteId: 'bot', chatId: 'group', tenantKey: 'tenant', folder: home }] }));
await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
const manager = await import('../chat/session-manager.mjs');
const { requests } = await import('../chat/requests.mjs');
const { claimSourceDelivery, completeSourceDelivery } = await import('../chat/source-deliveries.mjs');
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
      feishuParticipation: 'ambient', feishuReplyPlacementVersion: 1, feishuResponseProtocolVersion: 1 },
  });
  const root = await manager.submitHttpMessage(session.id, '核对这些分类。', [], opts('response-root'));
  await until(async () => (await requests.byRunId(root.run.id))?.preparedAt);
  await manager.submitHttpMessage(session.id, '补充链接，请一起考虑。', [], opts('response-link'));
  const extra = await until(async () => { const r = await requests.byRequest(session.id, 'response-link'); return r?.nativeReceipt?.accepted && r; });
  assert.equal(extra.nativeDispatchRunId, root.run.id);
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

  // Two actual executions in one topic: fail, then "continue". The native
  // final refers to both inputs, but the new reply only settles its own input.
  const resumeOrigin = { ...origin, sourceRouteId: 'resume-bot', target: { ...origin.target,
    conversationKind: 'thread', threadId: 'resume-topic', rootId: 'resume-anchor', replyInThread: true } };
  const resumeSession = await manager.createSession(home, 'response-resume', 'Continuation fixture', {
    sourceId: 'feishu', conversation: resumeOrigin,
  });
  const resumeOpts = id => ({ ...opts(id), tool: 'response-resume',
    sourceContext: { ...opts(id).sourceContext, sourceRouteId: 'resume-bot' },
    sourceDelivery: { ...resumeOrigin, target: { ...resumeOrigin.target, messageId: id } } });
  const oldRun = await manager.submitHttpMessage(resumeSession.id, 'FAIL_RESUME_INITIAL', [], resumeOpts('resume-old'));
  const failed = await until(async () => { const r = await requests.byRunId(oldRun.run.id); return r?.result && r.releasedAt && r; });
  assert.equal(failed.result.state, 'failed');
  for (let claim; (claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'resume-bot' }));) {
    await completeSourceDelivery(claim.delivery.id, claim.leaseId, { externalId: 'fixture-old-failure' });
  }
  const resumedRun = await manager.submitHttpMessage(resumeSession.id, '继续', [], resumeOpts('resume-current'));
  assert.notEqual(resumedRun.run.id, oldRun.run.id);
  await until(async () => (await requests.byRunId(resumedRun.run.id))?.preparedAt);
  await writeFile(join(home, `${resumedRun.run.id}.release`), 'release');
  const resumed = await until(async () => { const r = await requests.byRunId(resumedRun.run.id); return r?.result && r; });
  assert.equal(resumed.result.state, 'completed', JSON.stringify(resumed.responseDecisionErrors));
  assert.deepEqual(resumed.mainlineReply.contract.requestIds, ['resume-current']);
  assert.equal(resumed.deliveries.filter(d => d.kind === 'content').length, 1);
  const resumeClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'resume-bot' });
  assert.match(resumeClaim.delivery.text, /接续任务已完成/);
  assert.doesNotMatch(resumeClaim.delivery.text, /字段无效|尚未完成投递/);
  assert.equal(resumeClaim.delivery.target.threadId, 'resume-topic');
  await completeSourceDelivery(resumeClaim.delivery.id, resumeClaim.leaseId, { externalId: 'fixture-resumed-answer' });
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'resume-bot' }), null);
  assert.deepEqual((await requests.byRunId(oldRun.run.id)).result, failed.result);

  // Observe the first final while the native peer deliberately remains open,
  // then a second final after the root's reply has suppressed its fallback.
  const liveSession = await manager.createSession(home, 'response-live', 'Live response fixture', {
    sourceId: 'feishu', conversation: { ...origin, sourceRouteId: 'live-bot' }, groupFeed: true,
  });
  const liveOpts = id => ({ ...opts(id), tool: 'response-live',
    sourceDelivery: { ...opts(id).sourceDelivery, sourceRouteId: 'live-bot' } });
  const liveRoot = await manager.submitHttpMessage(liveSession.id, '直接回复测速。', [], liveOpts('live-root'));
  await until(async () => (await requests.byRunId(liveRoot.run.id))?.preparedAt);
  await manager.submitHttpMessage(liveSession.id, 'PUBLISH_RESPONSE_FIRST', [], liveOpts('live-extra'));
  const firstReply = await until(async () => {
    const r = await requests.byRunId(liveRoot.run.id); return r?.mainlineReply && r;
  });
  assert.equal(firstReply.result, null, 'first reply is queued before turn completion');
  assert.equal(firstReply.deliveries.filter(d => d.kind === 'content').length, 1);
  assert.match(firstReply.deliveries[0].text, /第一条已回答/);
  const firstClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'live-bot' });
  assert.equal(firstClaim.delivery.providerMessageId, 'live-first', 'connector can claim the answer while native work continues');
  await completeSourceDelivery(firstClaim.delivery.id, firstClaim.leaseId, { externalId: 'fixture-first' });
  await manager.submitHttpMessage(liveSession.id, 'PUBLISH_FINAL_EARLY', [], liveOpts('live-followup'));
  const secondReply = await until(async () => {
    const r = await requests.byRequest(liveSession.id, 'live-extra'); return r?.mainlineReply && r;
  });
  assert.equal((await requests.byRunId(liveRoot.run.id)).result, null);
  assert.match(secondReply.deliveries[0].text, /补问也已回答/);
  assert.deepEqual(secondReply.mainlineReply.contract.requestIds, ['live-extra', 'live-followup']);
  const secondClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'live-bot' });
  assert.match(secondClaim.delivery.text, /补问也已回答/);
  await completeSourceDelivery(secondClaim.delivery.id, secondClaim.leaseId, { externalId: 'fixture-second' });
  await writeFile(join(home, `${liveRoot.run.id}.release`), 'release');
  const liveResult = await until(async () => { const r = await requests.byRunId(liveRoot.run.id); return r?.result && r; });
  assert.equal(liveResult.result.state, 'completed', JSON.stringify(liveResult.responseDecisionErrors));
  assert.equal(liveResult.deliveries.filter(d => d.kind === 'content').length, 1);
  assert.equal((await requests.byRequest(liveSession.id, 'live-extra')).deliveries.filter(d => d.kind === 'content').length, 1);
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'live-bot' }), null,
    'settlement cannot re-enqueue either delivered answer');
  // A rejected structural final emits a platform notice, not a receipt for
  // the model's unpublished text. The next native turn must see that notice.
  const rejectedSession = await manager.createSession(home, 'response-native', 'Rejected publication fixture', {
    sourceId: 'feishu', conversation: origin, groupFeed: true,
  });
  // This fixture deliberately names the previous execution's input IDs.
  const rejectedRoot = await manager.submitHttpMessage(rejectedSession.id, '核查发布失败。', [], opts('rejected-root'));
  await until(async () => (await requests.byRunId(rejectedRoot.run.id))?.preparedAt);
  await writeFile(join(home, `${rejectedRoot.run.id}.release`), 'release');
  const rejectedResult = await until(async () => {
    const r = await requests.byRunId(rejectedRoot.run.id); return r?.result && r;
  });
  assert.equal(rejectedResult.result.state, 'failed');
  const failureNotice = rejectedResult.deliveries.find(d => /回复决定中的消息/.test(d.text || ''));
  assert.ok(failureNotice, 'structural rejection remains visible');
  assert.equal(failureNotice.providerMessageId, undefined, 'platform notice is not native model output');
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
  // Screenshot regression: an ordinary final omitted the display marker and
  // was replaced with "未明确选择发送位置" despite its known source address.
  const plainOrigin = { ...origin, sourceRouteId: 'plain-bot' };
  const plainSession = await manager.createSession(home, 'response-plain', 'Plain response fixture', {
    sourceId: 'feishu', conversation: plainOrigin, groupFeed: true,
  });
  const plainOptions = opts('plain-root');
  plainOptions.tool = 'response-plain';
  plainOptions.sourceContext = { ...plainOptions.sourceContext, sourceRouteId: 'plain-bot', feishuThreadSessionVersion: 1 };
  plainOptions.sourceDelivery = { ...plainOrigin, target: { ...plainOrigin.target, messageId: 'plain-root' } };
  const plainRoot = await manager.submitHttpMessage(plainSession.id, '你如何看待现在的回复速度？', [], plainOptions);
  await until(async () => (await requests.byRunId(plainRoot.run.id))?.preparedAt);
  await writeFile(join(home, `${plainRoot.run.id}.release`), 'release');
  const plainResult = await until(async () => { const r = await requests.byRunId(plainRoot.run.id); return r?.result && r; });
  assert.equal(plainResult.result.state, 'completed', JSON.stringify(plainResult.result));
  const plainDeliveries = plainResult.deliveries.filter(d => d.kind === 'content');
  assert.equal(plainDeliveries.length, 1, 'native and legacy publication cannot duplicate the plain final');
  assert.match(plainDeliveries[0].text, /durable native answer/);
  assert.equal(plainDeliveries[0].target.conversationKind, 'main');
  const plainClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'plain-bot' });
  assert.match(plainClaim.delivery.text, /durable native answer/);
  await completeSourceDelivery(plainClaim.delivery.id, plainClaim.leaseId, { externalId: 'fixture-plain' });
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'plain-bot' }), null);
  console.log('FEISHU_RESPONSE_RUNTIME_VERIFIED: real admission, native steer, final projection and per-input settlement publish one combined answer and reaction; no Feishu or model network.');
} finally {
  await manager.killAll();
  process.once('beforeExit', async () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

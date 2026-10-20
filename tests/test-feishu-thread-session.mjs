import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-thread-session-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a',
  people: [{ id: 'person_a', name: 'Human', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] }] }));
const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: {
  chatId: 'group', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId: 'root',
} };
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify([
  { id: 'main', folder: home, tool: 'codex', conversation, groupFeed: true },
]));
try {
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  const { requests } = await import('../chat/requests.mjs');
  const { createSession } = await import('../chat/session-manager.mjs');
  const { findSessionMeta, loadSessionsMeta } = await import('../chat/session-meta-store.mjs');
  const { routeGroupWork, buildGroupRoutingContext } = await import('../chat/group-routing.mjs');
  const { findSessionConversation, updateSessionConversation } = await import('../chat/session-conversations.mjs');
  const { resolveAmbientFeishuReplyPlan } = await import('../chat/ambient-feishu-reply.mjs');
  const { canForwardNativeRequest } = await import('../chat/native-request-dispatch.mjs');
  const { findFeishuThreadSessionBinding } = await import('../connectors/feishu/session-flow.mjs');
  const options = { feishuConnectorAuthenticated: true, viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a',
    messageRoutingPolicy: { mechanism: 'disabled' }, sourceDelivery: conversation,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatType: 'group', chatId: 'group',
      tenantKey: 'tenant', sender: { senderType: 'user' }, feishuParticipation: 'ambient',
      feishuResponseProtocolVersion: 1, feishuReplyPlacementVersion: 1, feishuThreadSessionVersion: 1 } };
  const accept = async (id, extra = {}, images = []) => (await requests.accept({ sessionId: 'main', requestId: id,
    text: 'Original human question', images, options: { ...options, ...extra }, deliveryPlan: conversation,
    runtimeSelection: { tool: 'codex', model: 'fixture' } })).record;
  const originalAttachments = [{ assetId: 'fasset_fixture', originalName: 'original.png' }];
  const first = await accept('first', {}, originalAttachments);
  const context = await buildGroupRoutingContext(await findSessionMeta('main'), options.sourceContext,
    { messageRoutingPolicy: options.messageRoutingPolicy });
  assert.match(context, /mode:new/);
  assert.doesNotMatch(context, /不使用 work route/);
  const marker = [{ type: 'message', role: 'assistant', content: '<private>feishu-response:{"replyMode":"thread"}</private>Opening' }];
  assert.equal(resolveAmbientFeishuReplyPlan(first, conversation, marker), null,
    'a display marker cannot create another mainline-owned thread');
  assert.equal(resolveAmbientFeishuReplyPlan({ ...first, options: { ...options,
    sourceContext: { ...options.sourceContext, feishuThreadSessionVersion: undefined } } }, conversation, marker).target.conversationKind, 'thread',
    'already accepted legacy inputs retain their frozen contract');
  let submissions = 0;
  const manager = { createSession, submitHttpMessage: async (id, text, images, opts) => {
    const result = await requests.accept({ sessionId: id, requestId: opts.requestId, text,
      images, options: opts, deliveryPlan: opts.sourceDelivery });
    if (!result.duplicate) submissions++;
    return { requestId: result.record.requestId, runId: result.record.runId };
  } };
  const packet = { mode: 'new', task: 'Investigate the question', reason: 'Needs an independent discussion' };
  const [a, b] = await Promise.all([routeGroupWork(first, packet, manager), routeGroupWork(first, packet, manager)]);
  assert.equal(a.targetSessionId, b.targetSessionId);
  assert.notEqual(a.targetSessionId, 'main');
  assert.equal(submissions, 1);
  assert.equal((await loadSessionsMeta()).length, 2, 'concurrent retries create exactly one Session');
  const child = await findSessionMeta(a.targetSessionId);
  assert.equal(child.conversation.target.conversationKind, 'thread');
  assert.equal(child.conversation.target.rootId, 'root');
  const admitted = await requests.byRequest(child.id, 'routed:first');
  assert.match(admitted.text, /Original human question/);
  assert.deepEqual(admitted.options.preSavedAttachments, originalAttachments, 'handoff retains original attachment identities');
  assert.equal(admitted.options.sourceContext.conversationKind, 'thread');
  assert.equal(admitted.options.sourceContext.feishuThreadSessionVersion, undefined);
  assert.equal((await requests.get(first.key)).options.suppressSourceDelivery, true);
  assert.equal((await requests.get(first.key)).deliveries?.length || 0, 0, 'no duplicate mainline body or forced reaction');
  await updateSessionConversation(child.id, child.conversation, { receipt: { messageId: 'opening', threadId: 'omt_real' } });
  const followup = { ...conversation, target: { ...conversation.target, conversationKind: 'thread',
    rootId: 'root', threadId: 'omt_real', messageId: 'human-followup' } };
  assert.equal((await findSessionConversation(followup)).id, child.id);
  const runtime = { config: { sourceRouteId: 'bot' }, storagePaths: {}, requestRemoteLab: async (_path, input) => ({
    response: { ok: true }, json: { sessionId: (await findSessionConversation(input.body.conversation))?.id },
  }) };
  for (const chatMode of ['group', 'topic']) {
    const binding = await findFeishuThreadSessionBinding(runtime, { ...followup.target, chatMode });
    assert.equal(binding.sessionId, child.id, 'ordinary threads and topic groups share Session resolution');
  }
  const { findFeishuSessionBinding } = await import('../connectors/feishu/session-flow.mjs');
  for (const groupFeed of [false, true]) {
    runtime.config.groups = { group: { groupFeed } };
    assert.equal((await findFeishuSessionBinding(runtime, conversation.target)).sessionId, 'main',
      'mainline lookup keeps its owner when group-feed configuration changes');
  }
  const next = { key: 'next', options: { ...admitted.options, sourceDelivery: followup }, runtimeSelection: {} };
  const head = { ...admitted, runtimeSelection: {} };
  assert.equal(canForwardNativeRequest(next, head), true, 'in-flight topic additions use native steer');
  await requests.mutate(admitted.key, r => ({ ...r, result: { state: 'completed' }, releasedAt: new Date().toISOString() }));
  await requests.archiveFinished(admitted.key);
  assert.equal((await findSessionConversation(followup)).id, child.id, 'completion does not end the topic');
  const moduleUrl = new URL('../chat/session-conversations.mjs', import.meta.url).href;
  const cold = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const {findSessionConversation}=await import(${JSON.stringify(moduleUrl)}); console.log((await findSessionConversation(${JSON.stringify(followup)})).id);`], { env: process.env });
  assert.equal(cold.stdout.trim(), child.id, 'a cold process reuses the durable binding');
  assert.equal(await findSessionConversation({ ...followup, sourceRouteId: 'other-bot' }), null);
  const second = await accept('second');
  await assert.rejects(routeGroupWork(second, { ...packet, mode: 'continue', targetSessionId: child.id }, manager), /disabled/,
    'opening own thread does not authorize cross-session routing');
  const unauthenticated = await accept('unauthenticated', { feishuConnectorAuthenticated: false });
  await assert.rejects(routeGroupWork(unauthenticated, packet, manager), /authenticated human/);
  console.log('PASS: independent thread Session, native additions, post-completion follow-up, cold restart, retry deduplication and scope boundaries');
} finally { await rm(home, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const baseline = process.argv[2] === '--baseline';
const root = baseline ? pathToFileURL(resolve(process.argv[3]) + '/') : new URL('../', import.meta.url);
const load = path => import(new URL(path, root));
const home = await mkdtemp(join(tmpdir(), 'explicit-handoff-'));
setIsolatedTestHome(home);
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'a', people: [
  { id: 'a', name: 'Author', identities: [{ id: 'ia', kind: 'web', subjectId: 'a' }] },
  { id: 'b', name: 'Other', identities: [{ id: 'ib', kind: 'web', subjectId: 'b' }] },
] }));
const conversation = (chatId, kind = 'thread') => ({ connector: 'feishu', sourceRouteId: 'bot',
  target: { tenantKey: 'tenant', chatId, chatType: 'group', conversationKind: kind,
    rootId: 'root-' + chatId, threadId: 'root-' + chatId, messageId: 'root-' + chatId, replyInThread: true } });
const source = { id: 'source', name: 'Memory', folder: home, conversation: conversation('source') };
const target = { id: 'target', name: 'Settings', folder: home, conversation: conversation('destination'), workSummary: { goal: 'Settings card' } };
await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([source, target]));
const config = { version: 2, enabled: true, personalOptIn: true, crossGroupSync: true, trialId: 'test',
  groups: ['source', 'destination'].map(chatId => ({ sourceRouteId: 'bot', chatId, tenantKey: 'tenant', folder: home })) };
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify(config));
await (await load('lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
const { requests } = await load('chat/requests.mjs');
const { findSessionMeta, mutateSessionMeta } = await load('chat/session-meta-store.mjs');
const { routeGroupWork, readGroupRoutingState, validateGroupRethink } = await load('chat/group-routing.mjs');
const discoveryModule = await load('chat/work-routing-discovery.mjs');
const options = { viewPersonId: 'a', initiatedByIdentityId: 'ia', feishuConnectorAuthenticated: true,
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'source', chatType: 'group', messageId: 'human',
    createTime: String(Date.now()), sender: { senderType: 'user', openId: 'a' } }, sourceDelivery: source.conversation,
  messageRoutingPolicy: { version: 1, mechanism: 'none' } };
const quote = '把这条设置卡修改和附件转交到 destination 群的 Settings 话题，结果回这里。';
const input = async (id, extra = {}) => (await requests.accept({ sessionId: source.id, requestId: id,
  text: quote, images: [{ name: 'card.png', path: '/fixture/card.png' }], options: { ...options, ...extra }, deliveryPlan: source.conversation })).record;
const body = record => ({ mode: 'handoff', task: '修改设置卡', reason: '明确要求转交', targetSessionId: target.id,
  authorization: { sourceRequestId: record.requestId, quote } });
const enabled = { messageRoutingPolicy: { version: 1, mechanism: 'experimental', trialVersion: 2, trialId: 'test', personId: 'a' } };
let admissions = 0, failBefore = false, loseAck = false, receiptFails = false;
const deps = {
  submitHttpMessage: async (sessionId, text, images, supplied) => {
    if (failBefore) throw Error('target unavailable before admission');
    const accepted = await requests.accept({ sessionId, requestId: supplied.requestId, text,
      images: supplied.preSavedAttachments, options: supplied, deliveryPlan: supplied.sourceDelivery });
    if (!accepted.duplicate) admissions++;
    await mutateSessionMeta(target.id, s => { s.workAwareness = { intents: [{ id: 'new-intent-' + admissions }] }; return true; });
    if (loseAck) throw Error('lost acknowledgement');
    return { requestId: accepted.record.requestId, run: { id: accepted.record.runId } };
  },
  enqueueSourceDelivery: async () => { if (receiptFails) throw Error('receipt unavailable'); return { id: 'receipt' }; },
};
try {
  if (baseline) {
    const disabled = await input('disabled');
    const t = performance.now();
    await assert.rejects(routeGroupWork(disabled, body(disabled), deps), /routing is disabled/);
    const explicit = await input('enabled', enabled);
    const draft = await routeGroupWork(explicit, body(explicit), deps);
    assert.equal(draft.proposal.state, 'draft'); assert.equal(admissions, 0);
    await mutateSessionMeta(target.id, s => { s.conversation.target.conversationKind = 'topic'; return true; });
    const legacy = await input('legacy', enabled);
    await assert.rejects(routeGroupWork(legacy, body(legacy), deps), /existing human work topic/);
    console.log(JSON.stringify({ baseline: true, assertions: ['automatic preference rejects explicit request', 'explicit instruction still needs another human round', 'legacy topic rejected'], admissions, elapsedMs: +(performance.now() - t).toFixed(2) }));
  } else {
    // Ordinary inputs remain local. No heuristic dispatch occurs at admission.
    const steer = await input('steer');
    assert.equal((await findSessionMeta(source.id)).groupRouting, undefined);
    const { buildMisroutePrompt, routingDiscovery } = discoveryModule;
    assert.match(buildMisroutePrompt(options.sourceContext), /补充、纠正、追问和明确改目标直接接续/);
    assert.match(buildMisroutePrompt(options.sourceContext), /目标不明时用原生提问只问具体去向/);
    const unknown = await input('unknown', enabled);
    const draft = await routeGroupWork(unknown, { ...body(unknown), authorization: undefined }, deps);
    assert(draft.question); assert.equal(admissions, 0, 'uncertain destination remains a question');
    const offDraft = await routeGroupWork(steer, { ...body(steer), authorization: undefined }, deps);
    assert(offDraft.question); assert.equal(admissions, 0, 'draft can ask without opting into automatic routing');
    await assert.rejects(routeGroupWork(steer, { mode: 'new', task: 'new', reason: 'new' }, deps), /routing is disabled/);
    for (const authorization of [{ sourceRequestId: 'other', quote }, { sourceRequestId: steer.requestId, quote: 'invented' }, true]) {
      await assert.rejects(routeGroupWork(steer, { ...body(steer), authorization }, deps), /exact quote/);
    }
    for (const extra of [{ feishuConnectorAuthenticated: false }, { initiatedByIdentityId: 'ib' },
      { internalOperation: true }, { sourceContext: { ...options.sourceContext, sender: { senderType: 'bot' } } }]) {
      const invalid = await input('invalid-' + JSON.stringify(extra), extra);
      await assert.rejects(routeGroupWork(invalid, body(invalid), deps), /human Feishu/);
    }
    // Legal resource boundary stays in place regardless of explicit wording.
    const denied = await input('outside');
    const configPath = join(dir, 'group-routing-pilot.json');
    await writeFile(configPath, JSON.stringify({ ...config, crossGroupSync: false }));
    await assert.rejects(routeGroupWork(denied, body(denied), deps), /registered Bot, tenant or group scope/);
    await writeFile(configPath, JSON.stringify({ ...config, enabled: false }));
    await assert.rejects(routeGroupWork(denied, body(denied), deps), /source is outside/);
    await writeFile(configPath, JSON.stringify(config));
    for (const conv of [conversation('not-registered'), { ...target.conversation, sourceRouteId: 'other-bot' },
      { ...target.conversation, target: { ...target.conversation.target, tenantKey: 'other-tenant' } }]) {
      await mutateSessionMeta(target.id, s => { s.conversation = conv; return true; });
      await assert.rejects(routeGroupWork(denied, body(denied), deps), /registered Bot, tenant or group scope/);
    }
    await mutateSessionMeta(target.id, s => { s.conversation = conversation('destination', 'topic'); return true; });
    const otherAuthor = await input('other-author', { viewPersonId: 'b', initiatedByIdentityId: 'ib' });
    await assert.rejects(routeGroupWork(steer, { ...body(steer), requestIds: [otherAuthor.requestId] }, deps), /Original human input/);
    const explicit = await input('explicit');
    const start = performance.now();
    const sent = await routeGroupWork(explicit, body(explicit), deps);
    const handoffMs = performance.now() - start;
    assert(!sent.question); assert.equal(admissions, 1);
    const copied = await requests.byRequest(target.id, 'routing-handoff:' + sent.proposalId);
    assert.deepEqual(copied.images, explicit.images);
    assert.equal(copied.options.initiatedByIdentityId, 'ia');
    assert.deepEqual(copied.options.confirmedHandoff.authorization, { ...body(explicit).authorization, personId: 'a', identityId: 'ia' });
    assert.deepEqual(copied.options.confirmedHandoff.originals[0].sourceContext, options.sourceContext);
    await validateGroupRethink(copied);
    await routeGroupWork(explicit, body(explicit), deps);
    await routeGroupWork(explicit, { mode: 'handoff', proposalId: sent.proposalId }, deps);
    assert.equal(admissions, 1, 'repeated explicit instruction and resume do not redispatch');
    const repeated = await input('repeated-original');
    await assert.rejects(routeGroupWork(repeated, { ...body(repeated), requestIds: [explicit.requestId] }, deps), /Original human input/);
    const failed = await input('failed'); failBefore = true;
    await assert.rejects(routeGroupWork(failed, body(failed), deps), /before admission/);
    assert.equal((await requests.get(failed.key)).routingHandoff, undefined, 'source keeps ownership on known failure');
    let p = (await readGroupRoutingState(await findSessionMeta(source.id))).proposals.find(p => p.sourceRequestId === failed.requestId);
    assert.match(p.lastError, /before admission/); assert.equal(p.state, 'approved');
    failBefore = false; loseAck = true;
    await assert.rejects(routeGroupWork(failed, { mode: 'handoff', proposalId: p.id }, deps), /lost acknowledgement/);
    assert.equal(admissions, 2); assert.equal((await requests.get(failed.key)).routingHandoff.state, 'reserved');
    loseAck = false; receiptFails = true;
    await assert.rejects(routeGroupWork(failed, { mode: 'handoff', proposalId: p.id }, deps), /receipt unavailable/);
    receiptFails = false;
    await routeGroupWork(failed, { mode: 'handoff', proposalId: p.id }, deps);
    assert.equal(admissions, 2);
    p = (await readGroupRoutingState(await findSessionMeta(source.id))).proposals.find(p => p.sourceRequestId === failed.requestId);
    assert(p.approvedAt && p.submittedAt); assert.equal(p.lastError, null);
    // A source command may forward older originals, but never approve for another author.
    const reads = [];
    const result = await routingDiscovery(source, 'a', { query: 'Settings card', sessions: [source,
      { ...target, id: 'main-is-not-a-handoff-topic', conversation: conversation('destination', 'main') },
      ...Array.from({ length: 1000 }, (_, i) => ({ ...target, id: 'candidate-' + i,
        ...(i < 10 ? {} : { name: 'Unrelated ' + i, workSummary: { goal: 'Unrelated ' + i } }) }))],
      history: async (id, opts) => { reads.push(id); assert.equal(opts.metadataOnly, true); return { lastUserMessageAt: Date.now() }; } });
    assert.equal(reads.length, 3); assert.equal(result.observation.transcriptReads, 0);
    assert.equal(result.candidates[0].handoff.mode, 'handoff');
    assert.equal(result.candidates[0].transfer, 'explicit-instruction-or-confirmed-draft');
    assert(!reads.includes('main-is-not-a-handoff-topic'));
    console.log(JSON.stringify({ explicitHandoffMs: +handoffMs.toFixed(2), extraHumanRounds: 0, discovery: result.observation,
      admissions, verified: 'steer preserved; ambiguous draft; explicit disabled-policy and legacy topic; unauthorized scope/author; original attachment/provenance; duplicate/lost acknowledgement/known failure/receipt recovery' }));
  }
} finally { await rm(home, { recursive: true, force: true }); }

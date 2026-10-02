#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'remotelab-source-delivery-http-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
const bin = join(home, '.local/bin');
await mkdir(config, { recursive: true });
await mkdir(bin, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({
  fixture: { expiry: Date.now() + 3600000, role: 'owner' },
  connector: { expiry: Date.now() + 3600000, role: 'owner', authKind: 'service' },
}));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'fake-codex', name: 'Fixture Codex',
  command: 'fake-codex', runtimeFamily: 'codex-json', models: [{ id: 'fake-model', label: 'Fixture' }] }]));
await writeFile(join(bin, 'fake-codex'), `#!/usr/bin/env node
(async () => {
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
await new Promise(resolve => setTimeout(resolve, 500));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture reply for delivery'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
await chmod(join(bin, 'fake-codex'), 0o755);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let logs = '';
function startServer() {
const child = spawn(process.execPath, ['chat-server.mjs'], { cwd: repo,
  env: { ...process.env, HOME: home, CHAT_PORT: String(port), SECURE_COOKIES: '0', REMOTELAB_PUBLIC_BASE_URL: 'https://fixture.example.test',
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH || ''}` },
  stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
return child;
}
let server = startServer();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timeout: ${label}\n${logs.slice(-3000)}`);
}
async function request(method, path, body) {
  const multipart = body instanceof FormData;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: 'session_token=fixture', ...(!multipart && body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
async function connectorRequest(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: 'session_token=connector', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
try {
  await waitFor(async () => {
    try { return (await request('GET', '/api/auth/me')).status === 200; } catch { return false; }
  }, 'server startup');
  const groupFeedConversation = { connector: 'feishu', sourceRouteId: 'pilot-bot',
    target: { chatId: 'pilot-group', tenantKey: 'pilot-tenant', chatType: 'group', conversationKind: 'main' } };
  const legacyGroup = await request('POST', '/api/sessions', {
    folder: home, tool: 'fake-codex', sourceId: 'feishu',
    externalTriggerId: 'feishu:main:pilot-bot:pilot-tenant:pilot-group',
    conversation: groupFeedConversation,
  });
  assert.equal(legacyGroup.status, 201);
  const deniedGroupFeed = await request('POST', '/api/sessions', {
    folder: home, tool: 'fake-codex', sourceId: 'feishu', groupFeed: true,
    conversation: groupFeedConversation,
  });
  assert.equal(deniedGroupFeed.status, 403, 'a browser cannot create a group conversation');
  const groupFeed = await connectorRequest('POST', '/api/sessions', {
    folder: home, tool: 'fake-codex', sourceId: 'feishu', groupFeed: true,
    externalTriggerId: 'feishu:group-feed:pilot-bot:pilot-tenant:pilot-group',
    conversation: groupFeedConversation, replaceConversation: true,
  });
  assert.equal(groupFeed.status, 201);
  assert.equal(groupFeed.body.session.groupFeed, true);
  assert.notEqual(groupFeed.body.session.id, legacyGroup.body.session.id,
    'the group-only route must begin with a clean Session');
  assert.equal((await request('GET', `/api/sessions/${legacyGroup.body.session.id}`)).body.session.conversation, null,
    'the old Session must not retain the group delivery binding');
  assert.equal(groupFeed.body.session.initiatedByIdentityId, 'identity_system',
    'group ownership must not depend on the first human sender');
  const groupFeedId = groupFeed.body.session.id;
  assert.equal((await connectorRequest('POST', '/api/sessions', {
    folder: home, tool: 'fake-codex', sourceId: 'feishu', groupFeed: true,
    externalTriggerId: 'feishu:group-feed:pilot-bot:pilot-tenant:pilot-group',
    conversation: groupFeedConversation, replaceConversation: true, systemPrompt: 'Updated observer rule',
  })).body.session.id, groupFeedId, 'later group messages reuse the new mainline');
  assert.equal((await request('GET', `/api/sessions/${groupFeedId}`)).body.session.conversation.target.chatId,
    'pilot-group', 'refreshing the observer instructions must preserve its binding');
  assert.equal((await request('POST', `/api/sessions/${groupFeedId}/messages`, { text: 'private contamination' })).status, 403);
  assert.equal((await request('PATCH', `/api/sessions/${groupFeedId}`, { name: 'hijacked' })).status, 403);
  assert.equal((await request('POST', '/api/sessions', {
    folder: home, tool: 'fake-codex', conversation: groupFeedConversation, replaceConversation: true,
  })).status, 403, 'browser cannot steal the group conversation binding');
  const observedSource = { connector: 'feishu', sourceRouteId: 'pilot-bot', tenantKey: 'pilot-tenant',
    chatId: 'pilot-group', messageId: 'observed-one', sender: { name: 'Ada', openId: 'person-1' } };
  const observePath = `/api/sessions/${groupFeedId}/observations`;
  const observation = { sourceMessageId: 'observed-one', requestId: 'feishu:observed-one',
    text: '这个结果真惊喜', sourceContext: observedSource };
  assert.equal((await request('POST', observePath, observation)).status, 403,
    'a browser cannot insert connector observations');
  const observed = await connectorRequest('POST', observePath, observation);
  assert.equal(observed.status, 201);
  assert.equal(observed.body.recent.at(-1).text, observation.text);
  assert.equal((await connectorRequest('POST', observePath, observation)).status, 200,
    'connector retries keep a single Session message');
  const decisionPath = `${observePath}/decision`;
  assert.equal((await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-one', participation: 'silent', emojiType: 'WOW',
  })).status, 200);
  const stableDecision = await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-one', participation: 'silent', emojiType: 'TOASTED',
  });
  assert.equal(stableDecision.body.decision.emojiType, 'WOW', 'a replay cannot revise an accepted outcome');
  const criticizedObservation = { ...observation, sourceMessageId: 'observed-criticism',
    requestId: 'feishu:observed-criticism', text: '这活干得不中',
    sourceContext: { ...observedSource, messageId: 'observed-criticism' } };
  assert.equal((await connectorRequest('POST', observePath, criticizedObservation)).status, 201);
  const criticismDecision = await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-criticism', participation: 'silent', emojiType: 'TOASTED',
  });
  assert.equal(criticismDecision.status, 200);
  assert.equal(criticismDecision.body.decision.emojiType, 'TOASTED');
  const neutralObservation = { ...observation, sourceMessageId: 'observed-neutral',
    requestId: 'feishu:observed-neutral', text: '下午三点开会',
    sourceContext: { ...observedSource, messageId: 'observed-neutral' } };
  assert.equal((await connectorRequest('POST', observePath, neutralObservation)).status, 201);
  const noReaction = await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-neutral', participation: 'silent', emojiType: null,
  });
  assert.equal(noReaction.status, 200);
  assert.equal(noReaction.body.decision.emojiType, null);
  assert.equal((await connectorRequest('POST', observePath, neutralObservation)).body.decision.emojiType,
    null, 'a quiet decision must survive connector replay');
  const observedEvents = (await request('GET', `/api/sessions/${groupFeedId}/events?filter=all`)).body.events;
  assert.equal(observedEvents.filter(event => event.sourceMessageId === 'observed-one'
    && event.type === 'message').length, 1);
  assert.equal(observedEvents.filter(event => event.sourceMessageId === 'observed-one'
    && event.type === 'reaction_decision').length, 1);
  assert.equal((await request('POST', '/api/source-deliveries', {
    responseId: 'jev:observed-one', sessionId: groupFeedId, reaction: 'WOW',
    sourceDelivery: { ...groupFeedConversation,
      target: { ...groupFeedConversation.target, messageId: 'observed-one' } },
  })).status, 403, 'a browser cannot enqueue a Bot reaction');
  const reaction = await connectorRequest('POST', '/api/source-deliveries', {
    responseId: 'jev:observed-one', sessionId: groupFeedId, reaction: 'WOW',
    sourceDelivery: { ...groupFeedConversation,
      target: { ...groupFeedConversation.target, messageId: 'observed-one' } },
  });
  assert.equal(reaction.status, 202);
  assert.equal(reaction.body.delivery.kind, 'reaction');
  assert.equal(reaction.body.delivery.emojiType, 'WOW');
  assert.equal((await connectorRequest('POST', '/api/source-deliveries', {
    responseId: 'jev:observed-one', sessionId: groupFeedId, reaction: 'WOW',
    sourceDelivery: { ...groupFeedConversation,
      target: { ...groupFeedConversation.target, messageId: 'observed-one' } },
  })).body.delivery.id, reaction.body.delivery.id, 'retry does not enqueue a second reaction');
  const groupMessage = await connectorRequest('POST', `/api/sessions/${groupFeedId}/messages`, {
    requestId: 'pilot-message', text: 'a genuine group message', tool: 'fake-codex', model: 'fake-model',
  });
  assert.equal(groupMessage.status, 202, 'the connector can continue the read-only group Session');
  await waitFor(async () => {
    const result = await request('GET', `/api/runs/${groupMessage.body.run.id}`);
    return result.body.run?.state === 'completed';
  }, 'group conversation response completion');
  const workObservation = await connectorRequest('POST', observePath, {
    sourceMessageId: 'observed-work', requestId: 'feishu:observed-work',
    text: '请调查这个问题', sourceContext: { ...observedSource, messageId: 'observed-work' },
  });
  assert.equal(workObservation.status, 201);
  const workDecision = await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-work', participation: 'reply', workMode: 'complex', emojiType: 'OnIt',
  });
  assert.equal(workDecision.status, 200);
  assert.equal(workDecision.body.decision.workMode, 'complex');
  assert.equal((await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-work', participation: 'reply', workMode: 'short', emojiType: 'OnIt',
  })).body.decision.workMode, 'complex', 'a replay cannot change the selected work topology');
  const workConversation = { ...groupFeedConversation, target: {
    ...groupFeedConversation.target, messageId: 'observed-work',
    conversationKind: 'thread', rootId: 'observed-work', replyInThread: true,
  } };
  const workSession = await connectorRequest('POST', '/api/sessions', {
    folder: home, tool: 'fake-codex', sourceId: 'feishu', conversation: workConversation,
    externalTriggerId: 'feishu:thread:pilot-bot:pilot-tenant:pilot-group:observed-work',
  });
  assert.equal(workSession.status, 201);
  assert.notEqual(workSession.body.session.id, groupFeedId);
  const observedWorkRun = await connectorRequest('POST', `/api/sessions/${workSession.body.session.id}/messages`, {
    requestId: 'feishu:observed-work', text: '请调查这个问题',
    tool: 'fake-codex', model: 'fake-model',
    sourceContext: { ...observedSource, messageId: 'observed-work', conversationKind: 'topic' },
    sourceDelivery: workConversation,
  });
  assert.equal(observedWorkRun.status, 202);
  await waitFor(async () => {
    const result = await request('GET', `/api/runs/${observedWorkRun.body.run.id}`);
    return result.body.run?.state === 'completed';
  }, 'observed work response completion');
  const afterWork = (await request('GET', `/api/sessions/${groupFeedId}/events?filter=all`)).body.events;
  assert.equal(afterWork.filter(event => event.type === 'message' && event.sourceMessageId === 'observed-work').length, 1,
    'the group timeline keeps its single observation');
  assert.equal(afterWork.find(event => event.type === 'reaction_decision'
    && event.sourceMessageId === 'observed-work')?.workMode, 'complex');
  const workEvents = (await request('GET', `/api/sessions/${workSession.body.session.id}/events?filter=all`)).body.events;
  assert.equal(workEvents.filter(event => event.type === 'message' && event.role === 'user').length, 1,
    'the dedicated work Session receives the task');
  const shortObservation = await connectorRequest('POST', observePath, {
    sourceMessageId: 'observed-short', requestId: 'feishu:observed-short',
    text: '这个词是什么意思？', sourceContext: { ...observedSource, messageId: 'observed-short' },
  });
  assert.equal(shortObservation.status, 201);
  const shortDecision = await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-short', participation: 'reply', workMode: 'short', emojiType: 'OnIt',
  });
  assert.equal(shortDecision.status, 200);
  assert.equal(shortDecision.body.decision.workMode, 'short');
  const binaryObservation = await connectorRequest('POST', observePath, {
    sourceMessageId: 'observed-binary', requestId: 'feishu:observed-binary',
    text: '你能不能看到这条消息',
    sourceContext: { ...observedSource, messageId: 'observed-binary' },
  });
  assert.equal(binaryObservation.status, 201);
  const binaryDecision = await connectorRequest('POST', decisionPath, {
    sourceMessageId: 'observed-binary', participation: 'reply', workMode: 'reaction', emojiType: 'Yes',
  });
  assert.equal(binaryDecision.status, 200);
  assert.equal(binaryDecision.body.decision.workMode, 'reaction');
  assert.equal(binaryDecision.body.decision.emojiType, 'Yes');
  const binaryReaction = await connectorRequest('POST', '/api/source-deliveries', {
    responseId: 'jev:observed-binary', sessionId: groupFeedId, reaction: 'Yes',
    sourceDelivery: { ...groupFeedConversation,
      target: { ...groupFeedConversation.target, messageId: 'observed-binary' } },
  });
  assert.equal(binaryReaction.status, 202);
  assert.equal(binaryReaction.body.delivery.emojiType, 'Yes');
  const shortRun = await connectorRequest('POST', `/api/sessions/${groupFeedId}/messages`, {
    requestId: 'feishu:observed-short', text: '这个词是什么意思？', recordUserMessage: false,
    tool: 'fake-codex', model: 'fake-model',
    sourceContext: { ...observedSource, messageId: 'observed-short', feishuParticipation: 'ambient' },
    sourceDelivery: { ...groupFeedConversation, target: {
      ...groupFeedConversation.target, messageId: 'observed-short',
    } },
  });
  assert.equal(shortRun.status, 202);
  await waitFor(async () => {
    const result = await request('GET', `/api/runs/${shortRun.body.run.id}`);
    return result.body.run?.state === 'completed';
  }, 'short group reply completion');
  const pilotDeliveries = [];
  for (let index = 0; index < 6; index += 1) {
    const claim = await request('POST', '/api/source-deliveries/claim', {
      connector: 'feishu', sourceRouteId: 'pilot-bot',
    });
    assert.equal(claim.status, 200);
    assert(claim.body.claim?.delivery, 'the reaction, previous group reply and work reply must be queued');
    pilotDeliveries.push(claim.body.claim.delivery);
    assert.equal((await request('POST', `/api/source-deliveries/${claim.body.claim.delivery.id}/complete`, {
      leaseId: claim.body.claim.leaseId, externalId: `pilot-delivery-${index}`,
    })).status, 200);
  }
  const workReply = pilotDeliveries.find(delivery => delivery.target?.rootId === 'observed-work');
  assert(workReply, 'the work reply must be published');
  assert.equal(workReply.target.rootId, 'observed-work', JSON.stringify(pilotDeliveries.map(delivery => ({
    kind: delivery.kind, target: delivery.target,
  }))));
  assert.equal(workReply.target.replyInThread, true);
  assert.equal(workReply.sessionId, workSession.body.session.id);
  assert.equal(workReply.target.sourceKind, undefined);
  const mainReplies = pilotDeliveries.filter(delivery => delivery.kind === 'content'
    && delivery.sessionId === groupFeedId);
  assert.equal(mainReplies.length, 2, 'both existing group work and short reply stay in the group Session');
  assert(mainReplies.every(delivery => delivery.target.conversationKind === 'main'
    && delivery.target.replyInThread !== true));
  console.log('PASS: group conversation is shared for reading but only the connector can write or bind it');
  const longClaim = request('POST', '/api/source-deliveries/claim', {
    connector: 'feishu', sourceRouteId: 'long-poll-fixture', waitMs: 5000,
  });
  const queuedForLongClaim = await request('POST', '/api/source-deliveries', {
    responseId: 'long-poll-response', sessionId: 'long-poll-session', text: 'wake the waiting connector',
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'long-poll-fixture', target: { chatId: 'long-poll-chat' } },
  });
  assert.equal(queuedForLongClaim.status, 202);
  const wokenClaim = await longClaim;
  assert.equal(wokenClaim.status, 200);
  assert.equal(wokenClaim.body.claim.delivery.id, queuedForLongClaim.body.delivery.id);
  assert.equal((await request('POST', `/api/source-deliveries/${wokenClaim.body.claim.delivery.id}/complete`, {
    leaseId: wokenClaim.body.claim.leaseId, externalId: 'long-poll-message',
  })).status, 200);
  console.log('PASS: route-scoped long claim wakes from a durable outbox commit');
  // Browser continuation keeps the Session context without implicitly posting to its source chat.
  const conversation = { connector: 'feishu', sourceRouteId: 'bound-bot',
    target: { chatId: 'bound-chat', threadId: 'bound-thread', rootId: 'bound-root', messageId: 'bound-root', replyInThread: true } };
  const bound = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', conversation });
  for (const sourceRouteId of ['bot-left', 'bot-right']) {
    const scoped = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex',
      externalTriggerId: 'feishu:shared-legacy-key', conversation: { ...conversation, sourceRouteId },
    });
    assert.equal(scoped.status, 201);
    assert.equal(scoped.body.session.conversation.sourceRouteId, sourceRouteId,
      'legacy external keys cannot merge two Bot conversation scopes');
  }

  assert.equal(bound.status, 201);
  const boundId = bound.body.session.id;
  await request('PATCH', `/api/sessions/${boundId}`, { name: 'UniqueSearchNeedle' });
  const searchReply = await request('GET', '/api/sessions/search?q=UniqueSearchNeedle');
  assert.equal(searchReply.status, 200);
  assert.equal(searchReply.body.sessions[0].id, boundId);
  assert.equal(searchReply.body.sessions[0].sessionUrl, `https://fixture.example.test/?session=${boundId}&tab=sessions`);
  assert.equal((await request('GET', '/api/sessions/search')).status, 400);
  const unauthorizedSearch = await fetch(`http://127.0.0.1:${port}/api/sessions/search?q=UniqueSearchNeedle`, { redirect: 'manual' });
  assert([401, 403].includes(unauthorizedSearch.status), 'history search requires authentication');
  assert.deepEqual(bound.body.session.conversation, conversation, 'creation must retain the optional conversation');
  const replay = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex',
    conversation: { ...conversation, target: { chatId: 'bound-chat', topicId: 'bound-thread' } } });
  assert.equal(replay.body.session.id, boundId, 'topic aliases resolve one Session');
  const found = await request('POST', '/api/session-conversations/resolve', { conversation });
  assert.equal(found.body.sessionId, boundId);
  const browser = await request('POST', `/api/sessions/${boundId}/messages`, {
    requestId: 'browser-bound', text: 'Reply through the existing conversation.', tool: 'fake-codex', model: 'fake-model',
  });
  assert.equal(browser.status, 202);
  await waitFor(async () => {
    const result = await request('GET', `/api/runs/${browser.body.run.id}`);
    return result.body.run?.state === 'completed';
  }, 'browser continuation completion');
  const boundDeliveries = await request('GET', '/api/source-deliveries?connector=feishu&sourceRouteId=bound-bot');
  assert(!boundDeliveries.body.deliveries.some(item => item.runId === browser.body.run.id),
    'browser continuation must not publish into the bound Feishu conversation');
  const currentRootDelivery = { connector: 'feishu', sourceRouteId: 'bound-bot',
    target: { chatId: 'bound-chat', chatType: 'group', messageId: 'current-root' } };
  const continuedFromCurrentRoot = await request('POST', `/api/sessions/${boundId}/messages`, {
    requestId: 'current-root-route', text: 'Keep the Session context but publish to the group root.',
    sourceDelivery: currentRootDelivery,
  });
  assert.equal(continuedFromCurrentRoot.status, 202,
    'a request in the same Feishu chat may use an unthreaded continue-mode destination');
  const currentRootReply = await waitFor(async () => {
    const result = await request('GET', '/api/source-deliveries?connector=feishu&sourceRouteId=bound-bot');
    return result.body.deliveries.find(item => item.runId === continuedFromCurrentRoot.body.run.id && item.kind === 'content');
  }, 'request-scoped group-root reply');
  assert.deepEqual(currentRootReply.target, currentRootDelivery.target,
    'the durable request snapshot must retain the selected mode instead of the old Session topic');
  const crossed = await request('POST', `/api/sessions/${boundId}/messages`, {
    requestId: 'crossed-route', text: 'Do not move the conversation.',
    sourceDelivery: { ...conversation, sourceRouteId: 'different-bot' },
  });
  assert.equal(crossed.status, 400, 'one request cannot replace a Session conversation');
  const crossedChat = await request('POST', `/api/sessions/${boundId}/messages`, {
    requestId: 'crossed-chat', text: 'Do not move the conversation to another chat.',
    sourceDelivery: { ...currentRootDelivery, target: { ...currentRootDelivery.target, chatId: 'different-chat' } },
  });
  assert.equal(crossedChat.status, 400, 'request-scoped delivery cannot escape the bound Feishu chat');
  const fork = await request('POST', `/api/sessions/${boundId}/fork`, {});
  assert.equal(fork.status, 201);
  assert.equal(fork.body.session.conversation, undefined, 'ordinary forks do not inherit external publication');
  const archived = await request('PATCH', `/api/sessions/${boundId}`, { archived: true });
  assert.equal(archived.status, 200);
  const resumed = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', conversation });
  assert.equal(resumed.body.session.id, boundId, 'archival does not detach conversation identity');
  const forkPayload = { folder: home, tool: 'fake-codex', conversation, replaceConversation: true, externalTriggerId: 'explicit-fork' };
  const transferred = await request('POST', '/api/sessions', forkPayload);
  assert.equal(transferred.status, 201);
  assert.notEqual(transferred.body.session.id, boundId);
  assert.equal((await request('GET', `/api/sessions/${boundId}`)).body.session.conversation, null,
    'fork transfer leaves a tombstone against legacy index adoption');
  assert.equal((await request('POST', '/api/sessions', forkPayload)).body.session.id, transferred.body.session.id,
    'replayed explicit fork must retain the binding');
  const laterFork = await request('POST', '/api/sessions', { ...forkPayload, externalTriggerId: 'later-fork' });
  assert.notEqual(laterFork.body.session.id, transferred.body.session.id);
  assert.equal((await request('POST', '/api/sessions', forkPayload)).body.session.id, transferred.body.session.id,
    'replaying the previous fork retains its original Session identity');
  assert.equal((await request('POST', '/api/session-conversations/resolve', { conversation })).body.sessionId, laterFork.body.session.id,
    'an old fork replay cannot take the topic back from the newer fork');
  assert.equal((await request('PATCH', `/api/sessions/${boundId}`, { conversation })).status, 400,
    'two Sessions cannot own the same topic');
  const unbound = await request('PATCH', `/api/sessions/${boundId}`, { conversation: null });
  assert.equal(unbound.status, 200);
  assert.equal(unbound.body.session.conversation, null);
  console.log('PASS: Session binding, alias reuse, browser reply, route isolation, archive and fork boundaries');
  const newTopic = { connector: 'feishu', sourceRouteId: 'new-topic-bot', target: { chatId: 'new-topic-chat' } };
  const published = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', conversation: newTopic });
  const publishedId = published.body.session.id;
  await request('POST', `/api/sessions/${publishedId}/messages`, {
    requestId: 'new-topic-input', text: 'Publish into a new topic.', sourceDelivery: newTopic,
  });
  const rootClaim = await waitFor(async () => {
    const result = await request('POST', '/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'new-topic-bot' });
    return result.body.claim;
  }, 'new topic first publication');
  const acknowledgeRoot = () => request('POST', `/api/source-deliveries/${rootClaim.delivery.id}/complete`, {
    leaseId: rootClaim.leaseId, externalId: 'published-root', messageId: 'published-root', threadId: 'published-thread',
  });
  assert.equal((await acknowledgeRoot()).status, 200);
  assert.equal((await acknowledgeRoot()).status, 200, 'lost acknowledgement is replayable');
  const publishedSession = (await request('GET', `/api/sessions/${publishedId}`)).body.session;
  assert.equal(publishedSession.conversation.target.rootId, 'published-root', 'send receipt completes Session binding');
  assert.equal(publishedSession.conversation.target.threadId, 'published-thread');
  const contentClaim = await waitFor(async () => {
    const result = await request('POST', '/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'new-topic-bot' });
    return result.body.claim;
  }, 'reply after topic creation');
  assert.equal(contentClaim.delivery.target.rootId, 'published-root', 'pending output follows the new root without creating another topic');
  assert.equal(contentClaim.delivery.target.replyInThread, true);
  const secondTopic = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', conversation: newTopic });
  assert.notEqual(secondTopic.body.session.id, publishedId, 'a group destination creates a new Session on the next occurrence');
  // Restart with the same instance state, with a pending send and no connector-local index.
  server.kill('SIGTERM');
  await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'restart shutdown');
  server = startServer();
  await waitFor(async () => { try { return (await request('GET', '/api/auth/me')).status === 200; } catch { return false; } }, 'restart startup');
  const restartedBinding = await request('POST', '/api/session-conversations/resolve', { conversation: {
    ...newTopic, target: { chatId: 'new-topic-chat', threadId: 'published-thread' },
  } });
  assert.equal(restartedBinding.body.sessionId, publishedId, 'core binding survives a cold server restart');
  assert.equal((await acknowledgeRoot()).status, 200, 'receipt replay remains idempotent across restart');
  const { findFeishuThreadSessionBinding } = await import('../connectors/feishu/session-flow.mjs');
  const withoutLocalIndex = await findFeishuThreadSessionBinding({ config: { sourceRouteId: 'new-topic-bot' },
    requestRemoteLab: async (path, options = {}) => {
      const result = await request(options.method || 'GET', path, options.body);
      return { response: { ok: result.status < 400, status: result.status }, json: result.body };
    }, storagePaths: {},
  }, { chatId: 'new-topic-chat', threadId: 'published-thread', messageId: 'new-human-reply' });
  assert.equal(withoutLocalIndex.sessionId, publishedId, 'Feishu continuation resolves the core binding without a connector-local index');
  const replacement = { ...newTopic, target: { chatId: 'new-topic-chat', rootId: 'other-root', replyInThread: true } };
  assert.equal((await request('PATCH', `/api/sessions/${publishedId}`, { conversation: replacement })).status, 200);
  assert.equal((await request('POST', `/api/source-deliveries/${contentClaim.delivery.id}/complete`, {
    leaseId: contentClaim.leaseId, messageId: 'old-reply', threadId: 'old-thread',
  })).status, 200);
  assert.equal((await request('GET', `/api/sessions/${publishedId}`)).body.session.conversation.target.rootId, 'other-root',
    'a delayed old receipt cannot undo explicit rebinding');
  console.log('PASS: first-publication receipt, pending replies, cold restart and late receipt isolation');
  const cases = ['feishu', 'wechat', 'email'].flatMap(connector => ['json', 'multipart'].map(encoding => ({ connector, encoding })));
  for (const { connector, encoding } of cases) {
    const created = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', name: `Fixture ${encoding}` });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.id;
    const requestId = `fixture-${encoding}`;
    const targets = {
      feishu: { chatId: `fixture-chat-${encoding}`, messageId: `fixture-message-${encoding}`, chatType: 'group', replyInThread: true },
      wechat: { accountId: 'fixture-account', peerUserId: `fixture-peer-${encoding}`, messageId: `fixture-message-${encoding}`, contextToken: 'fixture-context' },
      email: { to: 'fixture@example.test', from: 'agent+alias@example.test', subject: 'Re: fixture', inReplyTo: '<fixture@example.test>',
        references: ['<root@example.test>', '<fixture@example.test>'], threadId: `fixture-thread-${encoding}`, messageId: '<fixture@example.test>' },
    };
    const sourceDelivery = { connector, sourceRouteId: 'fixture-route', target: targets[connector] };
    const payload = { requestId, text: 'Return the fixture reply.', tool: 'fake-codex', model: 'fake-model', sourceDelivery };
    let body = payload;
    if (encoding === 'multipart') {
      body = new FormData();
      for (const [key, value] of Object.entries(payload)) body.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
      body.append('attachments', new Blob(['fixture input attachment'], { type: 'text/plain' }), 'fixture.txt');
    }
    const submitted = await request('POST', `/api/sessions/${sessionId}/messages`, body);
    assert.equal(submitted.status, 202);
    const key = createHash('sha256').update(JSON.stringify([sessionId, requestId])).digest('hex').slice(0, 24);
    const record = JSON.parse(await readFile(join(config, 'requests/active', `${key}.json`), 'utf8'));
    assert.deepEqual(record.options.sourceDelivery, sourceDelivery, `${encoding} admission must preserve the explicit delivery route`);
    const delivery = await waitFor(async () => {
      const result = await request('GET', `/api/source-deliveries?connector=${connector}&sourceRouteId=fixture-route`);
      assert.equal(result.status, 200);
      return result.body.deliveries.find(item => item.runId === submitted.body.run.id && item.text?.includes('fixture reply for delivery'));
    }, `${encoding} generated reply in outbox`);
    assert.equal(delivery.sourceRouteId, 'fixture-route');
    assert.deepEqual(delivery.target, sourceDelivery.target);
    assert.equal(delivery.state, 'pending');
    if (encoding === 'json') {
      const repeated = await request('POST', `/api/sessions/${sessionId}/messages`, payload);
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.duplicate, true);
      assert.equal(repeated.body.run.id, submitted.body.run.id);
    }
  }
  const emailSession = await request('POST', '/api/sessions', { folder: home, tool: 'fake-codex', sourceId: 'email' });
  assert.equal(emailSession.status, 201);
  const emailSessionId = emailSession.body.session.id;
  for (const requestId of ['', 'invalid-route']) {
    const invalid = await request('POST', `/api/sessions/${emailSessionId}/messages`, {
      ...(requestId ? { requestId } : {}), text: 'Do not execute without the requested route.',
      sourceDelivery: { connector: 'wechat', target: { chatId: 'missing-account-and-peer' } },
    });
    assert.equal(invalid.status, 400, 'invalid explicit delivery targets must fail admission, not silently lose the reply');
    assert.match(invalid.body.error, /Invalid sourceDelivery/);
  }
  const admitted = [];
  for (const suffix of ['first', 'follow-up']) {
    const result = await request('POST', `/api/sessions/${emailSessionId}/messages`, {
      requestId: `email-${suffix}`, text: `Reply to ${suffix}.`, tool: 'fake-codex', model: 'fake-model',
      sourceDelivery: { connector: 'email', sourceRouteId: 'queued-mailbox', target: {
        to: 'fixture@example.test', subject: 'Re: queued fixture', threadId: '<thread@example.test>',
        inReplyTo: `<${suffix}@example.test>`, messageId: `<${suffix}@example.test>`,
      } },
    });
    assert.equal(result.status, 202);
    admitted.push(result.body);
  }
  assert.equal(admitted[1].queued, true, 'second email is admitted while the first request is still executing');
  const observing = await request('GET', '/api/source-deliveries?connector=email&sourceRouteId=queued-mailbox&includeActivity=true');
  assert(observing.body.activity.some(item => item.requestId === 'email-follow-up'), 'optional feedback observes durable queued requests');
  assert(observing.body.activity.every(item => item.text === undefined), 'activity never exports prompt bodies');
  const queuedReplies = await waitFor(async () => {
    const result = await request('GET', '/api/source-deliveries?connector=email&sourceRouteId=queued-mailbox');
    assert(result.body.deliveries.every(item => item.kind !== 'session_entry'), 'email must not create a second session-entry email even with a configured public URL');
    const replies = result.body.deliveries.filter(item => item.kind === 'content');
    return replies.length === 2 ? replies : null;
  }, 'each queued email request owns an independent final reply');
  assert.deepEqual(new Set(queuedReplies.map(reply => reply.runId)), new Set(admitted.map(item => item.run.id)));
  assert.deepEqual(new Set(queuedReplies.map(reply => reply.target.inReplyTo)), new Set(['<first@example.test>', '<follow-up@example.test>']));
  assert(queuedReplies.every(reply => reply.state === 'pending'), 'sender downtime retains every completed email reply');
  // Publication can precede durable Request settlement. Observe that boundary
  // before asserting that terminal requests no longer produce typing activity.
  const { createRequestStore } = await import('../chat/requests.mjs');
  const requestStore = createRequestStore(join(config, 'requests'));
  await waitFor(async () => {
    const records = await Promise.all(['first', 'follow-up'].map(suffix => requestStore.byRequest(emailSessionId, `email-${suffix}`)));
    return records.every(record => record?.result?.state === 'completed');
  }, 'queued email requests durably settled');
  const settledActivity = await request('GET', '/api/source-deliveries?connector=email&sourceRouteId=queued-mailbox&includeActivity=true');
  assert.deepEqual(settledActivity.body.activity, [], 'terminal requests stop typing even while final delivery is pending');
  console.log('PASS: Feishu, WeChat and Email JSON/multipart admission preserve sourceDelivery; queued emails each create a reply while sender is offline; no external sends');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'server shutdown');
  }
  await rm(home, { recursive: true, force: true });
}

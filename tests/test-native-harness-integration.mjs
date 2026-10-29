#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAttributedFeishuMessage } from '../connectors/feishu/index.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-native-integration-'));
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const config = join(root, 'config'), bin = join(root, 'bin');
const validationLog = join(tmpdir(), `remotelab-native-integration-results-${process.pid}.log`);
const evidence = async message => { console.log(message); await appendFile(validationLog, `${new Date().toISOString()} ${message}\n`); };
await mkdir(config); await mkdir(bin);
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
  { id: 'person_b', name: '乙', identities: [{ id: 'identity_b', kind: 'web', subjectId: 'b' }] },
] }));
await writeFile(join(config, 'tools.json'), JSON.stringify([
  { id: 'fake-native', name: 'Fake native', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'fake-context', name: 'Context native', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'native' },
  { id: 'fake-switch', name: 'Other runtime', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'batch', promptMode: 'bare-user' },
]));
await writeFile(join(config, 'group-routing-pilot.json'), JSON.stringify({ version: 1, enabled: true,
  groups: [{ sourceRouteId: 'default', chatId: 'pilot-chat', tenantKey: 'tenant', folder: root }] }));
await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, SHELL: '/bin/sh',
  REMOTELAB_CONFIG_DIR: config, REMOTELAB_MEMORY_DIR: join(root, 'memory'), REMOTELAB_WORK_ROOT_DIR: root,
  REMOTELAB_MEMORY_WRITEBACK: 'off', REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
  REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE: '2026-10-07',
  REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64') };
let child, nextId = 0, succeeded = false;
const pending = new Map();
let controllerErrors = '';
async function boot() {
  child = fork(join(repo, 'tests/fixtures/native-codex-controller.mjs'), [], { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => { controllerErrors += chunk; });
  child.on('message', message => { if (message.id) { const pair = pending.get(message.id); pending.delete(message.id); if (pair) message.error ? pair.reject(Object.assign(new Error(message.error), { code: message.errorCode })) : pair.resolve(message.value); } });
  child.on('exit', (code, signal) => { for (const pair of pending.values()) pair.reject(new Error(`Controller exited ${code ?? signal}: ${controllerErrors}`)); pending.clear(); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(controllerErrors); })]);
}
function rpc(action, ...args) {
  const id = ++nextId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, action, args }); });
}
async function killController() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function logs() {
  const text = await readFile(join(root, 'native-log.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  // The fixture appends while this observer reads. A trailing partial line is
  // not a completed event yet; malformed newline-terminated events still fail.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function until(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timeout: ${description}\n${controllerErrors}\n${JSON.stringify(await logs())}`);
}
const receipt = (runId, requestId) => readFile(join(config, 'chat-runs', runId, 'native-inputs', `${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}.json`), 'utf8').then(JSON.parse).catch(() => null);
const options = requestId => ({ requestId, tool: 'fake-native', promptMode: 'bare-user', sourceDelivery: { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'same-chat' } } });
async function accept(sessionId, requestId, text) { return rpc('accept', sessionId, text, [], options(requestId)); }
async function awaitAnswer(sessionId, requestId, reviewExpected = false) {
  await until(async () => (await rpc('response', sessionId, requestId))?.state === 'ready', `${requestId} gets final response`);
  const result = await rpc('response', sessionId, requestId);
  if (reviewExpected) {
    assert.equal(result.payload.text,'durable native answer');
  } else assert.equal(result.payload.text, 'durable native answer');
  return result;
}
try {
  await boot();
  const ambientPlan = { connector: 'feishu', sourceRouteId: 'ambient-bot', target: {
    chatId: 'ambient-bridge', conversationKind: 'main', messageId: 'ambient-root',
  } };
  const ambientSession = await rpc('create', { conversation: ambientPlan });
  const ambientRun = await rpc('accept', ambientSession.id, 'PUBLISH_OPENING THREAD_OPENING', [], {
    ...options('ambient-root'), sourceDelivery: ambientPlan,
    sourceContext: { connector: 'feishu', feishuParticipation: 'ambient' },
  });
  let threadOpening;
  await until(async () => { threadOpening = await rpc('claim', { connector: 'feishu', sourceRouteId: 'ambient-bot' }); return threadOpening; }, 'ambient thread opening');
  assert.equal(threadOpening.delivery.target.sourceKind, 'ambient_thread_open');
  await rpc('complete', threadOpening.delivery.id, threadOpening.leaseId, {
    externalId: 'thread-reply', messageId: 'thread-reply', threadId: 'provider-thread',
  });
  const threadPlan = { ...ambientPlan, target: { chatId: 'ambient-bridge', conversationKind: 'thread',
    threadId: 'provider-thread', rootId: 'ambient-root', messageId: 'stop-message', replyInThread: true } };
  const bridge = await rpc('thread-execution', threadPlan);
  assert.deepEqual(bridge, { sessionId: ambientSession.id, continuationRunId: ambientRun.run.id, threadOriginRunId: ambientRun.run.id });
  const stopOptions = { ...options('ambient-stop'), feishuConnectorAuthenticated: true, sourceDelivery: threadPlan,
    sourceContext: { connector: 'feishu', feishuContinuationRunId: bridge.continuationRunId } };
  await rpc('accept', bridge.sessionId, 'Stop this work; do not start again for this supplement.', [], stopOptions);
  await until(async () => (await rpc('request', bridge.sessionId, 'ambient-stop'))?.nativeReceipt?.accepted, 'topic stop steered into original Harness');
  assert.equal((await rpc('request', bridge.sessionId, 'ambient-stop')).nativeDispatchRunId, ambientRun.run.id);
  await rpc('cancel', bridge.sessionId, { expectedRunId: bridge.continuationRunId });
  await until(async () => (await rpc('request', bridge.sessionId, 'ambient-root'))?.result, 'original execution cancelled');
  assert.equal((await rpc('request', bridge.sessionId, 'ambient-root')).result.state, 'cancelled');
  assert.deepEqual(await rpc('thread-execution', threadPlan), { sessionId: ambientSession.id, threadOriginRunId: ambientRun.run.id });
  await assert.rejects(rpc('accept', bridge.sessionId, 'A further correction is not permission to restart.', [], {
    ...stopOptions, requestId: 'after-stop',
  }), error => error.code === 'THREAD_CONTINUATION_EXPIRED');
  assert.equal(await rpc('request', bridge.sessionId, 'after-stop'), null);
  // Drain the actual cancellation publication before other scenarios.
  let stoppedDelivery;
  while ((stoppedDelivery = await rpc('claim', { connector: 'feishu', sourceRouteId: 'ambient-bot' }))) {
    await rpc('complete', stoppedDelivery.delivery.id, stoppedDelivery.leaseId, { externalId: 'stopped-thread-result' });
  }
  await evidence('PASS ambient thread: real receipt resolves original execution, topic stop steers there, exact-run cancel, stale additions cannot restart');
  // Isolate outboxes: cancellation publication from the previous scenario can arrive late.
  const racePlan = { ...ambientPlan, sourceRouteId: 'race-bot', target: { ...ambientPlan.target, chatId: 'thread-completion-race' } };
  const threadRaceSession = await rpc('create', { conversation: racePlan });
  const threadRaceRun = await rpc('accept', threadRaceSession.id, 'PUBLISH_OPENING THREAD_OPENING', [], {
    ...options('race-root'), sourceDelivery: racePlan, sourceContext: { connector: 'feishu', feishuParticipation: 'ambient' },
  });
  let raceOpening;
  await until(async () => { raceOpening = await rpc('claim', { connector: 'feishu', sourceRouteId: 'race-bot' }); return raceOpening; }, 'race thread opening');
  assert.equal(raceOpening.delivery.sessionId, threadRaceSession.id);
  assert.equal(raceOpening.delivery.target.sourceKind, 'ambient_thread_open');
  await rpc('complete', raceOpening.delivery.id, raceOpening.leaseId, {
    externalId: 'race-reply', messageId: 'race-reply', threadId: 'race-thread',
  });
  const raceThread = { ...threadPlan, sourceRouteId: 'race-bot', target: { ...threadPlan.target, chatId: 'thread-completion-race', threadId: 'race-thread' } };
  await rpc('accept', threadRaceSession.id, 'RACE_NATIVE_COMPLETION', [], {
    ...options('thread-race-input'), feishuConnectorAuthenticated: true, sourceDelivery: raceThread,
    sourceContext: { connector: 'feishu', feishuContinuationRunId: threadRaceRun.run.id, feishuThreadOriginRunId: threadRaceRun.run.id },
  });
  await until(async () => (await logs()).some(event => event.kind === 'turn/start' && event.text.includes('RACE_NATIVE_COMPLETION')), 'completion race queues a fresh turn in original Session');
  const continued = await rpc('request', threadRaceSession.id, 'thread-race-input');
  assert.equal(continued.sessionId, threadRaceSession.id);
  assert.equal(continued.nativeDispatchRunId, null);
  assert.equal(continued.options.sourceContext.feishuThreadOriginRunId, threadRaceRun.run.id);
  assert.equal(continued.deliveryPlan.target.threadId, 'race-thread');
  assert.equal((await logs()).filter(event => event.kind === 'turn/start' && event.text.includes('RACE_NATIVE_COMPLETION')).length, 1);
  await writeFile(join(root, continued.runId + '.release'), '');
  await until(async () => (await rpc('request', threadRaceSession.id, 'thread-race-input'))?.result, 'continuation result settles');
  assert.equal((await rpc('request', threadRaceSession.id, 'thread-race-input')).result.state, 'completed');
  await until(async () => (await rpc('request', threadRaceSession.id, 'race-root'))?.result, 'race root settled');
  const afterCompletion = await rpc('thread-execution', raceThread);
  assert.equal(afterCompletion.sessionId, threadRaceSession.id);
  assert.equal(afterCompletion.threadOriginRunId, threadRaceRun.run.id);
  const followup = await rpc('accept', threadRaceSession.id, 'LATER_TOPIC_SUPPLEMENT', [], {
    ...options('later-topic'), feishuConnectorAuthenticated: true, sourceDelivery: raceThread,
    sourceContext: { connector: 'feishu', feishuThreadOriginRunId: afterCompletion.threadOriginRunId },
  });
  await until(async () => (await logs()).some(event => event.runId === followup.run.id && event.kind === 'turn/start'), 'later topic input resumes original context');
  const resumedEvents = (await logs()).filter(event => event.runId === followup.run.id);
  assert(resumedEvents.some(event => event.kind === 'thread/resume'), 'native conversation context resumes rather than creating another Session');
  const unrelatedScope = { ...raceThread, target: { ...raceThread.target, threadId: 'unrelated-thread', rootId: 'unrelated-root' } };
  assert.deepEqual(await rpc('cancel-conversation', threadRaceSession.id, unrelatedScope), { cancelledRunIds: [] });
  assert.equal((await rpc('request', threadRaceSession.id, 'later-topic')).cancelRequestedAt, undefined, 'pausing another topic cannot stop this execution');
  await writeFile(join(root, followup.run.id + '.release'), '');
  await awaitAnswer(threadRaceSession.id, 'later-topic');
  let raceDelivery;
  while ((raceDelivery = await rpc('claim', { connector: 'feishu', sourceRouteId: 'race-bot' }))) {
    await rpc('complete', raceDelivery.delivery.id, raceDelivery.leaseId, { externalId: 'race-result' });
  }
  await evidence('PASS thread completion race: definite native rejection queues exactly one continuation in the original Session and topic; completed-topic input resumes native context');
  const replyPlan = messageId => ({ connector: 'feishu', sourceRouteId: 'default', target: {
    chatId: 'steering-chat', chatType: 'group', conversationKind: 'thread', threadId: 'steering-thread',
    rootId: 'steering-root', messageId, replyInThread: true,
  } });
  // A topic's first inbound post has its thread ID before it has a rootId;
  // later supplements carry both aliases and their own message anchors.
  const firstReplyPlan = replyPlan('steering-root');
  delete firstReplyPlan.target.rootId;
  const replySession = await rpc('create', { conversation: firstReplyPlan });
  const replyOptions = id => ({ ...options(id), sourceDelivery: id === 'opening-root'
    ? firstReplyPlan : replyPlan(id) });
  const openingRun = await rpc('accept', replySession.id, 'PUBLISH_OPENING', [], replyOptions('opening-root'));
  let openingClaim;
  await until(async () => { openingClaim = await rpc('claim', { connector: 'feishu' }); return openingClaim; }, 'original opening is published');
  assert.equal(openingClaim.delivery.surfaceKind, 'opening');
  await rpc('complete', openingClaim.delivery.id, openingClaim.leaseId, { externalId: 'original-opening' });
  await rpc('accept', replySession.id, 'HOLD_OPENING_ACK', [], replyOptions('opening-steer'));
  await until(async () => (await rpc('history', replySession.id)).some(event => event.role === 'assistant'
    && event.content?.includes('Supplement accepted;')), 'steered first reply reaches Web before acknowledgement');
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'no unacknowledged input may take the reply destination');
  await writeFile(join(root, `${openingRun.run.id}.ack`), 'release acknowledgement');
  await until(async () => (await rpc('request', replySession.id, 'opening-steer'))?.nativeReceipt?.accepted, 'steered input acknowledged');
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'same-topic steering does not publish another opening');
  assert.equal((await rpc('accept', replySession.id, 'HOLD_OPENING_ACK', [], replyOptions('opening-steer'))).duplicate, true);
  // This case checks publication recovery across an ordinary restart. Drain
  // observers before stopping the controller so unfinished lock creation is
  // not confused with that contract; dedicated SIGKILL cases remain below.
  await rpc('shutdown');
  await killController(); await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'controller recovery cannot repeat either opening');
  assert.equal((await logs()).filter(event => event.clientId === 'opening-steer').length, 1);
  await writeFile(join(root, `${openingRun.run.id}.release`), 'finish execution');
  await awaitAnswer(replySession.id, 'opening-root');
  await awaitAnswer(replySession.id, 'opening-steer');
  const replyFinal = await rpc('claim', { connector: 'feishu' });
  assert.equal(replyFinal.delivery.surfaceKind, 'final');
  assert.equal(replyFinal.delivery.target.messageId, 'steering-root');
  await rpc('complete', replyFinal.delivery.id, replyFinal.leaseId, { externalId: 'final-opening-test' });
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'a shared stopped Run publishes its result once');
  await evidence('PASS steering opening: Web-before-ack, same-topic duplicate opener suppressed, controller recovery and one terminal result');
  // Explicit per-request reply destinations also share a result without a
  // Session binding. Another topic must still get its own single copy.
  const multiSession = await rpc('create');
  const multiOptions = (id, sourceDelivery) => ({ ...options(id), sourceDelivery });
  const multiRun = await rpc('accept', multiSession.id, 'Hold shared execution', [],
    multiOptions('multi-root', firstReplyPlan));
  await until(async () => (await logs()).some(event => event.runId === multiRun.run.id
    && event.kind === 'turn/start'), 'multiple-destination turn starts');
  const otherTopic = replyPlan('other-input');
  otherTopic.target.threadId = 'other-thread'; otherTopic.target.rootId = 'other-root';
  const otherAlias = structuredClone(otherTopic);
  delete otherAlias.target.threadId; otherAlias.target.messageId = 'other-supplement';
  for (const [id, plan] of [['multi-same', replyPlan('same-supplement')],
    ['multi-other', otherTopic], ['multi-alias', otherAlias]]) {
    await rpc('accept', multiSession.id, 'Apply this supplement', [], multiOptions(id, plan));
    await until(async () => (await receipt(multiRun.run.id, id))?.state === 'accepted', id + ' is acknowledged');
  }
  await writeFile(join(root, `${multiRun.run.id}.release`), 'finish execution');
  for (const id of ['multi-root', 'multi-same', 'multi-other', 'multi-alias']) await awaitAnswer(multiSession.id, id);
  const multiClaims = [];
  for (let index = 0; index < 2; index++) {
    let claimed;
    await until(async () => { claimed = await rpc('claim', { connector: 'feishu' }); return claimed; }, 'each topic receives its result');
    multiClaims.push(claimed.delivery);
    await rpc('complete', claimed.delivery.id, claimed.leaseId, { externalId: `multi-final-${index}` });
  }
  assert.deepEqual(multiClaims.map(part => part.target.rootId || part.target.messageId).sort(), ['other-root', 'steering-root']);
  assert(multiClaims.every(part => part.surfaceKind === 'final' && part.providerMessageId));
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'root and thread aliases cannot fan out another copy');
  await rpc('shutdown'); await killController(); await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'recovery preserves one delivery per distinct topic');
  await evidence('PASS: unbound same-topic supplements and alternate root/thread aliases share one result, while a different topic retains one final across recovery.');
  // Failure/cancellation notices have no provider final ID. Destination
  // reservations must still recognize another topic's root/thread aliases.
  for (const terminalState of ['failed', 'cancelled']) {
    const failedSession = await rpc('create');
    const rootId = `terminal-${terminalState}`;
    const failedRun = await rpc('accept', failedSession.id, 'Hold shared execution', [],
      multiOptions(rootId, firstReplyPlan));
    await until(async () => (await logs()).some(event => event.runId === failedRun.run.id
      && event.kind === 'turn/start'), terminalState + ' turn starts');
    const terminalAlias = structuredClone(otherTopic);
    delete terminalAlias.target.rootId; terminalAlias.target.messageId = 'terminal-followup';
    const inputs = [`${rootId}-other`, `${rootId}-alias`];
    for (const [index, plan] of [otherTopic, terminalAlias].entries()) {
      await rpc('accept', failedSession.id, 'Apply this supplement', [], multiOptions(inputs[index], plan));
      await until(async () => (await receipt(failedRun.run.id, inputs[index]))?.state === 'accepted', inputs[index] + ' accepted');
    }
    if (terminalState === 'failed') {
      await rpc('accept', failedSession.id, 'FAIL_NATIVE_TURN', [], multiOptions(`${rootId}-failure`, firstReplyPlan));
    } else {
      await rpc('cancel', failedSession.id, { expectedRunId: failedRun.run.id });
    }
    for (const id of [rootId, ...inputs]) {
      await until(async () => (await rpc('response', failedSession.id, id))?.state === terminalState, id + ' settles ' + terminalState);
    }
    const terminalClaims = [];
    for (let index = 0; index < 2; index++) {
      let claimed;
      await until(async () => { claimed = await rpc('claim', { connector: 'feishu' }); return claimed; }, terminalState + ' topics receive notice');
      terminalClaims.push(claimed.delivery);
      assert.match(claimed.delivery.text, terminalState === 'failed' ? /任务执行失败/ : /任务已取消/);
      await rpc('complete', claimed.delivery.id, claimed.leaseId, { externalId: `${rootId}-final-${index}` });
    }
    // Either alias may win the reservation race; both must address the same
    // original thread, regardless of which input's message anchor is kept.
    assert.deepEqual(terminalClaims.map(part => part.target.threadId).sort(), ['other-thread', 'steering-thread']);
    assert.equal(await rpc('claim', { connector: 'feishu' }), null, terminalState + ' aliases cannot send a third notice');
    await rpc('shutdown'); await killController(); await boot();
    assert.equal(await rpc('claim', { connector: 'feishu' }), null, terminalState + ' recovery cannot repeat notices');
    await evidence(`PASS: ${terminalState} shared Run publishes one notice per topic despite root/thread aliases, including recovery without a provider final ID.`);
  }
  const questionSession = await rpc('create');
  const questioning = await accept(questionSession.id, 'question-root', 'ASK_NATIVE_QUESTION');
  let questionClaim;
  await until(async () => { questionClaim = await rpc('claim', { connector: 'feishu' }); return questionClaim; }, 'native question is published in same Feishu conversation');
  assert.match(questionClaim.delivery.text, /^【待你回复】/);
  assert.match(questionClaim.delivery.text, /1\. 简短/);
  assert.match(questionClaim.delivery.text, /不会超时自动选择/);
  assert.equal(questionClaim.delivery.nativeQuestion.deadline, null);
  assert.equal(questionClaim.delivery.target.chatId, 'same-chat');
  assert.equal(questionClaim.delivery.nativeQuestion.state, 'pending');
  await rpc('complete', questionClaim.delivery.id, questionClaim.leaseId, { externalId: 'question-message' });
  await killController(); await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'restart must not republish the pending question');
  assert.equal((await rpc('session', questionSession.id)).activity.run.waiting, true, 'waiting survives a control-plane restart');
  const questionReplyOptions = { ...options('question-answer'), model: 'irrelevant-auto-snapshot', nativeQuestionId: questionClaim.delivery.nativeQuestion.id };
  await assert.rejects(rpc('accept', questionSession.id, '1', [], { ...options('wrong-question'), nativeQuestionId: 'old-question' }), { code: 'QUESTION_EXPIRED' });
  const attributedChoice = buildAttributedFeishuMessage({ chatType: 'topic', sender: { name: '嘉年' }, messageText: '2' });
  await rpc('accept', questionSession.id, attributedChoice, [], questionReplyOptions);
  await until(async () => (await receipt(questioning.run.id, 'question-answer'))?.state === 'accepted', 'native question answer gets a durable receipt');
  const answerReceipt = await receipt(questioning.run.id, 'question-answer');
  assert.equal(answerReceipt.result.mode, 'question_answer');
  assert.deepEqual((await logs()).find(e => e.kind === 'question-answer').result, { answers: { format: { answers: ['详细'] } } });
  assert.equal((await logs()).filter(e => e.runId === questioning.run.id && e.kind === 'turn/steer').length, 0, 'numeric answer returns to the question tool, not turn/steer');
  assert.equal((await rpc('accept', questionSession.id, attributedChoice, [], questionReplyOptions)).duplicate, true, 'answer replay retains admission fingerprint after question expires');
  await awaitAnswer(questionSession.id, 'question-root');
  assert.equal((await rpc('session', questionSession.id)).activity.run.waiting, false, 'the settled answer clears waiting');
  await killController(); await boot();
  assert.equal((await logs()).filter(e => e.kind === 'question-answer').length, 1, 'restart cannot repeat the native tool response');
  let questionFinal;
  await until(async () => { questionFinal = await rpc('claim', { connector: 'feishu' }); return questionFinal; }, 'question run delivers its result');
  assert.equal(questionFinal.delivery.nativeQuestion.state, 'answered', 'state-only update targets the original card');
  await rpc('complete', questionFinal.delivery.id, questionFinal.leaseId, { externalId: 'question-message' });
  await until(async () => { questionFinal = await rpc('claim', { connector: 'feishu' }); return questionFinal; }, 'question final response');
  assert.equal(questionFinal.delivery.text, '【最终答复】\n\ndurable native answer');
  await rpc('complete', questionFinal.delivery.id, questionFinal.leaseId, { externalId: 'question-result' });
  assert.equal(await rpc('claim', { connector: 'feishu' }), null);
  await evidence('PASS: numbered question shown in same Feishu chat; controller restart preserves pending choice, and duplicate reply reaches native tool exactly once.');
  const customSession = await rpc('create');
  const customQuestion = await accept(customSession.id, 'custom-question-root', 'ASK_NATIVE_QUESTION');
  let customClaim;
  await until(async () => { customClaim = await rpc('claim', { connector: 'feishu' }); return customClaim; }, 'custom-answer question appears');
  await rpc('complete', customClaim.delivery.id, customClaim.leaseId, { externalId: 'custom-question-message' });
  const customText = '请用中文\n保留代码例子';
  const attributedCustom = buildAttributedFeishuMessage({ chatType: 'group', sender: { name: '嘉年' }, messageText: customText });
  await rpc('accept', customSession.id, attributedCustom, [], { ...options('custom-question-answer'), nativeQuestionId: customClaim.delivery.nativeQuestion.id });
  await until(async () => (await receipt(customQuestion.run.id, 'custom-question-answer'))?.state === 'accepted', 'Feishu custom answer gets a receipt');
  assert.deepEqual((await logs()).find(e => e.runId === customQuestion.run.id && e.kind === 'question-answer').result, { answers: { format: { answers: [customText] } } });
  await awaitAnswer(customSession.id, 'custom-question-root');
  await until(async () => { customClaim = await rpc('claim', { connector: 'feishu' }); return customClaim; }, 'custom answer final response');
  assert.equal(customClaim.delivery.nativeQuestion.state, 'answered');
  await rpc('complete', customClaim.delivery.id, customClaim.leaseId, { externalId: 'custom-question-message' });
  await until(async () => { customClaim = await rpc('claim', { connector: 'feishu' }); return customClaim; }, 'custom answer final result');
  await rpc('complete', customClaim.delivery.id, customClaim.leaseId, { externalId: 'custom-question-result' });
  await evidence('PASS: real Feishu speaker envelope is removed for numeric shortcuts and multiline custom answers while the transcript retains attribution.');
  const earlySession = await rpc('create');
  const early = await accept(earlySession.id, 'early-final-root', 'Keep the native execution open');
  await until(async () => (await logs()).some(event => event.runId === early.run.id && event.kind === 'turn/start'), 'early-final turn started');
  await accept(earlySession.id, 'early-final-steer', 'PUBLISH_FINAL_EARLY');
  await until(async () => (await rpc('history', earlySession.id)).some(event => event.phase === 'final_answer'), 'final phase reaches durable history');
  assert.equal((await rpc('response', earlySession.id, 'early-final-root')).state, 'running');
  assert.equal(await rpc('claim', { connector: 'feishu' }), null,
    'a model final is held while the actual execution remains running');
  await killController(); await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'controller recovery still holds the early final');
  await writeFile(join(root, `${early.run.id}.release`), '');
  await until(async () => (await rpc('response', earlySession.id, 'early-final-root')).state === 'ready', 'early-final execution finishes');
  const earlyClaim = await rpc('claim', { connector: 'feishu' });
  assert.equal(earlyClaim.delivery.text, '【最终答复】\n\ndurable native answer', 'delivery occurs once execution has stopped');
  const earlyAnswer = (await rpc('history', earlySession.id)).find(event => event.phase === 'final_answer');
  assert.equal(earlyClaim.delivery.providerMessageId, earlyAnswer.providerMessageId, 'terminal fallback retains the actual final identity');
  await rpc('complete', earlyClaim.delivery.id, earlyClaim.leaseId, { externalId: 'early-final-message' });
  assert.ok((await rpc('history', earlySession.id)).some(event => event.type === 'source_delivery'
    && event.providerMessageId === earlyAnswer.providerMessageId && event.state === 'delivered'
    && event.externalId === 'early-final-message'), 'confirmed terminal delivery reaches canonical history');
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'terminal settlement cannot duplicate the final or send commentary');
  await evidence('PASS: an early model final waits for stopped execution; controller recovery and terminal settlement keep one delivery.');
  const fileSession = await rpc('create');
  const fileRun = await accept(fileSession.id, 'early-file-root', 'Hold execution for file publication');
  await until(async () => (await logs()).some(event => event.runId === fileRun.run.id && event.kind === 'turn/start'), 'file turn starts');
  await accept(fileSession.id, 'early-file-steer', 'PUBLISH_FINAL_FILE_EARLY');
  await until(async () => (await rpc('history', fileSession.id)).some(event => event.phase === 'final_answer'), 'file final reaches history');
  assert.equal((await rpc('response', fileSession.id, 'early-file-root')).state, 'running');
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'final text and file wait while execution continues');
  await killController(); await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'restart does not announce delivery before execution stops');
  await writeFile(join(root, `${fileRun.run.id}.release`), '');
  await until(async () => (await rpc('response', fileSession.id, 'early-file-root')).state === 'ready', 'file execution ends');
  let fileClaim;
  await until(async () => { fileClaim = await rpc('claim', { connector: 'feishu' }); return fileClaim; }, 'stopped execution publishes file result');
  assert.ok(fileClaim.delivery.text.startsWith('【最终答复】'));
  assert.match(fileClaim.delivery.text, /文件已准备好/);
  assert.doesNotMatch(fileClaim.delivery.text, /Artifacts|early-result.txt/);
  await rpc('complete', fileClaim.delivery.id, fileClaim.leaseId, { externalId: 'early-file-text' });
  const attachmentClaim = await rpc('claim', { connector: 'feishu' });
  assert.equal(attachmentClaim.delivery.kind, 'attachment');
  assert.equal(attachmentClaim.delivery.providerMessageId, fileClaim.delivery.providerMessageId);
  assert.equal(attachmentClaim.delivery.providerPartCount, 2, 'text alone cannot confirm a multipart result');
  assert.equal(attachmentClaim.delivery.attachment.originalName, 'early-result.txt');
  assert.ok(attachmentClaim.delivery.attachment.assetId);
  assert.equal((await rpc('response', fileSession.id, 'early-file-root')).state, 'ready');
  await rpc('complete', attachmentClaim.delivery.id, attachmentClaim.leaseId, { externalId: 'early-file-attachment' });
  await killController(); await boot();
  assert.equal(await rpc('claim', { connector: 'feishu' }), null);
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'terminal asset pass does not resend the text or file');
  await evidence('PASS: final text and file are delivered after execution stops; restart and terminal settlement do not resend either.');
  const session = await rpc('create');
  const first = await accept(session.id, 'first', 'Start held native work');
  await until(async () => (await logs()).some(event => event.runId === first.run.id && event.kind === 'turn/start'), 'first native turn started');
  await rpc('runtime', session.id, { model: 'later-session-default', effort: 'high' });
  await assert.rejects(rpc('accept', session.id, 'Switch the active runtime', [], { ...options('blocked-switch'), tool: 'fake-switch' }), error => error.code === 'SESSION_BUSY');
  await assert.rejects(rpc('accept', session.id, 'Explicit model change', [], {
    ...options('blocked-model-switch'), model: 'explicit-new-model',
  }), error => error.code === 'SESSION_BUSY');
  const secondOptions = {
    ...options('second'), model: 'connector-default', effort: 'high', runtimeSelectionScope: 'auto',
  };
  const second = await rpc('accept', session.id, 'Use my correction immediately', [], secondOptions);
  assert.equal(second.queued, false, 'native input admission is not reported as a controller-managed task queue');
  await until(async () => (await receipt(first.run.id, 'second'))?.state === 'accepted', 'second input acknowledged durably before completion');
  assert.equal((await logs()).filter(event => event.runId === first.run.id && event.kind === 'completed').length, 0);
  assert.equal((await logs()).filter(event => event.runId === first.run.id && event.kind === 'process-start').length, 1);
  await assert.rejects(rpc('remove', session.id, 'second'), error => error.code === 'REQUEST_NOT_QUEUED');
  await evidence('PASS: second user message reached native turn/steer before the active turn completed, in one detached Harness process.');
  await killController(); await boot();
  const duplicate = await rpc('accept', session.id, 'Use my correction immediately', [], secondOptions);
  assert.equal(duplicate.duplicate, true);
  await accept(session.id, 'third', 'Another correction after controller recovery');
  await until(async () => (await receipt(first.run.id, 'third'))?.state === 'accepted', 'third input steered after recovery');
  assert.equal((await logs()).filter(event => event.kind === 'turn/steer' && event.clientId === 'second').length, 1);
  assert.equal((await logs()).filter(event => event.runId === first.run.id && event.kind === 'process-start').length, 1);
  await killController();
  await writeFile(join(root, `${first.run.id}.release`), '');
  await until(async () => !!await readFile(join(config, 'chat-runs', first.run.id, 'result.json'), 'utf8').catch(() => ''), 'detached native process finishes without controller');
  await boot();
  for (const requestId of ['first', 'second', 'third']) await awaitAnswer(session.id, requestId);
  const history = await rpc('history', session.id);
  assert.equal(history.filter(event => event.type === 'message' && event.role === 'user').length, 3);
  assert.equal(history.filter(event => event.type === 'message' && event.role === 'assistant' && event.content === 'durable native answer').length, 1);
  const claim = await rpc('claim', { connector: 'feishu' });
  assert.equal(claim.delivery.text, '【最终答复】\n\ndurable native answer');
  await rpc('complete', claim.delivery.id, claim.leaseId, { externalId: 'one-final-reply' });
  assert.equal(await rpc('claim', { connector: 'feishu' }), null, 'same conversation gets one final publication for all steered messages');
  await evidence('PASS: SIGKILL/controller recovery preserved one execution and one copy of each accepted input; all three response addresses share one final answer and one Feishu publication.');

  const pilotPlan = messageId => ({ connector: 'feishu', sourceRouteId: 'default', target: {
    chatId: 'pilot-chat', tenantKey: 'tenant', chatType: 'group', conversationKind: 'main', messageId } });
  const pilotOptions = (requestId, person = 'a') => ({ ...options(requestId), sourceDelivery: pilotPlan(requestId),
    viewPersonId: 'person_' + person, initiatedByIdentityId: 'identity_' + person,
    feishuConnectorAuthenticated: true, allowGroupFeedWrite: true,
    sourceContext: { connector: 'feishu', sourceRouteId: 'default', chatType: 'group', messageId: requestId,
      chatId: 'pilot-chat', createTime: Date.now(), sender: { senderType: 'user', openId: person } } });
  for (const person of ['a', 'b']) await rpc('message-settings', { action: 'apply', expectedRevision: 0, confirm: true,
    choices: { opening: true, checklist: true, progress: 'messages', routing: 'experimental' } },
    { personId: `person_${person}`, identityId: `identity_${person}` });
  const pilot = await rpc('create', { conversation: pilotPlan('pilot-root'), sourceId: 'feishu' });
  const pilotRoot = await rpc('accept', pilot.id, 'Start held research A', [], pilotOptions('pilot-root'));
  await until(async () => (await logs()).some(event => event.runId === pilotRoot.run.id && event.kind === 'turn/start'), 'pilot mainline begins');
  const supplement = await rpc('accept', pilot.id, 'Add ideas to research A', [], pilotOptions('pilot-supplement'));
  const independent = await rpc('accept', pilot.id, 'Start independent research B', [], pilotOptions('pilot-independent', 'b'));
  const status = await rpc('accept', pilot.id, 'Where is the answer?', [], pilotOptions('pilot-status', 'b'));
  await rpc('accept', pilot.id, 'An input whose handling marker is omitted', [], pilotOptions('pilot-unhandled'));
  assert.equal(supplement.queued, false); assert.equal(status.queued, false);
  assert.equal(independent.queued, false);
  for (const id of ['pilot-supplement', 'pilot-independent', 'pilot-status', 'pilot-unhandled']) {
    await until(async () => (await receipt(pilotRoot.run.id, id))?.state === 'accepted', id + ' reaches held execution');
  }
  assert.equal((await logs()).filter(event => event.runId === pilotRoot.run.id && event.kind === 'completed').length, 0);
  // New admission has withdrawn routing. Exercise recovery of already accepted
  // legacy pilot work without restoring the production opt-in path.
  for (const id of ['pilot-root', 'pilot-supplement', 'pilot-independent', 'pilot-status', 'pilot-unhandled']) {
    assert.equal((await rpc('request', pilot.id, id)).options.messageRoutingPolicy.mechanism, 'none');
    await rpc('legacy-routing-snapshot', pilot.id, id);
  }
  const handoff = await rpc('route-input', pilot.id, 'pilot-root', {
    mode: 'new', task: 'Research A including the supplement', reason: 'same research', requestIds: ['pilot-root', 'pilot-supplement'] });
  const separate = await rpc('route-input', pilot.id, 'pilot-independent', {
    mode: 'new', task: 'Research B', reason: 'a different matter from another author' });
  assert.notEqual(separate.targetSessionId, handoff.targetSessionId);
  const statusText = '两个请求已转入研究话题，结果会在那里回复。';
  const statusReply = await rpc('reply-input', pilot.id, 'pilot-status', { text: statusText });
  assert.equal(statusReply.state, 'queued');
  // The status answer can be claimed while the original execution is still held.
  const pilotClaims = [];
  let statusClaim;
  await until(async () => {
    const item = await rpc('claim', { connector: 'feishu' });
    if (!item) return false;
    pilotClaims.push(item.delivery);
    await rpc('complete', item.delivery.id, item.leaseId, { externalId: 'pilot-' + pilotClaims.length });
    if (item.delivery.text === statusText) statusClaim = item;
    return Boolean(statusClaim);
  }, 'status response is ready before the research/mainline execution completes');
  assert.equal(statusClaim.delivery.target.messageId, 'pilot-status');
  assert.equal(statusClaim.delivery.target.replyInThread, undefined);
  assert.equal((await rpc('response', pilot.id, 'pilot-root')).state, 'running');
  await killController(); await boot();
  await rpc('reply-input', pilot.id, 'pilot-status', { text: statusText });
  assert.equal((await rpc('request', pilot.id, 'pilot-status')).deliveries.filter(d => d.kind === 'content').length, 1);
  await writeFile(join(root, `${pilotRoot.run.id}.release`), '');
  for (const id of ['pilot-root', 'pilot-supplement', 'pilot-independent', 'pilot-status']) {
    await until(async () => (await rpc('response', pilot.id, id))?.state === 'ready', id + ' settles independently');
  }
  assert.equal((await rpc('response', pilot.id, 'pilot-status')).payload.text, statusText);
  assert.equal((await rpc('response', pilot.id, 'pilot-supplement')).payload.text, '', 'a routed supplement does not inherit the root final');
  assert.equal((await rpc('request', pilot.id, 'pilot-supplement')).routingHandoff.targetSessionId, handoff.targetSessionId);
  assert.equal((await rpc('request', pilot.id, 'pilot-independent')).routingHandoff.targetSessionId, separate.targetSessionId);
  await until(async () => (await rpc('response', pilot.id, 'pilot-unhandled'))?.state === 'failed', 'omitted handling stays incomplete');
  assert.equal((await rpc('request', pilot.id, 'pilot-unhandled')).result.state, 'failed');
  assert.equal((await rpc('request', pilot.id, 'pilot-root')).deliveredAt, undefined);
  while (true) {
    const item = await rpc('claim', { connector: 'feishu' }); if (!item) break;
    pilotClaims.push(item.delivery);
    assert.notEqual(item.delivery.text, statusText, 'settlement never republishes the early per-input reply');
    assert.notEqual(item.delivery.text, 'durable native answer', 'routed root final is not published in the mainline');
    await rpc('complete', item.delivery.id, item.leaseId, { externalId: 'pilot-' + pilotClaims.length });
  }
  await writeFile(join(root, `${handoff.receipts[0].run.id}.release`), '');
  await until(async () => (await rpc('response', handoff.targetSessionId, 'routed:pilot-root'))?.state === 'ready', 'research topic finishes');
  let topicClaim;
  await until(async () => { topicClaim = await rpc('claim', { connector: 'feishu' }); return Boolean(topicClaim); }, 'research result is in the saved work topic');
  assert.equal(topicClaim.delivery.target.rootId, 'pilot-root');
  assert.equal(topicClaim.delivery.target.replyInThread, true);
  await rpc('complete', topicClaim.delivery.id, topicClaim.leaseId, { externalId: 'pilot-research' });
  await writeFile(join(root, `${separate.receipts[0].run.id}.release`), '');
  await until(async () => (await rpc('response', separate.targetSessionId, 'routed:pilot-independent'))?.state === 'ready', 'independent research finishes');
  await until(async () => { topicClaim = await rpc('claim', { connector: 'feishu' }); return Boolean(topicClaim); }, 'independent result has its own topic');
  assert.equal(topicClaim.delivery.target.rootId, 'pilot-independent');
  await rpc('complete', topicClaim.delivery.id, topicClaim.leaseId, { externalId: 'pilot-independent-research' });
  assert(!pilotClaims.some(d => d.target.messageId === 'pilot-unhandled'), 'missing coverage remains failed internally without inventing a group reply');
  await evidence('PASS: pilot supplement, independent matter and another author status steer before root completion; topics remain distinct, status sends immediately at its own anchor, omitted handling stays incomplete, restart and settlement never duplicate/root-copy replies.');

  const raceSession = await rpc('create');
  const raceRoot = await accept(raceSession.id, 'race-first', 'Start a completion-race turn');
  await until(async () => (await logs()).some(event => event.runId === raceRoot.run.id && event.kind === 'turn/start'), 'race turn started');
  await accept(raceSession.id, 'race-followup', 'RACE_NATIVE_COMPLETION');
  await until(async () => (await receipt(raceRoot.run.id, 'race-followup'))?.state === 'accepted', 'completion-race input safely starts native follow-up');
  const raceLog = (await logs()).filter(event => event.runId === raceRoot.run.id);
  assert.equal(raceLog.filter(event => event.kind === 'process-start').length, 1);
  assert.equal(raceLog.filter(event => event.kind === 'turn/start').length, 2);
  assert.equal(raceLog.filter(event => event.kind === 'turn/steer').length, 1);
  await writeFile(join(root, `${raceRoot.run.id}.release`), '');
  await awaitAnswer(raceSession.id, 'race-first'); await awaitAnswer(raceSession.id, 'race-followup');
  await evidence('PASS: explicit no-active-turn rejection during the completion race started the follow-up once in the existing Harness, without losing the input or launching a duplicate process.');

  const rejectedSession = await rpc('create');
  const rejectedRoot = await accept(rejectedSession.id, 'reject-first', 'Keep the valid root running');
  await until(async () => (await logs()).some(event => event.runId === rejectedRoot.run.id && event.kind === 'turn/start'), 'rejection test root started');
  await accept(rejectedSession.id, 'reject-input', 'REJECT_NATIVE_INPUT');
  await until(async () => (await rpc('response', rejectedSession.id, 'reject-input'))?.state === 'failed', 'definite native rejection settles just that input');
  assert.equal((await rpc('response', rejectedSession.id, 'reject-first')).state, 'running');
  await accept(rejectedSession.id, 'reject-recovery', 'Valid correction after rejected input');
  await until(async () => (await receipt(rejectedRoot.run.id, 'reject-recovery'))?.state === 'accepted', 'valid correction follows native rejection');
  await writeFile(join(root, `${rejectedRoot.run.id}.release`), '');
  await awaitAnswer(rejectedSession.id, 'reject-first'); await awaitAnswer(rejectedSession.id, 'reject-recovery');
  const rejectedLog = (await logs()).filter(event => event.runId === rejectedRoot.run.id);
  assert.equal(rejectedLog.filter(event => event.kind === 'turn/steer' && event.clientId === 'reject-input').length, 1, 'a rejected input is never retried');
  assert.equal(rejectedLog.filter(event => event.kind === 'process-start').length, 1, 'input rejection does not restart the active Harness');
  await evidence('PASS: an explicit native input rejection fails only that request, preserves the active turn, and accepts the next valid correction without replay.');

  // A triggered task deliberately remains sequential. Admission must describe
  // the same waiting request as Session detail and queue removal do.
  const internalSession = await rpc('create');
  const internalRoot = await rpc('accept', internalSession.id, 'Run an independent scheduled operation', [], {
    ...options('internal-root'), internalOperation: 'trigger_delivery',
  });
  await until(async () => (await logs()).some(event => event.runId === internalRoot.run.id && event.kind === 'turn/start'), 'internal native turn started');
  const blocked = await accept(internalSession.id, 'blocked-followup', 'Wait for the internal operation');
  assert.equal(blocked.queued, true, 'user input behind an internal native operation must report queued');
  assert.equal(blocked.response.state, 'queued');
  assert.equal(blocked.session.activity.queue.count, 1);
  assert.deepEqual((await rpc('session', internalSession.id)).queuedMessages.map(item => item.requestId), ['blocked-followup']);
  const duplicateBlocked = await accept(internalSession.id, 'blocked-followup', 'Wait for the internal operation');
  assert.equal(duplicateBlocked.duplicate, true);
  assert.equal(duplicateBlocked.queued, true, 'duplicate admission retains the actual waiting state');
  await rpc('shutdown');
  await killController(); await boot();
  const recoveredBlocked = await accept(internalSession.id, 'blocked-followup', 'Wait for the internal operation');
  assert.equal(recoveredBlocked.queued, true, 'controller recovery preserves the internal-operation queue boundary');
  assert.equal(await receipt(internalRoot.run.id, 'blocked-followup'), null, 'queued input never entered native transport');
  const removed = await rpc('remove', internalSession.id, 'blocked-followup');
  assert.equal(removed.session.activity.queue.count, 0);
  assert.equal((await rpc('response', internalSession.id, 'blocked-followup')).state, 'cancelled');
  const removedReplay = await accept(internalSession.id, 'blocked-followup', 'Wait for the internal operation');
  assert.equal(removedReplay.queued, false, 'removed input must not be reported as queued or resurrected');
  assert.equal(removedReplay.response.state, 'cancelled');
  await writeFile(join(root, `${internalRoot.run.id}.release`), '');
  await awaitAnswer(internalSession.id, 'internal-root');
  assert.equal((await logs()).filter(event => event.clientId === 'blocked-followup').length, 0);
  await evidence('PASS: internal native work keeps follow-ups queued consistently across admission, detail, duplicate, restart and removal; accepted native input cannot be removed.');
  const sender = await rpc('create');
  const target = await rpc('create');
  const humanOptions = (requestId, who) => ({ requestId, tool: 'fake-native', viewPersonId: 'person_' + who, initiatedByIdentityId: 'identity_' + who });
  const senderRun = await rpc('accept', sender.id, '设计同一项开工方案', [], humanOptions('work-a', 'a'));
  const targetRun = await rpc('accept', target.id, '设计同一项开工方案', [], humanOptions('work-b', 'b'));
  await until(async () => (await logs()).some(event => event.runId === targetRun.run.id && event.kind === 'turn/start'), 'target native turn active');
  const actor = { personId: 'person_a', identityId: 'identity_a', name: '甲' };
  const draft = await rpc('work-suggest', { sessionId: sender.id, targetSessionId: target.id, actor, requestId: 'work-draft',
    content: '另一边也在设计开工方案，建议核对重叠部分。', impact: '可能减少重复工作', evidenceRefs: [1] });
  assert.equal((await rpc('work-inbox', target.id)).length, 0);
  const publishText = '确认协作建议 ' + draft.suggestion.id + ' 发布';
  await rpc('accept', sender.id, publishText, [], { requestId: 'agent-cannot-publish', tool: 'fake-native',
    viewPersonId: 'person_system', initiatedByIdentityId: 'identity_system' });
  await until(async () => (await receipt(senderRun.run.id, 'agent-cannot-publish'))?.state === 'accepted', 'unverified command safely reported to Harness');
  assert.match((await logs()).find(event => event.clientId === 'agent-cannot-publish').text, /NOT accepted/);
  assert.equal((await rpc('work-inbox', target.id)).length, 0);
  await rpc('accept', sender.id, publishText, [], humanOptions('work-publish', 'a'));
  await until(async () => (await receipt(targetRun.run.id, 'work-reference:' + draft.suggestion.id))?.state === 'accepted', 'reference gets native receipt');
  const input = (await logs()).find(event => event.clientId === 'work-reference:' + draft.suggestion.id);
  assert.match(input.text, /Reference-only cross-Session input/);
  assert.match(input.text, /尚未获准修改当前任务/);
  assert.equal((await rpc('work-inbox', target.id))[0].state, 'published');
  await rpc('accept', sender.id, publishText, [], humanOptions('work-publish', 'a'));
  assert.equal((await logs()).filter(event => event.clientId === 'work-reference:' + draft.suggestion.id).length, 1, 'duplicate publication is not repeated');
  const awaiting = await rpc('create');
  const awaitingRun = await rpc('accept', awaiting.id, 'ASK_NATIVE_QUESTION', [], humanOptions('work-question', 'b'));
  await until(async () => (await logs()).some(event => event.runId === awaitingRun.run.id && event.kind === 'turn/start'), 'question turn started');
  await until(async () => (await rpc('history', awaiting.id)).some(event => event.messageKind === 'user_question' && event.questionState === 'pending'), 'pending question projected');
  const questionDraft = await rpc('work-suggest', { sessionId: sender.id, targetSessionId: awaiting.id, actor, requestId: 'work-question-draft',
    content: '这条建议只能参考，不能替人回答问题。', impact: '补充背景', evidenceRefs: [1] });
  await rpc('accept', sender.id, '确认协作建议 ' + questionDraft.suggestion.id + ' 发布', [], humanOptions('work-question-publish', 'a'));
  assert.equal((await rpc('work-inbox', awaiting.id))[0].receipt.state, 'inbox-only');
  assert.equal((await logs()).filter(event => event.runId === awaitingRun.run.id && event.kind === 'question-answer').length, 0);
  await rpc('accept', awaiting.id, '1', [], humanOptions('work-question-answer', 'b'));
  await rpc('accept', target.id, '确认协作建议 ' + draft.suggestion.id + ' 执行', [], humanOptions('work-adopt', 'b'));
  assert.equal((await rpc('work-inbox', target.id))[0].state, 'approved');
  await until(async () => (await receipt(targetRun.run.id, 'work-adopt'))?.state === 'accepted', 'human adoption acknowledged by native Harness');
  await writeFile(join(root, senderRun.run.id + '.release'), '');
  await writeFile(join(root, targetRun.run.id + '.release'), '');
  await awaitAnswer(sender.id, 'work-a'); await awaitAnswer(target.id, 'work-b'); await awaitAnswer(awaiting.id, 'work-question');
  await evidence('PASS: human-approved publication reaches a running Harness exactly once as reference-only; adoption requires a separate target human input; a reference cannot answer a pending question.');

  // People can share an active native Run, but must not share personal reply
  // or work-start defaults. Exercise admission, not only the settings resolver.
  const policyActor = who => ({ personId: `person_${who}`, identityId: `identity_${who}` });
  const originalPolicy = await rpc('message-settings', { action: 'apply', expectedRevision: 1, confirm: true,
    choices: { opening: false, checklist: false, progress: 'none', strictStartCheck: true, selfReview: true, routing: 'none' } }, policyActor('a'));
  const otherPolicy = await rpc('message-settings', { action: 'apply', expectedRevision: 1, confirm: true,
    choices: { opening: true, checklist: false, progress: 'card_latest', strictStartCheck: false, routing: 'none' } }, policyActor('b'));
  const policySession = await rpc('create');
  const policyOptions = (id, who) => ({ ...pilotOptions(id, who), sourceDelivery: replyPlan(id),
    sourceContext: { ...pilotOptions(id, who).sourceContext, chatId: 'steering-chat' } });
  const policyOtherOptions = policyOptions('policy-other', 'b');
  const policyRoot = await rpc('accept', policySession.id, 'Hold personal-policy execution', [], policyOptions('policy-root', 'a'));
  await until(async () => (await logs()).some(event => event.runId === policyRoot.run.id && event.kind === 'turn/start'), 'personal-policy turn starts');
  const acceptedRootPolicy = (await rpc('request', policySession.id, 'policy-root')).options.messageReplyPolicy;
  assert.equal(acceptedRootPolicy.strictStartRule.version, 'v1');
  assert.equal(acceptedRootPolicy.strictStartRule.origin.requestId, 'policy-root');
  assert.equal(acceptedRootPolicy.strictStartRule.origin.sessionId, policySession.id);

  assert.equal(acceptedRootPolicy.deliverySelfReview.status, 'captured');
  await rpc('message-settings', { action: 'apply', expectedRevision: originalPolicy.revision,
    confirm: true, choices: { ...originalPolicy.choices, strictStartCheck: false, selfReview: false } }, policyActor('a'));
  for (const [id, who] of [['policy-other', 'b'], ['policy-same', 'a']]) {
    await rpc('accept', policySession.id, 'Continue shared execution', [], who === 'b' ? policyOtherOptions : policyOptions(id, who));
    await until(async () => (await receipt(policyRoot.run.id, id))?.state === 'accepted', id + ' steers once');
  }
  const admittedOther = await rpc('request', policySession.id, 'policy-other');
  assert.deepEqual(admittedOther.options.messageReplyPolicy, { ...otherPolicy.active, final: true }, 'another Person captures their own strict-start and display choices');
  assert.deepEqual((await rpc('request', policySession.id, 'policy-same')).options.messageReplyPolicy,
    acceptedRootPolicy, 'same-Person continuation keeps the accepted rule version/body/provenance after a toggle');
  const unknownOptions = policyOptions('policy-unknown', 'unknown');
  delete unknownOptions.viewPersonId; delete unknownOptions.initiatedByIdentityId;
  await rpc('accept', policySession.id, 'Continue without a verified Person', [], unknownOptions);
  await until(async () => (await receipt(policyRoot.run.id, 'policy-unknown'))?.state === 'accepted', 'unknown-author input is acknowledged before completing the Run');
  assert.equal((await rpc('request', policySession.id, 'policy-unknown')).options.messageReplyPolicy, undefined, 'unknown sender cannot borrow the head Person policy');
  await rpc('message-settings', { action: 'strict-start', expectedRevision: otherPolicy.revision,
    confirm: true, enabled: true }, policyActor('b'));
  assert.equal((await rpc('accept', policySession.id, 'Continue shared execution', [], policyOtherOptions)).duplicate, true);
  assert.deepEqual((await rpc('request', policySession.id, 'policy-other')).options.messageReplyPolicy,
    admittedOther.options.messageReplyPolicy, 'retry retains its own saved policy despite later setting changes');
  await writeFile(join(root, policyRoot.run.id + '.release'), '');
  for (const id of ['policy-root', 'policy-other', 'policy-same', 'policy-unknown']) await awaitAnswer(policySession.id, id, ['policy-root','policy-same'].includes(id));
  assert.equal((await logs()).filter(event => event.runId === policyRoot.run.id && event.kind === 'process-start').length, 1);
  const afterToggle = await rpc('accept', policySession.id, 'New work after disable', [], policyOptions('policy-disabled', 'a'));
  assert.equal((await rpc('request', policySession.id, 'policy-disabled')).options.messageReplyPolicy.selfReview, false);
  await writeFile(join(root, afterToggle.run.id + '.release'), '');
  await awaitAnswer(policySession.id, 'policy-disabled');
  await evidence('PASS: shared native admission isolates each Person strict-start/display policy, preserves same-author continuations and retries, and refuses unknown-author inheritance.');

  const groupReviewSession = await rpc('create');
  const groupReviewOptions = (id, enabled) => {
    const o = policyOptions(id, 'a'); o.sourceContext.tenantKey = 'tenant'; o.sourceDelivery.target.tenantKey = 'tenant';
    if (enabled) o.sourceContext.groupSelfReview = { enabled: true, revision: 1 };
    return o;
  };
  const groupRoot = await rpc('accept', groupReviewSession.id, 'Hold group review', [], groupReviewOptions('group-review-root', true));
  await until(async () => (await logs()).some(e => e.runId === groupRoot.run.id && e.kind === 'turn/start'), 'group review starts');
  const groupPolicy = (await rpc('request', groupReviewSession.id, 'group-review-root')).options.groupDeliverySelfReviewPolicy;
  assert.equal(groupPolicy.scope, 'group');
  assert.equal((await rpc('request', groupReviewSession.id, 'group-review-root')).options.messageReplyPolicy.selfReview, false);
  await rpc('accept', groupReviewSession.id, 'Continue after group off', [], groupReviewOptions('group-review-steer', false));
  await until(async () => (await receipt(groupRoot.run.id, 'group-review-steer'))?.state === 'accepted', 'group review steer accepted');
  assert.deepEqual((await rpc('request', groupReviewSession.id, 'group-review-steer')).options.groupDeliverySelfReviewPolicy, groupPolicy);
  await writeFile(join(root, groupRoot.run.id + '.release'), '');
  for (const id of ['group-review-root','group-review-steer']) await awaitAnswer(groupReviewSession.id,id,true);
  const groupOff = await rpc('accept', groupReviewSession.id, 'Fresh after group off', [], groupReviewOptions('group-review-off', false));
  assert.equal((await rpc('request', groupReviewSession.id, 'group-review-off')).options.groupDeliverySelfReviewPolicy, undefined);
  await writeFile(join(root, groupOff.run.id + '.release'), ''); await awaitAnswer(groupReviewSession.id,'group-review-off');
  await evidence('PASS group self-review: independent personal/display settings, same-work snapshot, native steer and new work after disable.');

  {
  // Real manager -> native transport -> durable receipt -> next prompt, including
  // controller recovery. No model or Feishu network is involved.
  const contextSession = await rpc('create');
  const background = { messageId: 'bg', messageRevision: '1', sender: 'Alice', time: 'today', text: 'UNSEEN_GROUP_FACT' };
  const contextOptions = id => ({ requestId: id, tool: 'fake-context', suppressSourceDelivery: true,
    sourceContext: { connector: 'feishu', sourceRouteId: 'default', chatId: 'context-chat', messageId: id,
      messageRevision: '1', conversationContext: { messages: [background] } } });
  const contextRoot = await rpc('accept', contextSession.id, 'first context', [], contextOptions('context-first'));
  // Queue the supplement immediately, before the root's native handshake and
  // receipt. Its context must reuse the root without delaying native steering.
  await rpc('accept', contextSession.id, 'second context', [], contextOptions('context-second'));
  await until(async () => (await receipt(contextRoot.run.id, 'context-first'))?.state === 'accepted', 'root context input accepted');
  const initialManifest = JSON.parse(await readFile(join(config, 'chat-runs', contextRoot.run.id, 'manifest.json'), 'utf8'));
  assert.equal(initialManifest.feishuContextDelivery.entries.length, 2);
  assert.match(initialManifest.prompt, /UNSEEN_GROUP_FACT/);
  assert.equal(initialManifest.ruleContextDelivery.mode, 'full');
  assert.match(initialManifest.prompt, /## Message visibility on RemoteLab surfaces/);
  await until(async () => (await receipt(contextRoot.run.id, 'context-second'))?.state === 'accepted', 'supplementary context accepted');
  const supplement = await rpc('request', contextSession.id, 'context-second');
  assert.equal(supplement.nativeContextDelivery.stats.removed, 1);
  assert.doesNotMatch(supplement.nativeInput.text, /UNSEEN_GROUP_FACT/);
  assert.equal(supplement.nativeRuleContextDelivery.mode, 'reference');
  assert.doesNotMatch(supplement.nativeInput.text, /## Message visibility on RemoteLab surfaces/);
  const recoveredRules = JSON.parse(await readFile(supplement.nativeRuleContextDelivery.file, 'utf8'));
  assert.ok(recoveredRules.rules.some(rule => rule.id === 'surface_messages'));
  assert.match(supplement.nativeInput.text, /Recovery snapshot:/);
  await killController(); await boot();
  await writeFile(join(root, contextRoot.run.id + '.release'), '');
  await awaitAnswer(contextSession.id, 'context-first');
  const contextNext = await rpc('accept', contextSession.id, 'third context', [], contextOptions('context-third'));
  await until(async () => (await receipt(contextNext.run.id, 'context-third'))?.state === 'accepted', 'resumed context accepted');
  const nextManifest = JSON.parse(await readFile(join(config, 'chat-runs', contextNext.run.id, 'manifest.json'), 'utf8'));
  assert.equal(nextManifest.feishuContextDelivery.stats.removed, 1);
  assert.equal(nextManifest.ruleContextDelivery.mode, 'reference');
  assert.doesNotMatch(nextManifest.prompt, /## Message visibility on RemoteLab surfaces/);
  assert.doesNotMatch(nextManifest.modelContext, /## Message visibility on RemoteLab surfaces/);
  assert.ok(nextManifest.modelContextSlots.some(slot => slot.id === 'active_rule_context'));
  assert.doesNotMatch(nextManifest.prompt, /UNSEEN_GROUP_FACT/);
  assert.doesNotMatch(nextManifest.modelContext, /UNSEEN_GROUP_FACT/, 'inspection equals delivered projection');
  const retained = await rpc('request', contextSession.id, 'context-third');
  assert.equal(retained.options.sourceContext.conversationContext.messages[0].text, 'UNSEEN_GROUP_FACT');
  await writeFile(join(root, contextNext.run.id + '.release'), '');
  await awaitAnswer(contextSession.id, 'context-third');
  await evidence('PASS: Feishu context delivered once across root, native supplement, restart and resumed Run; original source retained and model-context inspection matches actual prompt.');
  }
  succeeded = true;
  await evidence(`test-native-harness-integration: ok; validation log: ${validationLog}`);
} catch (error) {
  await evidence(`FAIL: ${error.stack}\nRetained isolated state: ${root}`);
  throw error;
} finally {
  await killController();
  for (const entry of (await logs()).filter(event => event.kind === 'process-start')) {
    try { process.kill(entry.pid, 'SIGTERM'); } catch {}
  }
  if (succeeded) await rm(root, { recursive: true, force: true });
}

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
  { id: 'fake-switch', name: 'Other runtime', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'batch', promptMode: 'bare-user' },
]));
await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, SHELL: '/bin/sh',
  REMOTELAB_CONFIG_DIR: config, REMOTELAB_MEMORY_DIR: join(root, 'memory'), REMOTELAB_WORK_ROOT_DIR: root,
  REMOTELAB_MEMORY_WRITEBACK: 'off', REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER: '1',
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
async function logs() { return (await readFile(join(root, 'native-log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
async function until(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timeout: ${description}\n${controllerErrors}\n${JSON.stringify(await logs())}`);
}
const receipt = (runId, requestId) => readFile(join(config, 'chat-runs', runId, 'native-inputs', `${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}.json`), 'utf8').then(JSON.parse).catch(() => null);
const options = requestId => ({ requestId, tool: 'fake-native', promptMode: 'bare-user', sourceDelivery: { connector: 'feishu', sourceRouteId: 'default', target: { chatId: 'same-chat' } } });
async function accept(sessionId, requestId, text) { return rpc('accept', sessionId, text, [], options(requestId)); }
async function awaitAnswer(sessionId, requestId) {
  await until(async () => (await rpc('response', sessionId, requestId))?.state === 'ready', `${requestId} gets final response`);
  const result = await rpc('response', sessionId, requestId);
  assert.equal(result.payload.text, 'durable native answer');
  return result;
}
try {
  await boot();
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
  await accept(customSession.id, 'custom-question-answer', attributedCustom);
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
  await assert.rejects(rpc('accept', session.id, 'Switch the active runtime', [], { ...options('blocked-switch'), tool: 'fake-switch' }), error => error.code === 'SESSION_BUSY');
  const second = await accept(session.id, 'second', 'Use my correction immediately');
  assert.equal(second.queued, false, 'native input admission is not reported as a controller-managed task queue');
  await until(async () => (await receipt(first.run.id, 'second'))?.state === 'accepted', 'second input acknowledged durably before completion');
  assert.equal((await logs()).filter(event => event.runId === first.run.id && event.kind === 'completed').length, 0);
  assert.equal((await logs()).filter(event => event.runId === first.run.id && event.kind === 'process-start').length, 1);
  await assert.rejects(rpc('remove', session.id, 'second'), error => error.code === 'REQUEST_NOT_QUEUED');
  await evidence('PASS: second user message reached native turn/steer before the active turn completed, in one detached Harness process.');
  await killController(); await boot();
  const duplicate = await accept(session.id, 'second', 'Use my correction immediately');
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

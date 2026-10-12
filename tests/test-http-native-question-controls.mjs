import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(join(tmpdir(), 'question-http-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab'), bin = join(home, 'bin');
await mkdir(config, { recursive: true }); await mkdir(bin);
await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) }));
await writeFile(join(config, 'auth-sessions.json'), JSON.stringify({
  fixture: { expiry: Date.now() + 3600000, role: 'owner' },
  connector: { expiry: Date.now() + 3600000, role: 'owner', authKind: 'service' },
}));
await writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'fake-native', command: 'fake-native', name: 'Fixture',
  runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user', models: [{ id: 'fake-model', label: 'Fixture' }] }]));
await copyFile(join(repo, 'tests/fixtures/native-codex-app-server.cjs'), join(bin, 'fake-native'));
await chmod(join(bin, 'fake-native'), 0o755);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.execPath, ['chat-server.mjs'], { cwd: repo,
  env: { ...process.env, HOME: home, CHAT_PORT: String(port), SECURE_COOKIES: '0',
    REMOTELAB_MEMORY_WRITEBACK: 'off', PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
const ready = new Promise((resolve, reject) => {
  server.stdout.on('data', chunk => { logs += chunk; if (logs.includes('Chat server listening')) resolve(); });
  server.stderr.on('data', chunk => { logs += chunk; });
  server.once('exit', () => reject(new Error(logs)));
});
async function request(method, path, body, connector = false) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: `session_token=${connector ? 'connector' : 'fixture'}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}
async function until(predicate) {
  const deadline = Date.now() + 15000;
  let delay = 25;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(1000, delay * 2);
  }
  throw new Error(`Question did not change state\n${logs}`);
}
try {
  await ready;
  for (const [groupFeed, inputKind] of [[false, 'control'], [true, 'control'], [false, 'typed'], [false, 'feishu-control']]) {
    const caseId = `${groupFeed}-${inputKind}`;
    const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'group', chatType: 'group', conversationKind: 'main' } };
    const created = await request('POST', '/api/sessions', { folder: home, tool: 'fake-native', model: 'fake-model',
      ...(groupFeed ? { groupFeed, sourceId: 'feishu', conversation, externalTriggerId: 'question-group' } : {}) }, true);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const sessionId = created.json.session.id;
    const messages = `/api/sessions/${sessionId}/messages`;
    const accepted = await request('POST', messages, { text: 'ASK_NATIVE_QUESTION', requestId: `root-${caseId}` }, true);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
    const getQuestion = async () => (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events
      ?.find(event => event.messageKind === 'user_question' && event.questionState === 'pending');
    const question = await until(getQuestion);
    assert.equal(question.questionDeadline, null, 'HTTP exposes an ordinary question with no automatic deadline');
    for (const view of ['', '?view=sidebar']) {
      const session = (await request('GET', `/api/sessions/${sessionId}${view}`)).json.session;
      assert.equal(session.activity.run.state, 'running', 'the waiting native run is still live');
      assert.equal(session.activity.run.waiting, true, 'detail and sidebar HTTP reads expose the real pending question');
    }
    const listed = (await request('GET', '/api/sessions')).json.sessions.find(session => session.id === sessionId);
    assert.equal(listed.activity.run.waiting, true, 'the initial Session list also exposes waiting');
    const visibleQuestion = (await request('GET', `/api/sessions/${sessionId}/events?filter=visible`)).json.events
      .find(event => event.questionId === question.questionId);
    assert.equal(visibleQuestion.questionState, 'pending', 'refresh retains the actionable original question');
    assert.equal(visibleQuestion.nativeQuestion.options.length, 2);
    const wrong = await request('POST', messages, { text: '1', requestId: `wrong-${groupFeed}`, nativeQuestionId: 'old-id' });
    assert.equal(wrong.status, 409); assert.equal(wrong.json.code, 'QUESTION_EXPIRED');
    if (groupFeed) assert.equal((await request('POST', messages, { text: 'ordinary-web-message' })).status, 403);
    const payload = { text: '2', requestId: inputKind === 'feishu-control' ? `feishu-question:${caseId}` : `answer-${caseId}`,
      ...(inputKind !== 'typed' ? { nativeQuestionId: question.questionId } : {}),
      ...(inputKind === 'control' ? { nativeQuestionAnswerSource: 'control' } : {}),
    };
    const answered = await request('POST', messages, payload, inputKind === 'feishu-control');
    assert.equal(answered.status, 202, JSON.stringify(answered.json));
    await until(async () => (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events
      ?.find(event => event.questionState === 'answered'));
    await until(async () => (await request('GET', `/api/sessions/${sessionId}?view=sidebar`)).json.session.activity.run.waiting === false);
    const rawEvents = (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events;
    const input = rawEvents.find(event => event.role === 'user' && event.requestId === payload.requestId);
    assert.equal(input.content, '2', 'the answer is retained in raw history');
    assert.equal(input.messageKind, inputKind === 'typed' ? undefined : 'native_question_answer');
    const visibleEvents = (await request('GET', `/api/sessions/${sessionId}/events?filter=visible`)).json.events;
    assert.equal(visibleEvents.some(event => event.role === 'user' && event.requestId === payload.requestId), inputKind === 'typed',
      'control feedback is confined to the original question; typed replies remain visible');
    const nativeAnswers = (await readFile(join(home, 'native-log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(event => event.kind === 'question-answer' && event.runId === question.runId);
    assert.equal(nativeAnswers.length, 1);
    assert.deepEqual(nativeAnswers[0].result.answers.format.answers, ['详细'], 'the native Harness received the actual selected option');
    const duplicate = await request('POST', messages, payload, inputKind === 'feishu-control');
    assert.equal(duplicate.status, 200); assert.equal(duplicate.json.duplicate, true);
    const late = await request('POST', messages, { ...payload, nativeQuestionId: question.questionId, requestId: `late-${caseId}` });
    assert.equal(late.status, 409); assert.equal(late.json.code, 'QUESTION_EXPIRED');
  }
  for (const [protocol, answer] of [['blocking', 'web'], ['blocking', 'feishu'], ['async', 'web'], ['async', 'feishu']]) {
    const caseId = `${protocol}-${answer}`;
    const created = await request('POST', '/api/sessions', { folder: home, tool: 'fake-native', model: 'fake-model' }, true);
    const sessionId = created.json.session.id, messages = `/api/sessions/${sessionId}/messages`;
    const rootRequest = await request('POST', messages, { text: 'Keep running', requestId: `root-${caseId}` }, true);
    const runId = rootRequest.json.run.id;
    const events = async () => (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events;
    const log = async () => (await readFile(join(home, 'native-log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(event => event.runId === runId);
    await until(async () => (await log()).some(event => event.kind === 'turn/start'));
    const ordinary = (id, text, type = 'text', createTime = Date.now()) => ({ requestId: `${caseId}-${id}`, text,
      tool: 'fake-native', model: 'auto', runtimeSelectionScope: 'auto',
      sourceContext: { connector: 'feishu', messageType: type, createTime: String(createTime),
        ingestion: { status: type === 'merge_forward' ? 'unparsed' : 'complete' } },
    });
    const send = async payload => {
      const result = await request('POST', messages, payload, true);
      assert.equal(result.status, 202, JSON.stringify(result.json));
      return result;
    };
    // The actual connector sends a partial Auto snapshot with no effort. Both
    // before and after a question, this must steer the admitted runtime.
    await send(ordinary('before-question', '补充：返回配置状态'));
    await until(async () => (await log()).some(event => event.clientId === `${caseId}-before-question`));
    await send(ordinary('create-question', protocol === 'async' ? 'ASK_ASYNC_ON_STEER' : 'ASK_ON_STEER'));
    const question = await until(async () => (await events()).find(event => event.questionState === 'pending'));
    if (protocol === 'blocking') {
      const rejected = await send(ordinary('rejected', 'REJECT_NATIVE_INPUT'));
      await until(async () => {
        const receiptFiles = await readdir(join(config, 'chat-runs', runId, 'native-inputs'));
        for (const file of receiptFiles) {
          const receipt = JSON.parse(await readFile(join(config, 'chat-runs', runId, 'native-inputs', file), 'utf8'));
          if (receipt.id === `${caseId}-rejected` && receipt.state === 'rejected') return true;
        }
      });
      assert.equal((await request('GET', `/api/sessions/${sessionId}?view=sidebar`)).json.session.activity.run.waiting, true,
        'native rejection cannot dismiss the unanswered question');
    }
    const payload = answer === 'web'
      ? { requestId: `${caseId}-supplement`, text: '先按新需求继续处理' }
      : ordinary('supplement', '【飞书群消息｜发言人：测试成员】\n先按新需求继续处理');
    const received = await request('POST', messages, payload, answer === 'feishu');
    assert.equal(received.status, 202, JSON.stringify(received.json));
    await until(async () => (await events()).find(event => event.questionState === 'superseded'));
    await until(async () => (await request('GET', `/api/sessions/${sessionId}?view=sidebar`)).json.session.activity.run.waiting === false);
    const visible = (await request('GET', `/api/sessions/${sessionId}/events?filter=visible`)).json.events;
    assert.equal(visible.filter(event => event.questionId === question.questionId).length, 1);
    assert.equal(visible.find(event => event.questionId === question.questionId).questionState, 'superseded');
    assert.ok(visible.some(event => event.role === 'user' && event.requestId === payload.requestId));
    const late = await request('POST', messages, { text: '2', requestId: `late-${caseId}`, nativeQuestionId: question.questionId });
    assert.equal(late.status, 409);
    const duplicate = await request('POST', messages, payload, answer === 'feishu');
    assert.equal(duplicate.json.duplicate, true);
    assert.equal((await log()).filter(event => event.clientId === payload.requestId).length, 1);
    assert.equal((await events()).some(event => event.questionState === 'answered'), false);
    const journals = await readdir(join(config, 'chat-runs', runId, 'native-questions'));
    const journal = JSON.parse(await readFile(join(config, 'chat-runs', runId, 'native-questions', journals[0]), 'utf8'));
    assert.equal(journal.state, 'superseded');
    assert.deepEqual(journal.answers, {}, 'continuation must not select an option or fabricate consent');
    if (protocol === 'blocking') {
      await until(async () => (await log()).some(event => event.kind === 'question-answer'));
      assert.deepEqual((await log()).find(event => event.kind === 'question-answer').result.answers, {});
    } else assert.equal((await log()).some(event => event.clientId === 'question:async-question'), false,
      'superseding an async question must not inject another model input');
    await send(ordinary('release', 'RELEASE_NATIVE'));
    await until(async () => (await request('GET', `/api/sessions/${sessionId}?view=sidebar`)).json.session.activity.run.state !== 'running');
  }
  console.log('native question HTTP: Web/Feishu controls reach native tools once, retain raw audit and update the original question without a user bubble; typed replies, stale IDs, group access and retries passed');
  console.log('native question continuation: Web and Feishu ordinary replies release blocking/async questions, preserve audit, reject old cards and replay once');
} finally {
  const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
  await rm(home, { recursive: true, force: true });
}

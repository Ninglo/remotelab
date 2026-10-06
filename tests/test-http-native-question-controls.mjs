import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
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
  for (const groupFeed of [false, true]) {
    const conversation = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'group', chatType: 'group', conversationKind: 'main' } };
    const created = await request('POST', '/api/sessions', { folder: home, tool: 'fake-native', model: 'fake-model',
      ...(groupFeed ? { groupFeed, sourceId: 'feishu', conversation, externalTriggerId: 'question-group' } : {}) }, true);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const sessionId = created.json.session.id;
    const messages = `/api/sessions/${sessionId}/messages`;
    const accepted = await request('POST', messages, { text: 'ASK_NATIVE_QUESTION', requestId: `root-${groupFeed}` }, true);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
    const getQuestion = async () => (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events
      ?.find(event => event.messageKind === 'user_question' && event.questionState === 'pending');
    const question = await until(getQuestion);
    assert.equal(question.questionDeadline, null, 'HTTP exposes an ordinary question with no automatic deadline');
    const visibleQuestion = (await request('GET', `/api/sessions/${sessionId}/events?filter=visible`)).json.events
      .find(event => event.questionId === question.questionId);
    assert.equal(visibleQuestion.questionState, 'pending', 'refresh retains the actionable original question');
    assert.equal(visibleQuestion.nativeQuestion.options.length, 2);
    const wrong = await request('POST', messages, { text: '1', requestId: `wrong-${groupFeed}`, nativeQuestionId: 'old-id' });
    assert.equal(wrong.status, 409); assert.equal(wrong.json.code, 'QUESTION_EXPIRED');
    if (groupFeed) assert.equal((await request('POST', messages, { text: 'ordinary-web-message' })).status, 403);
    const payload = { text: '2', requestId: `answer-${groupFeed}`, nativeQuestionId: question.questionId };
    const answered = await request('POST', messages, payload);
    assert.equal(answered.status, 202, JSON.stringify(answered.json));
    await until(async () => (await request('GET', `/api/sessions/${sessionId}/events?filter=all`)).json.events
      ?.find(event => event.questionState === 'answered'));
    const duplicate = await request('POST', messages, payload);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.json.duplicate, true);
    const late = await request('POST', messages, { ...payload, requestId: `late-${groupFeed}` });
    assert.equal(late.status, 409); assert.equal(late.json.code, 'QUESTION_EXPIRED');
  }
  console.log('native question HTTP: Web controls answer ordinary and group Sessions; stale IDs rejected, ordinary group writes remain blocked, retries deduplicate');
} finally {
  const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
  await rm(home, { recursive: true, force: true });
}

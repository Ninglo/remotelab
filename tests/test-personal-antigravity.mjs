import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-personal-antigravity-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_PERSONAL_ANTIGRAVITY = '1';
process.env.SECURE_COOKIES = '0';
process.env.REMOTELAB_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
const config = join(home, '.config/remotelab');
const bin = join(home, 'bin');
await mkdir(bin);
await writeFile(join(bin, 'agy'), "#!/bin/sh\nprintf 'gemini-fixture-high\\tGemini Fixture (High)\\n'\n", { mode: 0o700 });
process.env.PATH = [bin, join(process.execPath, '..'), '/usr/bin', '/bin'].join(':');
const people = ['a', 'b'].map((id, index) => ({
  id, name: id, handle: id, identities: [{ id: 'web-' + id, kind: 'web', realm: 'remotelab', subjectId: id }],
  credentials: [{ id: 'token-' + id, type: 'token', token: String(index + 1).repeat(64) }],
}));
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({
  version: 2, primaryPersonId: 'a', administratorPersonIds: ['a'], people, serviceToken: 'f'.repeat(64),
}));

const server = http.createServer((req, res) => void handleRequest(req, res).catch(error => {
  console.error(error);
  if (!res.headersSent) res.writeHead(500);
  res.end();
}));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.env.CHAT_PORT = String(server.address().port);
const base = 'http://127.0.0.1:' + process.env.CHAT_PORT;
const { handleRequest } = await import('../chat/router.mjs');
const { appendEvents } = await import('../chat/history.mjs');
const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { PROJECT_MEMORY_RUNTIME_FILE } = await import('../chat/project-memory-runtime.mjs');
const cookies = new Map();

async function request(path, method, payload, headers = {}) {
  const result = await fetch(base + path, {
    method, signal: AbortSignal.timeout(12_000), redirect: 'manual',
    headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await result.text();
  return { status: result.status, data: result.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
}
const call = (who, path, method = 'GET', payload) => request(path, method, payload, { Cookie: cookies.get(who) });
const device = (token, path, payload = {}) => request('/api/personal-antigravity/device/' + path, 'POST', payload, token ? { Authorization: 'Bearer ' + token } : {});
const route = '/api/personal-antigravity/';
const tool = 'antigravity-personal';

async function enroll(who) {
  const paired = await call(who, route + 'pair', 'POST', {});
  assert.equal(paired.status, 200, JSON.stringify(paired));
  const { code } = paired.data;
  const redeemed = await device('', 'redeem', { code });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed));
  assert.equal((await device('', 'redeem', { code })).status, 403);
  return redeemed.data.token;
}
async function submit(who, session, text, requestId) {
  return call(who, '/api/sessions/' + session + '/messages', 'POST', { text, tool, requestId });
}
async function completed(who, runId) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const { data } = await call(who, '/api/runs/' + runId);
    if (['completed', 'failed', 'cancelled'].includes(data?.run?.state)) return data.run;
    await delay(100);
  }
  throw new Error('run did not finish');
}

try {
  for (const person of people) {
    const res = await fetch(base + '/login', {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ type: 'token', token: person.credentials[0].token }),
    });
    assert.equal(res.status, 302);
    cookies.set(person.id, res.headers.get('set-cookie').split(';')[0]);
  }
  assert.equal((await call('a', '/api/auth/me')).data.features.personalAntigravityBinding, true);
  assert.equal((await call('a', '/')).data.includes('我的 Antigravity'), true);
  assert.equal((await call('a', route + 'worker')).status, 200);
  assert.match(JSON.stringify((await call('a', '/api/models?tool=' + tool)).data), /gemini-fixture-high/);
  assert.equal((await request(route + 'pair', 'POST', {}, { Authorization: 'Bearer ' + 'f'.repeat(64) })).status, 403);
  const [a, b] = await Promise.all(people.map(async person => {
    const { status, data } = await call(person.id, '/api/sessions', 'POST', { tool, folder: home, name: 'Personal' });
    assert.equal(status, 201, JSON.stringify(data));
    return data.session.id;
  }));
  assert.match((await submit('a', a, 'unbound', 'unbound-request-0001')).data.error, /我的 Antigravity/);
  const previous = await call('a', '/api/sessions', 'POST', { tool: 'codex', folder: home, name: 'Archive fixture' });
  assert.equal(previous.status, 201, JSON.stringify(previous));
  const oldA = previous.data.session.id;
  await appendEvents(oldA, [
    { type: 'message', role: 'user', content: 'orchid-bridge issue' },
    { type: 'message', role: 'assistant', phase: 'final_answer', content: 'orchid-bridge fix confirmed <private>hidden-context</private>' },
    { type: 'message', role: 'assistant', phase: 'commentary', content: 'orchid-bridge provisional content' },
    { type: 'tool_result', output: 'orchid-bridge hidden tool output' },
  ]);
  const oldGemini = (await call('a', '/api/sessions', 'POST', { tool, folder: home, name: 'Gemini fixture' })).data.session.id;
  await appendEvents(oldGemini, [{ type: 'message', role: 'assistant', phase: 'final', content: 'orchid-bridge from Gemini' }]);
  await appendEvents(b, [{ type: 'message', role: 'assistant', content: 'orchid-bridge other-person response' }]);
  await mutateSessionMeta(oldA, meta => {
    meta.workSummary = { summary: 'orchid-bridge migration summary', knownConclusions: ['Verified on both clients'] };
    return true;
  });
  await mutateSessionMeta(b, meta => {
    meta.workSummary = { summary: 'orchid-bridge other-person summary' };
    return true;
  });
  await mkdir(dirname(PROJECT_MEMORY_RUNTIME_FILE), { recursive: true });
  const indexPath = join(home, 'project-index.md');
  const ledgerPath = join(home, 'project-ledger.md');
  await writeFile(indexPath, [
    '| orchid | Orchid | project | — | [memory](projects.md#orchid) |',
    '| private-b | Other person | project | — | [memory](projects.md#other-person) |',
  ].join('\n'));
  await writeFile(ledgerPath, '## Orchid\norchid-bridge approved decision\n## Other person\norchid-bridge other-person project memory');
  await writeFile(PROJECT_MEMORY_RUNTIME_FILE, JSON.stringify({
    schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: false, releaseId: 'fixture',
    indexPath, ledgerPath, workflowPath: join(home, 'project-workflow.md'), groups: [],
    projects: [{ id: 'orchid' }, { id: 'private-b' }],
    sessionBindings: [{ sessionId: oldA, projectIds: ['orchid'] }, { sessionId: b, projectIds: ['private-b'] }],
  }));
  assert.equal((await request(route + 'context?kind=project-memory&q=orchid-bridge', 'GET', undefined,
    { Authorization: 'Bearer ' + 'f'.repeat(64) })).status, 403);
  const reference = (who, kind) => call(who, route + 'context?kind=' + kind + '&q=orchid-bridge');
  assert.deepEqual((await reference('a', 'project-memory')).data.references.map(r => r.excerpt), ['orchid-bridge approved decision']);
  assert.deepEqual((await reference('b', 'project-memory')).data.references.map(r => r.excerpt), ['orchid-bridge other-person project memory']);
  assert.deepEqual((await reference('a', 'work-summary')).data.references.map(r => r.excerpt), ['orchid-bridge migration summary\nVerified on both clients']);
  assert.deepEqual((await reference('b', 'work-summary')).data.references.map(r => r.excerpt), ['orchid-bridge other-person summary']);
  const historyRoute = '/api/sessions/search?scope=personal-context&q=orchid-bridge';
  assert.equal((await request(historyRoute, 'GET', undefined, { Authorization: 'Bearer ' + 'f'.repeat(64) })).status, 403);
  const hitsA = await call('a', historyRoute);
  const hitsB = await call('b', historyRoute);
  assert.equal(hitsA.status, 200);
  assert.equal(hitsB.status, 200);
  assert.deepEqual(new Set(hitsA.data.sessions.map(session => session.id)), new Set([oldA, oldGemini]));
  assert.deepEqual(hitsA.data.sessions.find(session => session.id === oldGemini).matches.map(match => match.excerpt), ['orchid-bridge from Gemini']);
  assert.deepEqual(hitsB.data.sessions.map(session => session.id), [b]);
  const previousSource = hitsA.data.sessions.find(session => session.id === oldA);
  const matches = previousSource.matches;
  assert.deepEqual(matches.map(match => match.excerpt).sort(), ['orchid-bridge fix confirmed', 'orchid-bridge issue']);
  const source = matches.find(match => match.role === 'assistant');
  assert.equal(source.seq, 2);
  assert.equal((await call('b', source.eventPath)).status, 403);
  let question = '用历史片段回答\n' + source.excerpt + '\n' + previousSource.sessionUrl;
  if (process.env.REMOTELAB_TEST_PLAYWRIGHT_MODULE) {
    const { chromium } = await import(process.env.REMOTELAB_TEST_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ executablePath: process.env.REMOTELAB_TEST_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(7000);
      const [name, value] = cookies.get('a').split('=');
      await page.context().addCookies([{ name, value, url: base }]);
      await page.goto(base + '/?session=' + a + '&tab=sessions');
      const picker = page.locator('#inlineToolSelect');
      if (await page.locator('#customModeBtn').isVisible()) await page.locator('#customModeBtn').click();
      await picker.selectOption(tool);
      await page.locator('#msgInput').fill('请根据以前的回复说明修了什么');
      await page.locator('#personalAntigravityHistoryButton').click();
      await page.locator('#indexHistoryQuery').fill('orchid-bridge');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      const result = page.locator('#indexHistoryResults article').filter({ hasText: source.excerpt });
      await result.waitFor();
      assert.equal(await page.locator('#indexHistoryResults').getByText('orchid-bridge other-person response').count(), 0);
      assert.match(await result.getByRole('link').getAttribute('href'), new RegExp(oldA));
      await result.getByRole('button', { name: '加入草稿' }).click();
      for (const [kind, expectedText] of [['project-memory', 'orchid-bridge approved decision'], ['work-summary', 'orchid-bridge migration summary']]) {
        await page.locator('#personalAntigravityHistoryButton').click();
        await page.locator('#indexHistoryKind').selectOption(kind);
        await page.locator('#indexHistoryQuery').fill('orchid-bridge');
        await page.getByRole('button', { name: '搜索', exact: true }).click();
        const card = page.locator('#indexHistoryResults article').filter({ hasText: expectedText });
        await card.getByRole('button', { name: '加入草稿' }).click();
      }
      question = await page.locator('#msgInput').inputValue();
      assert.match(question, /请根据以前的回复说明修了什么/);
      assert.match(question, /orchid-bridge fix confirmed/);
      assert.match(question, /orchid-bridge approved decision/);
      assert.match(question, /orchid-bridge migration summary/);
      assert.match(question, new RegExp(oldA));
      assert.doesNotMatch(question, /hidden-context|other-person response/);
      assert.equal((await call('a', '/api/sessions/' + a + '/events')).data.latestSeq || 0, 0, 'adding an excerpt does not send');
      console.log('Browser: search, preview, source link and insert into draft passed.');
    } finally { await browser.close(); }
  }
  const [tokenA, tokenB] = await Promise.all([enroll('a'), enroll('b')]);
  assert.equal((await submit('b', a, 'send as A', 'impersonation-0001')).status, 403);
  const [acceptA, acceptB] = await Promise.all([
    submit('a', a, question, 'personal-request-0001'),
    submit('b', b, 'text for B', 'personal-request-0002'),
  ]);
  assert.equal(acceptA.status, 202, JSON.stringify(acceptA));
  assert.equal(acceptB.status, 202, JSON.stringify(acceptB));
  const [jobA, jobB] = await Promise.all([device(tokenA, 'next'), device(tokenB, 'next')]);
  assert.equal(jobA.data.job?.prompt, question, JSON.stringify(jobA));
  assert.equal(jobB.data.job?.prompt, 'text for B', JSON.stringify(jobB));
  assert.equal((await device(tokenA, 'result', { id: jobB.data.job.id, response: 'forged' })).status, 404);
  assert.equal((await device(tokenA, 'result', { id: jobA.data.job.id, response: 'not started' })).status, 400);
  for (const [token, job, answer] of [[tokenA, jobA.data.job, 'reply from A'], [tokenB, jobB.data.job, 'reply from B']]) {
    assert.equal((await device(token, 'start', { id: job.id })).status, 200);
    assert.equal((await device(token, 'start', { id: job.id })).status, 404);
    assert.equal((await device(token, 'result', { id: job.id, response: answer })).status, 200);
    assert.equal((await device(token, 'result', { id: job.id, response: answer })).status, 404);
  }
  const [runA, runB] = await Promise.all([completed('a', acceptA.data.runId || acceptA.data.run.id),
    completed('b', acceptB.data.runId || acceptB.data.run.id)]);
  assert.equal(runA.state, 'completed', JSON.stringify(runA));
  assert.equal(runB.state, 'completed', JSON.stringify(runB));
  const [eventsA, eventsB] = await Promise.all([call('a', '/api/sessions/' + a + '/events'), call('b', '/api/sessions/' + b + '/events')]);
  assert.match(JSON.stringify(eventsA.data), /reply from A/);
  assert.match(JSON.stringify(eventsB.data), /reply from B/);
  assert.doesNotMatch(JSON.stringify(eventsA.data), /reply from B/);
  const stopped = await submit('a', a, 'stop during local execution', 'personal-request-stop-01');
  assert.equal(stopped.status, 202, JSON.stringify(stopped));
  const stoppedJob = (await device(tokenA, 'next')).data.job;
  assert.equal((await device(tokenA, 'start', { id: stoppedJob.id })).status, 200);
  const interruption = device(tokenA, 'watch', { id: stoppedJob.id });
  assert.equal((await call('a', '/api/runs/' + stopped.data.run.id + '/cancel', 'POST', {})).status, 200);
  assert.deepEqual((await interruption).data, { active: false });
  assert.equal((await device(tokenA, 'result', { id: stoppedJob.id, response: 'late response' })).status, 404);
  assert.equal((await completed('a', stopped.data.run.id)).state, 'cancelled');
  assert.equal((await call('a', route + 'disconnect', 'POST', {})).status, 200);
  assert.equal((await device(tokenA, 'next')).status, 403);
  assert.equal((await call('b', route + 'status')).data.connected, true);
  console.log('Personal Antigravity: private history citations, device routing, cancellation and account isolation passed.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
process.exit(0);

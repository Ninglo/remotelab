import assert from 'node:assert/strict';
import { scrypt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-langsmith-login-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
const sessionId = 'a'.repeat(32);
const projectId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const traceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const childId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const rootUrl = `https://smith.langchain.com/o/workspace/projects/p/${projectId}/r/${traceId}?trace_id=${traceId}&start_time=2026-09-26T05:19:48.685000`;
const entry = `/api/sessions/${sessionId}/langsmith?runId=run_demo`;
const username = 'fixture-reader', password = 'fixture-login-password';
let child;
let logs = '';
try {
  await mkdir(join(config, 'langsmith-live'), { recursive: true });
  const salt = Buffer.from('test-login-salt');
  const hash = await promisify(scrypt)(password, salt, 32, { N: 16384, r: 8, p: 1 });
  await writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64), username,
    passwordHash: `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}` }));
  await writeFile(join(config, 'chat-sessions.json'), JSON.stringify([{ id: sessionId, name: 'Login fixture', tool: 'codex', archived: true }]));
  await writeFile(join(config, 'langsmith-case-link.json'), JSON.stringify({ enabled: true, projectId, stateDir: 'langsmith-live' }));
  await writeFile(join(config, 'langsmith-live/state.json'), JSON.stringify({ projectId, tracked: { [sessionId]: {
    latestSnapshot: { rootUrl, traceId, revision: 1, runNodeIds: { run_demo: childId } },
  } } }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['chat-server.mjs'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, CHAT_PORT: String(port), SECURE_COOKIES: '0', REMOTELAB_PUBLIC_BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Startup timeout: ${logs.slice(-2000)}`)), 20000);
    const onData = data => { if (logs.includes('Chat server listening on')) finish(); };
    const onExit = code => finish(new Error(`Server exited ${code}: ${logs.slice(-2000)}`));
    const finish = error => {
      clearTimeout(timer);
      child.stdout.off('data', onData); child.off('exit', onExit);
      error ? reject(error) : resolve();
    };
    child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', finish);
  });
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
  const anonymous = await request(entry);
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');
  const loginPath = anonymous.headers.get('location');
  const loginParams = new URL(loginPath, base).searchParams;
  assert.equal(loginParams.get('mode'), 'pw');
  assert.equal(loginParams.get('next'), entry, 'keep the exact trace/run destination');
  const loginPage = await request(loginPath);
  assert.equal(loginPage.status, 200);
  const html = await loginPage.text();
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.ok(html.includes(`name="next" value="${entry}"`));
  assert.ok(html.includes("var usePw = 'pw' === 'pw'"));
  assert.equal((await request('/api/sessions')).status, 401, 'other APIs retain JSON authentication errors');
  assert.equal((await request(entry, { method: 'POST' })).status, 401);
  const login = (secret, next = entry) => request('/login', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ type: 'password', username, password: secret, next }) });
  const failed = await login('wrong');
  assert.equal(new URL(failed.headers.get('location'), base).searchParams.get('next'), entry);
  assert.equal(new URL(failed.headers.get('location'), base).searchParams.get('error'), '1');
  assert.equal(failed.headers.get('set-cookie'), null);
  const signedIn = await login(password);
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.get('location'), entry);
  const cookie = signedIn.headers.get('set-cookie').split(';')[0];
  const destination = await request(entry, { headers: { Cookie: cookie } });
  assert.equal(destination.status, 302);
  assert.equal(destination.headers.get('location'), rootUrl.replace(`/r/${traceId}`, `/r/${childId}`));
  const rootDestination = await request(`/api/sessions/${sessionId}/langsmith`, { headers: { Cookie: cookie } });
  assert.equal(rootDestination.headers.get('location'), rootUrl, 'a Session entry selects its root, not the project');
  const statusResponse = await request(`/api/sessions/${sessionId}/langsmith?format=json`, { headers: { Cookie: cookie } });
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get('cache-control'), 'private, no-store');
  const status = await statusResponse.json();
  assert.equal(status.status, 'available');
  assert.equal(status.langsmithUrl, rootUrl);
  assert.equal(status.langsmithEntryUrl, base + `/api/sessions/${sessionId}/langsmith`);
  assert.equal(status.sessionUrl, base + `/?session=${sessionId}&tab=sessions`);
  assert.equal((await request(`/api/sessions/${sessionId}/langsmith?format=json`)).status, 302,
    'unauthenticated status requests still require login');
  const search = await request('/api/sessions/search?q=Login', { headers: { Cookie: cookie } });
  const result = await search.json();
  assert.equal(result.sessions[0].langsmithEntryUrl, base + `/api/sessions/${sessionId}/langsmith`);
  assert.equal(result.sessions[0].langsmithUrl, rootUrl, 'keep the provider URL for API clients');
  const hostileNext = await login(password, '//evil.example');
  assert.equal(hostileNext.headers.get('location'), '/', 'login must not accept an external next destination');
  const { buildLangSmithCaseNavigationHref } = await import('../lib/session-navigation.mjs');
  assert.equal(buildLangSmithCaseNavigationHref(sessionId, { publicBaseUrl: 'https://remote.test/prefix/' }),
    `https://remote.test/prefix/api/sessions/${sessionId}/langsmith`);
  assert.equal(buildLangSmithCaseNavigationHref('../outside'), '');
  assert.equal(buildLangSmithCaseNavigationHref(sessionId, { publicBaseUrl: '', requireAbsolute: true }), '');
  console.log('test-langsmith-login-flow: ok');
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  await rm(home, { recursive: true, force: true });
}

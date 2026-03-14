#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-owner-session';

function randomPort() {
  return 39000 + Math.floor(Math.random() * 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function resolveEventContent(port, sessionId, event, extraHeaders = {}) {
  if (typeof event?.content === 'string' && event.content) return event.content;
  if (!event?.bodyAvailable || !Number.isInteger(event?.seq)) return '';
  const bodyResponse = await request(port, 'GET', `/api/sessions/${sessionId}/events/${event.seq}/body`, null, extraHeaders);
  assert.equal(bodyResponse.status, 200, 'event body should load when advertised');
  return bodyResponse.json?.body?.value || '';
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-builtin-template-apps-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-owner-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'boot ok' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 50);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me', null, { Cookie: ownerCookie });
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const createAppSession = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      appId: 'app_create_app',
      sourceId: 'chat',
      sourceName: 'Chat',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(createAppSession.status, 201, 'owner should be able to create a session from the built-in Create App template');
    assert.equal(createAppSession.json?.session?.appId, 'app_create_app');
    assert.equal(createAppSession.json?.session?.appName, 'Create App');

    const ownerEvents = await request(port, 'GET', `/api/sessions/${createAppSession.json.session.id}/events`, null, {
      Cookie: ownerCookie,
    });
    assert.equal(ownerEvents.status, 200, 'built-in Create App session events should load');
    const welcomeEvent = (ownerEvents.json.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
    assert.ok(welcomeEvent, 'built-in Create App session should get a starter welcome message');
    const welcomeContent = await resolveEventContent(
      port,
      createAppSession.json.session.id,
      welcomeEvent,
      { Cookie: ownerCookie },
    );
    assert.match(welcomeContent, /创建什么 App|app specification/i);

    const appsResponse = await request(port, 'GET', '/api/apps', null, {
      Cookie: ownerCookie,
    });
    assert.equal(appsResponse.status, 200, 'owner should be able to load the apps catalog');
    const videoCutApp = (appsResponse.json?.apps || []).find((app) => app.id === 'app_video_cut');
    assert.ok(videoCutApp?.shareToken, 'built-in Video Cut app should expose a share token');

    const publicVisit = await request(port, 'GET', `/app/${videoCutApp.shareToken}`);
    assert.equal(publicVisit.status, 302, 'built-in Video Cut app share link should bootstrap a visitor session');
    assert.equal(publicVisit.headers.location, '/?visitor=1');
    assert.ok(publicVisit.headers['set-cookie']?.length, 'built-in Video Cut app visit should set a visitor cookie');

    const visitorCookie = publicVisit.headers['set-cookie'][0].split(';', 1)[0];
    const visitorAuth = await request(port, 'GET', '/api/auth/me', null, {
      Cookie: visitorCookie,
    });
    assert.equal(visitorAuth.status, 200, 'visitor auth session should be usable after built-in app bootstrap');
    assert.equal(visitorAuth.json?.role, 'visitor');
    assert.equal(visitorAuth.json?.appId, 'app_video_cut');

    const ownerAllUsers = await request(port, 'GET', '/api/sessions?includeVisitor=1&appId=app_video_cut', null, {
      Cookie: ownerCookie,
    });
    assert.equal(ownerAllUsers.status, 200, 'owner should be able to list built-in Video Cut visitor sessions');
    assert.equal(
      (ownerAllUsers.json?.sessions || []).some((session) => session.visitorId && session.appId === 'app_video_cut'),
      true,
      'built-in Video Cut visitor session should appear in owner all-users view',
    );

    console.log('test-http-builtin-template-apps: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

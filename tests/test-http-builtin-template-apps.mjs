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

function findCookie(headers, name) {
  return (headers['set-cookie'] || []).find((cookie) => cookie.startsWith(`${name}=`)) || '';
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
    assert.match(welcomeContent, /SOP \/ 工作流|创建什么 App|app specification/i);

    const videoCutAppCreate = await request(port, 'POST', '/api/apps', {
      name: 'Video Cut Review',
      systemPrompt: 'Use the local video-cut workflow under ~/code/video-cut and do a kept-content review before render.',
      welcomeMessage: '请上传一段原始视频，并说明你要保留什么。',
      tool: 'fake-codex',
      skills: [],
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(videoCutAppCreate.status, 201, 'owner should be able to create a regular Video Cut app');
    const videoCutAppId = videoCutAppCreate.json?.app?.id;
    const videoCutShareToken = videoCutAppCreate.json?.app?.shareToken;
    assert.ok(videoCutAppId, 'custom Video Cut app should return an id');
    assert.ok(videoCutShareToken, 'custom Video Cut app should return a share token');

    const videoCutOwnerSession = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      appId: videoCutAppId,
      sourceId: 'chat',
      sourceName: 'Chat',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(videoCutOwnerSession.status, 201, 'owner should be able to create a session from a regular Video Cut app');
    assert.equal(videoCutOwnerSession.json?.session?.appId, videoCutAppId);
    assert.match(
      videoCutOwnerSession.json?.session?.systemPrompt || '',
      /Video Cut Review|video-cut workflow|~\/code\/video-cut/i,
      'custom Video Cut sessions should include explicit local workflow guidance',
    );

    const appsResponse = await request(port, 'GET', '/api/apps', null, {
      Cookie: ownerCookie,
    });
    assert.equal(appsResponse.status, 200, 'owner should be able to load the apps catalog');
    const basicChatApp = (appsResponse.json?.apps || []).find((app) => app.id === 'app_basic_chat');
    assert.equal(basicChatApp?.shareEnabled, false, 'Basic Chat should stay internal-only');
    assert.equal(typeof basicChatApp?.shareToken, 'undefined', 'Basic Chat should not expose a public share token');
    const createAppStarter = (appsResponse.json?.apps || []).find((app) => app.id === 'app_create_app');
    assert.equal(createAppStarter?.shareEnabled, false, 'Create App should stay internal-only');
    assert.equal(typeof createAppStarter?.shareToken, 'undefined', 'Create App should not expose a public share token');
    const videoCutApp = (appsResponse.json?.apps || []).find((app) => app.id === videoCutAppId);
    assert.equal(videoCutApp?.shareToken, videoCutShareToken, 'custom Video Cut app should expose a share token');

    const publicVisit = await request(port, 'GET', `/app/${videoCutShareToken}`);
    assert.equal(publicVisit.status, 302, 'custom Video Cut app share link should bootstrap a visitor session');
    assert.equal(publicVisit.headers.location, '/?visitor=1');
    assert.ok(publicVisit.headers['set-cookie']?.length, 'custom Video Cut app visit should set a visitor cookie');

    const visitorCookie = findCookie(publicVisit.headers, 'visitor_session_token').split(';', 1)[0];
    const visitorBrowserCookie = findCookie(publicVisit.headers, 'visitor_browser_id').split(';', 1)[0];
    assert.ok(visitorCookie, 'custom Video Cut app visit should set a visitor auth session cookie');
    assert.ok(visitorBrowserCookie, 'custom Video Cut app visit should set a stable browser identity cookie');

    const visitorAuth = await request(port, 'GET', '/api/auth/me', null, {
      Cookie: visitorCookie,
    });
    assert.equal(visitorAuth.status, 200, 'visitor auth session should be usable after custom app bootstrap');
    assert.equal(visitorAuth.json?.role, 'visitor');
    assert.equal(visitorAuth.json?.appId, videoCutAppId);
    const firstVisitorId = visitorAuth.json?.visitorId;
    const firstVisitorSessionId = visitorAuth.json?.sessionId;

    const repeatVisit = await request(port, 'GET', `/app/${videoCutShareToken}`, null, {
      Cookie: visitorBrowserCookie,
    });
    assert.equal(repeatVisit.status, 302, 'reopening the same app link in the same browser should still redirect into visitor mode');
    const repeatVisitorCookie = findCookie(repeatVisit.headers, 'visitor_session_token').split(';', 1)[0];
    const repeatVisitorAuth = await request(port, 'GET', '/api/auth/me', null, {
      Cookie: repeatVisitorCookie,
    });
    assert.equal(repeatVisitorAuth.status, 200, 'repeat app visits in the same browser should still authenticate');
    assert.equal(repeatVisitorAuth.json?.visitorId, firstVisitorId, 'the same browser should keep the same visitor identity for one app link');
    assert.equal(repeatVisitorAuth.json?.sessionId, firstVisitorSessionId, 'the same browser should reuse the existing visitor session for one app link');

    const secondBrowserVisit = await request(port, 'GET', `/app/${videoCutShareToken}`);
    assert.equal(secondBrowserVisit.status, 302, 'opening the same app link from another browser should still bootstrap visitor mode');
    const secondBrowserVisitorCookie = findCookie(secondBrowserVisit.headers, 'visitor_session_token').split(';', 1)[0];
    const secondBrowserAuth = await request(port, 'GET', '/api/auth/me', null, {
      Cookie: secondBrowserVisitorCookie,
    });
    assert.equal(secondBrowserAuth.status, 200, 'another browser should also authenticate successfully');
    assert.notEqual(secondBrowserAuth.json?.visitorId, firstVisitorId, 'different browsers should map to different visitor identities for one app link');
    assert.notEqual(secondBrowserAuth.json?.sessionId, firstVisitorSessionId, 'different browsers should get different visitor sessions for one app link');

    const ownerAllUsers = await request(port, 'GET', `/api/sessions?includeVisitor=1&appId=${videoCutAppId}`, null, {
      Cookie: ownerCookie,
    });
    assert.equal(ownerAllUsers.status, 200, 'owner should be able to list custom Video Cut visitor sessions');
    const visitorSessions = (ownerAllUsers.json?.sessions || []).filter((session) => session.visitorId && session.appId === videoCutAppId);
    assert.equal(visitorSessions.length, 2, 'reopening the same app link in one browser should not create extra visitor sessions');
    assert.equal(
      visitorSessions.filter((session) => session.visitorId === firstVisitorId).length,
      1,
      'one browser should map to exactly one visitor session inside an app share flow',
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

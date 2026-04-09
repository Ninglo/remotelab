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
  return 42000 + Math.floor(Math.random() * 3000);
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

function setupTempHome({ preseedArchivedBasicChat = false, cloudflaredPort = 0, publicHostname = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-owner-welcome-'));
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
        id: 'micro-agent',
        name: 'Micro Agent',
        visibility: 'private',
        toolProfile: 'micro-agent',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: { kind: 'none', label: 'Thinking' },
      },
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Thinking', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(join(localBin, 'fake-codex'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  chmodSync(join(localBin, 'fake-codex'), 0o755);

  if (preseedArchivedBasicChat) {
    writeFileSync(
      join(configDir, 'chat-sessions.json'),
      JSON.stringify([
        {
          id: 'legacy_archived_basic_chat',
          folder: '/Users/jiujianian',
          tool: 'fake-codex',
          name: 'new session',
          autoRenamePending: true,
          created: '2026-03-26T00:40:58.504Z',
          updatedAt: '2026-03-26T00:45:04.507Z',
          sourceId: 'chat',
          sourceName: 'Chat',
          archived: true,
          archivedAt: '2026-03-26T00:43:08.829Z',
        },
      ], null, 2),
      'utf8',
    );
  }

  if (publicHostname && Number.isInteger(cloudflaredPort) && cloudflaredPort > 0) {
    const cloudflaredDir = join(home, '.cloudflared');
    mkdirSync(cloudflaredDir, { recursive: true });
    writeFileSync(
      join(cloudflaredDir, 'config.yml'),
      `tunnel: owner-test\n\ningress:\n  - hostname: ${publicHostname}\n    service: http://127.0.0.1:${cloudflaredPort}\n  - service: http_status:404\n`,
      'utf8',
    );
  }

  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_BRIDGE_BASE_URL: '',
      REMOTELAB_PUBLIC_BASE_URL: '',
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

async function restoreStarterSessions(port) {
  const response = await request(port, 'POST', '/api/bootstrap/owner-sessions/restore', {}, { Cookie: ownerCookie });
  assert.equal(response.status, 200, 'restore starter sessions action should succeed');
  assert.equal(response.json?.ok, true, 'restore starter sessions action should return ok');
  assert.equal(typeof response.json?.welcomeSessionId, 'string', 'restore starter sessions should return a welcome session id');
  return response.json;
}

async function assertSessionListEmpty(port, { archivedCount = 0 } = {}) {
  const list = await request(port, 'GET', '/api/sessions', null, { Cookie: ownerCookie });
  assert.equal(list.status, 200, 'owner session list should load');
  assert.equal(list.json?.archivedCount, archivedCount, 'archived count should be preserved');
  assert.equal(
    (list.json?.sessions || []).length,
    0,
    'owner session list should stay empty until an explicit bootstrap runs',
  );
}

async function assertWelcomeBootstrapped(port, { archivedCount = 0 } = {}) {
  const expectedSessionNames = [
    'Welcome',
    '[示例] 上传一份表格，我把清洗后的文件回给你',
    '[示例] 汇总最近行业热点，并把摘要发到指定邮箱',
    '[示例] 发一封邮件到这个实例，会自动开一个新会话',
    '[引导] 订阅日历，接收 AI 创建的日程事件',
    '[引导] 安装快捷指令，用 Siri 或一键启动 RemoteLab',
  ];
  const list = await waitFor(async () => {
    const response = await request(port, 'GET', '/api/sessions', null, { Cookie: ownerCookie });
    return (response.json?.sessions || []).length === expectedSessionNames.length ? response : false;
  }, 'owner bootstrap sessions');
  assert.equal(list.status, 200, 'owner session list should load');
  assert.equal(list.json?.archivedCount, archivedCount, 'archived count should be preserved');
  assert.equal(
    (list.json?.sessions || []).length,
    expectedSessionNames.length,
    'starter owner session set should include the expected bootstrap sessions',
  );

  const sessionNames = (list.json?.sessions || []).map((session) => session.name);
  assert.deepEqual(sessionNames, expectedSessionNames, 'starter sessions should appear in the intended sidebar order');

  for (const [index, session] of (list.json?.sessions || []).entries()) {
    assert.equal(session.pinned, true, 'starter sessions should be pinned for discoverability');
    assert.equal(session.sidebarOrder, index + 1, 'starter sessions should keep a stable sidebar order');
    assert.equal(session.entryMode, 'read', 'starter sessions should open in read mode');
  }

  const welcomeSession = list.json?.sessions?.[0];
  assert.ok(welcomeSession?.id, 'welcome session should have an id');
  assert.equal(welcomeSession.templateId, undefined, 'welcome session should be a plain starter session without app/template coupling');
  assert.equal(welcomeSession.tool, 'micro-agent', 'welcome bootstrap should prefer Micro Agent when it is available');
  assert.equal(welcomeSession.sourceId, 'chat', 'welcome session should be categorized as chat UI');
  assert.equal(welcomeSession.sourceName, 'Chat', 'welcome session should preserve the chat source label');
  assert.ok(Number(welcomeSession.messageCount || 0) >= 1, 'welcome session should include the starter assistant message');

  const events = await request(port, 'GET', `/api/sessions/${welcomeSession.id}/events`, null, { Cookie: ownerCookie });
  assert.equal(events.status, 200, 'welcome session events should load');
  const welcomeEvent = (events.json?.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
  assert.ok(welcomeEvent, 'welcome session should include an assistant onboarding message');
  const welcomeContent = await resolveEventContent(port, welcomeSession.id, welcomeEvent, { Cookie: ownerCookie });
  assert.match(welcomeContent, /我是 Rowan|先接手、再梳理、再推进执行/u, 'welcome copy should come from the built-in Welcome app');
  assert.match(welcomeContent, /cpolar|国内可以直接访问|不用梯子/u, 'welcome copy should mention cpolar for mainland-friendly access');
  assert.match(welcomeContent, /左侧我已经先放了 3 个真实跑通过的示例会话/u, 'welcome copy should point owners to the verified showcase sessions');
  const welcomeAssistantMessages = await Promise.all(
    (events.json?.events || [])
      .filter((event) => event.type === 'message' && event.role === 'assistant')
      .map((event) => resolveEventContent(port, welcomeSession.id, event, { Cookie: ownerCookie })),
  );
  assert.ok(
    welcomeAssistantMessages.some((content) => /发件邮箱|允许发件人|安全机制/u.test(content)),
    'welcome bootstrap should warn that inbound email tests need the sender address allowlisted first',
  );
  assert.ok(
    welcomeAssistantMessages.some((content) => /3 个真实跑通过的示例会话|发邮件进实例自动开新会话/u.test(content)),
    'welcome bootstrap should mention the three pinned examples when backfilled',
  );

  const fileShowcaseSession = list.json?.sessions?.[1];
  const fileShowcaseEvents = await request(port, 'GET', `/api/sessions/${fileShowcaseSession.id}/events?filter=all`, null, { Cookie: ownerCookie });
  assert.equal(fileShowcaseEvents.status, 200, 'file showcase session events should load');
  const fileShowcaseMessages = (fileShowcaseEvents.json?.events || []).filter((event) => event.type === 'message');
  assert.ok(fileShowcaseMessages.some((event) => event.role === 'user'), 'file showcase should include a sample user ask');
  assert.ok(fileShowcaseMessages.some((event) => event.role === 'assistant'), 'file showcase should include a sample assistant reply');
  const fileUserMessage = fileShowcaseMessages.find((event) => event.role === 'user');
  const fileAssistantMessage = [...fileShowcaseMessages].reverse().find((event) => event.role === 'assistant' && Array.isArray(event.attachments) && event.attachments.length > 0);
  assert.equal(fileUserMessage?.attachments?.length, 1, 'file showcase should include a sample uploaded file');
  assert.equal(fileAssistantMessage?.attachments?.length, 2, 'file showcase should include downloadable result files');
  const fileShowcaseContent = await resolveEventContent(port, fileShowcaseSession.id, fileAssistantMessage, { Cookie: ownerCookie });
  assert.match(fileShowcaseContent, /直接下载|结果文件/u, 'file showcase should end with a concrete downloadable deliverable');
  const fileDownloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${fileAssistantMessage.attachments[0].assetId}/download`, {
    method: 'GET',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(fileDownloadRes.status, 200, 'file showcase result attachment should be downloadable');
  const downloadedBuffer = Buffer.from(await fileDownloadRes.arrayBuffer());
  assert.equal(downloadedBuffer.subarray(0, 2).toString('hex'), '504b', 'downloaded showcase spreadsheet should keep its xlsx zip signature');

  const digestShowcaseSession = list.json?.sessions?.[2];
  const digestShowcaseEvents = await request(port, 'GET', `/api/sessions/${digestShowcaseSession.id}/events?filter=all`, null, { Cookie: ownerCookie });
  assert.equal(digestShowcaseEvents.status, 200, 'digest showcase session events should load');
  const digestShowcaseMessages = (digestShowcaseEvents.json?.events || []).filter((event) => event.type === 'message');
  assert.equal(digestShowcaseMessages.length, 3, 'digest showcase should keep the expected three-message transcript');
  const digestIntroContent = await resolveEventContent(port, digestShowcaseSession.id, digestShowcaseMessages[0], { Cookie: ownerCookie });
  const digestUserContent = await resolveEventContent(port, digestShowcaseSession.id, digestShowcaseMessages[1], { Cookie: ownerCookie });
  const digestAssistantMessage = [...digestShowcaseMessages].reverse().find((event) => event.role === 'assistant' && Array.isArray(event.attachments) && event.attachments.length > 0);
  assert.match(digestIntroContent, /真实交付链路|指定邮箱/u, 'digest showcase should explain the combined summary-and-delivery flow');
  assert.match(digestUserContent, /每天早上 8 点|行业热点/u, 'digest showcase should demonstrate a recurring summary ask');
  assert.equal(digestAssistantMessage?.attachments?.length, 1, 'digest showcase should attach the delivered summary body');
  const digestShowcaseContent = await resolveEventContent(port, digestShowcaseSession.id, digestAssistantMessage, { Cookie: ownerCookie });
  assert.match(digestShowcaseContent, /实际跑通过|固化成每天自动发/u, 'digest showcase should end with a concrete delivery handoff');
  const digestDownloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${digestAssistantMessage.attachments[0].assetId}/download`, {
    method: 'GET',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(digestDownloadRes.status, 200, 'digest showcase attachment should be downloadable');
  const digestBody = await digestDownloadRes.text();
  assert.match(digestBody, /今日最重要结论|Claude Code|Codex/u, 'digest showcase attachment should contain a readable summary body');

  const emailShowcaseSession = list.json?.sessions?.[3];
  const emailShowcaseEvents = await request(port, 'GET', `/api/sessions/${emailShowcaseSession.id}/events?filter=all`, null, { Cookie: ownerCookie });
  assert.equal(emailShowcaseEvents.status, 200, 'email showcase session events should load');
  const emailShowcaseMessages = (emailShowcaseEvents.json?.events || []).filter((event) => event.type === 'message');
  assert.equal(emailShowcaseMessages.length, 3, 'email showcase should keep the expected three-message transcript');
  const emailIntroContent = await resolveEventContent(port, emailShowcaseSession.id, emailShowcaseMessages[0], { Cookie: ownerCookie });
  const emailUserContent = await resolveEventContent(port, emailShowcaseSession.id, emailShowcaseMessages[1], { Cookie: ownerCookie });
  const emailAssistantContent = await resolveEventContent(port, emailShowcaseSession.id, emailShowcaseMessages[2], { Cookie: ownerCookie });
  assert.match(emailIntroContent, /收件地址|允许发件人|自动多出一个新会话/u, 'email showcase should explain the inbound-email entry flow');
  assert.match(emailUserContent, /Inbound email\.|真实能力验证邮件|自动进到一个新会话/u, 'email showcase should demonstrate the inbound email transcript shape');
  assert.match(emailAssistantContent, /邮件进来后的实际起点|手动新建聊天/u, 'email showcase should end with the actual session handoff explanation');

  const calendarGuideSession = list.json?.sessions?.[4];
  assert.ok(calendarGuideSession?.id, 'calendar guide session should always exist when the calendar feed is enabled');

  const calendarGuideEvents = await request(port, 'GET', `/api/sessions/${calendarGuideSession.id}/events?filter=all`, null, { Cookie: ownerCookie });
  assert.equal(calendarGuideEvents.status, 200, 'calendar guide session events should load');
  const calendarGuideMessage = (calendarGuideEvents.json?.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
  assert.ok(calendarGuideMessage, 'calendar guide session should include an assistant message');
  const calendarGuideContent = await resolveEventContent(port, calendarGuideSession.id, calendarGuideMessage, { Cookie: ownerCookie });

  assert.match(
    calendarGuideContent,
    /\[点击订阅日历\]\(\/subscribe\/calendar\)/,
    'calendar guide should link to the stable subscription helper route',
  );
  assert.match(
    calendarGuideContent,
    /\[使用 HTTPS 订阅\]\(\/subscribe\/calendar\?format=https\)/,
    'calendar guide should expose the manual helper route instead of a baked absolute URL',
  );
  assert.doesNotMatch(
    calendarGuideContent,
    /127\.0\.0\.1|localhost|owner\.example\.com/,
    'calendar guide should avoid persisting host-specific absolute URLs',
  );

  const secondList = await request(port, 'GET', '/api/sessions', null, { Cookie: ownerCookie });
  assert.equal(secondList.status, 200, 'owner should be able to reload the session list');
  assert.equal(
    (secondList.json?.sessions || []).length,
    expectedSessionNames.length,
    'reloading should keep the explicit starter session set stable',
  );
  assert.equal(secondList.json?.sessions?.[0]?.id, welcomeSession.id, 'starter bootstrap should be idempotent for welcome');

  return {
    welcomeSessionId: welcomeSession.id,
    sessions: list.json?.sessions || [],
  };
}

async function runScenario(options) {
  const port = randomPort();
  const { home } = setupTempHome({
    ...options,
    cloudflaredPort: port,
  });
  let server = await startServer({ home, port });
  try {
    const initialArchivedCount = options?.preseedArchivedBasicChat ? 1 : 0;

    await assertSessionListEmpty(port, {
      archivedCount: initialArchivedCount,
    });

    const firstRestore = await restoreStarterSessions(port);
    const firstSeed = await assertWelcomeBootstrapped(port, {
      archivedCount: initialArchivedCount,
    });
    assert.equal(firstRestore.welcomeSessionId, firstSeed.welcomeSessionId, 'explicit restore should surface the active welcome session');

    const secondRestore = await restoreStarterSessions(port);
    const secondSeed = await assertWelcomeBootstrapped(port, {
      archivedCount: initialArchivedCount,
    });
    assert.equal(
      secondSeed.welcomeSessionId,
      firstSeed.welcomeSessionId,
      'explicit bootstrap reruns should update in place instead of duplicating active starter sessions',
    );
    assert.equal(
      secondRestore.welcomeSessionId,
      firstSeed.welcomeSessionId,
      'repeat restore should keep pointing at the existing active welcome session',
    );

    for (const session of secondSeed.sessions) {
      const archive = await request(port, 'PATCH', `/api/sessions/${session.id}`, { archived: true }, { Cookie: ownerCookie });
      assert.equal(archive.status, 200, `starter session ${session.name} should archive cleanly`);
    }

    await assertSessionListEmpty(port, {
      archivedCount: initialArchivedCount + secondSeed.sessions.length,
    });
    await assertSessionListEmpty(port, {
      archivedCount: initialArchivedCount + secondSeed.sessions.length,
    });

    const restoredAfterClear = await restoreStarterSessions(port);
    const thirdSeed = await assertWelcomeBootstrapped(port, {
      archivedCount: initialArchivedCount + secondSeed.sessions.length,
    });
    assert.notEqual(
      restoredAfterClear.welcomeSessionId,
      firstSeed.welcomeSessionId,
      'restoring after clearing should create a fresh active welcome session',
    );
    assert.equal(
      restoredAfterClear.welcomeSessionId,
      thirdSeed.welcomeSessionId,
      'restore action should return the new active welcome session after a clear',
    );
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

await runScenario();
await runScenario({ preseedArchivedBasicChat: true });
await runScenario({ publicHostname: 'owner.example.com' });

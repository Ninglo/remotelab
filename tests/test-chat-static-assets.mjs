#!/usr/bin/env node
import assert from 'assert/strict';
import WebSocket from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';
const visitorCookie = 'visitor_session_token=visitor-session';

function randomPort() {
  return 43000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOutput(buffer, chunk, limit = 8000) {
  const next = `${buffer}${chunk}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function formatStartupOutput(stdout, stderr) {
  const sections = [];
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
  if (stdout.trim()) sections.push(`stdout:\n${stdout.trim()}`);
  return sections.join('\n\n');
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
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function connectWs(port, wsCookie = cookie) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: wsCookie },
    });
    socket.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {}
    });
    socket.on('open', () => resolve({ socket, messages }));
    socket.on('error', reject);
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-chat-static-'));
  const configDir = join(home, '.config', 'remotelab');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
      'visitor-session': {
        expiry: Date.now() + 60 * 60 * 1000,
        role: 'visitor',
        agentId: 'shared-agent',
        sessionId: 'visitor-session-id',
        visitorId: 'visitor-123',
        preferredLanguage: 'zh-CN',
      },
    }, null, 2),
    'utf8',
  );

  return { home };
}

async function startServer({ home, port }) {
  const configDir = join(home, '.config', 'remotelab');
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      REMOTELAB_INSTANCE_ROOT: '',
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_MEMORY_DIR: join(home, '.remotelab', 'memory'),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitLabel = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        const output = formatStartupOutput(stdout, stderr);
        throw new Error(
          output
            ? `Server exited during startup with ${exitLabel}\n\n${output}`
            : `Server exited during startup with ${exitLabel}`,
        );
      }
      try {
        const res = await request(port, 'GET', '/login', null, { Cookie: '' });
        return res.status === 200;
      } catch {
        return false;
      }
    }, 'server startup');
  } catch (error) {
    const output = formatStartupOutput(stdout, stderr);
    if (!output || String(error.message).includes(output)) {
      throw error;
    }
    throw new Error(`${error.message}\n\n${output}`);
  }

  return { child };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function main() {
  const { home } = setupTempHome();
  const sessionsFile = join(home, '.config', 'remotelab', 'auth-sessions.json');
  const port = randomPort();
  const server = await startServer({ home, port });
  let ownerWs = null;
  let ownerWsMessages = [];
  let visitorWs = null;
  let visitorWsMessages = [];

  try {
    const authMe = await request(port, 'GET', '/api/auth/me');
    assert.equal(authMe.status, 200, 'auth info endpoint should work for owner session');
    assert.equal(authMe.headers['set-cookie']?.length, 1, 'auth info should refresh a near-expiry auth cookie');
    assert.match(authMe.headers['set-cookie'][0], /SameSite=Lax/i, 'auth cookie should use SameSite=Lax for better PWA compatibility');
    assert.match(authMe.headers['set-cookie'][0], /Max-Age=86400/i, 'auth cookie should include an explicit Max-Age');
    const authMeJson = JSON.parse(authMe.text);
    assert.equal(authMeJson.role, 'owner', 'auth info should identify the owner principal');
    assert.equal(authMeJson.surfaceMode, 'owner', 'owner auth should stay on the owner surface');
    assert.equal(authMeJson.principalKind, 'owner', 'owner auth should advertise the owner principal kind');
    assert.equal(authMeJson.capabilities?.manageAgents, true, 'owner auth should expose owner capabilities');
    const refreshedSessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    assert.ok(
      refreshedSessions['test-session']?.expiry > Date.now() + 23 * 60 * 60 * 1000,
      'auth info should extend server-side session expiry as a sliding session',
    );

    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200, 'chat page should render for owner session');
    assert.match(page.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(page.text, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/);
    assert.match(page.text, /<meta name="theme-color" content="#161618" media="\(prefers-color-scheme: dark\)">/);
    assert.match(page.text, /id="settingsConnectorsList"/, 'chat page should expose the connectors settings surface');
    const bootstrapMatch = page.text.match(/window\.__REMOTELAB_BOOTSTRAP__ = ([^;]+);/);
    assert.ok(bootstrapMatch, 'chat page should inline bootstrap payload');
    const bootstrap = JSON.parse(bootstrapMatch[1]);
    assert.equal(bootstrap.auth?.role, 'owner', 'bootstrap payload should include owner auth');
    assert.equal(bootstrap.auth?.surfaceMode, 'owner', 'bootstrap auth should identify the owner surface');
    assert.equal(bootstrap.auth?.principalKind, 'owner', 'bootstrap auth should identify the owner principal kind');
    assert.equal(bootstrap.auth?.capabilities?.createSession, true, 'bootstrap auth should expose owner capabilities');
    assert.equal(bootstrap.defaultSessionFolder, join(home, '.remotelab', 'workspace'), 'bootstrap should expose the managed default session folder');
    assert.equal(bootstrap.settings?.voiceInput?.configured, false, 'bootstrap should expose default instance voice settings');
    assert.equal(bootstrap.settings?.voiceInput?.resourceId, 'volc.seedasr.sauc.duration', 'bootstrap should expose the recommended default voice resource');
    assert.match(page.text, /<script src="chat\/session-store\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/composer-store\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/bootstrap\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/bootstrap-session-catalog\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-http-helpers\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-http-list-state\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-http\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/layout-tooling\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/tooling\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/realtime\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/realtime-render\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-surface-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/session-list-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/instance-settings\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/voice-input\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/settings-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/sidebar-ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="chat\/compose\.js(?:\?v=[^"]*)?"/);
    assert.doesNotMatch(page.text, /hydrateVoiceSettingsFromBootstrap/, 'chat page should not inline extra voice-settings hydration fallbacks');

    const ownerSettingsBefore = await request(port, 'GET', '/api/settings');
    assert.equal(ownerSettingsBefore.status, 200, 'owner should be able to read instance settings');
    const ownerSettingsBeforeJson = JSON.parse(ownerSettingsBefore.text);
    assert.equal(ownerSettingsBeforeJson.settings?.voiceInput?.configured, false, 'instance settings should start unconfigured in a fresh home');

    const visitorSettingsPatch = await request(port, 'PATCH', '/api/settings', {
      settings: {
        voiceInput: {
          appId: 'blocked-app',
        },
      },
    }, { Cookie: visitorCookie });
    assert.equal(visitorSettingsPatch.status, 403, 'visitor should not be able to edit instance settings');

    const ownerWsConnection = await connectWs(port, cookie);
    ownerWs = ownerWsConnection.socket;
    ownerWsMessages = ownerWsConnection.messages;
    const visitorWsConnection = await connectWs(port, visitorCookie);
    visitorWs = visitorWsConnection.socket;
    visitorWsMessages = visitorWsConnection.messages;

    const ownerSettingsUpdate = await request(port, 'PATCH', '/api/settings', {
      settings: {
        voiceInput: {
          appId: '3785118246',
          accessToken: 'token-owner',
          resourceId: 'volc.seedasr.sauc.duration',
          language: 'en-US',
        },
      },
    });
    assert.equal(ownerSettingsUpdate.status, 200, 'owner should be able to save instance settings');
    const ownerSettingsUpdateJson = JSON.parse(ownerSettingsUpdate.text);
    assert.equal(ownerSettingsUpdateJson.settings?.voiceInput?.appId, '3785118246');
    assert.equal(ownerSettingsUpdateJson.settings?.voiceInput?.accessToken, 'token-owner');
    assert.equal(ownerSettingsUpdateJson.settings?.voiceInput?.resourceId, 'volc.seedasr.sauc.duration');
    assert.equal(ownerSettingsUpdateJson.settings?.voiceInput?.configured, true);
    await waitFor(
      () => (
        ownerWsMessages.some((msg) => msg.type === 'instance_settings_updated' && msg.updatedAt)
        && visitorWsMessages.some((msg) => msg.type === 'instance_settings_updated' && msg.updatedAt)
      ),
      'instance settings websocket update',
    );

    const visitorSettingsRead = await request(port, 'GET', '/api/settings', null, { Cookie: visitorCookie });
    assert.equal(visitorSettingsRead.status, 200, 'visitor should be able to read sanitized instance settings');
    const visitorSettingsReadJson = JSON.parse(visitorSettingsRead.text);
    assert.equal(visitorSettingsReadJson.settings?.voiceInput?.appId, '3785118246');
    assert.equal(visitorSettingsReadJson.settings?.voiceInput?.accessToken, '', 'visitor settings payload should not expose secrets');
    assert.equal(visitorSettingsReadJson.settings?.voiceInput?.configured, true, 'visitor settings payload should still expose readiness');

    const visitorPage = await request(port, 'GET', '/?visitor=1', null, { Cookie: visitorCookie });
    assert.equal(visitorPage.status, 200, 'chat page should also render for visitor session');
    const visitorBootstrapMatch = visitorPage.text.match(/window\.__REMOTELAB_BOOTSTRAP__ = ([^;]+);/);
    assert.ok(visitorBootstrapMatch, 'visitor page should inline bootstrap payload');
    const visitorBootstrap = JSON.parse(visitorBootstrapMatch[1]);
    assert.equal(visitorBootstrap.auth?.role, 'visitor', 'visitor page should inline visitor auth');
    assert.equal(visitorBootstrap.auth?.surfaceMode, 'visitor', 'legacy visitor bootstrap should stay on visitor surface mode');
    assert.equal(visitorBootstrap.auth?.principalKind, 'visitor', 'legacy visitor bootstrap should preserve the visitor principal kind');
    assert.equal(visitorBootstrap.auth?.agentId, 'shared-agent', 'legacy visitor bootstrap should keep the shared agent id');
    assert.equal(visitorBootstrap.auth?.preferredLanguage, 'zh-CN', 'legacy visitor bootstrap should retain preferred language');
    assert.equal(visitorBootstrap.auth?.sessionId, 'visitor-session-id', 'legacy visitor bootstrap should expose the pinned session id');
    assert.equal(visitorBootstrap.auth?.visitorId, 'visitor-123', 'legacy visitor bootstrap should expose visitor identity');
    assert.equal(visitorBootstrap.auth?.capabilities?.listSessions, false, 'legacy visitor bootstrap should not expose multi-session list access');
    assert.equal(visitorBootstrap.settings?.voiceInput?.accessToken, '', 'visitor bootstrap should not inline voice secrets');
    assert.equal(visitorBootstrap.settings?.voiceInput?.configured, true, 'visitor bootstrap should still expose shared voice readiness');
    assert.match(page.text, /<script src="chat\/init\.js(?:\?v=[^"]*)?"/);
    assert.doesNotMatch(page.text, /id="appFilterSelect"/);
    assert.match(page.text, /id="sourceFilterSelect"/);
    assert.doesNotMatch(page.text, /id="sessionAppFilterSelect"/);
    assert.doesNotMatch(page.text, /id="userFilterSelect"/);
    assert.match(page.text, /id="sortSessionListBtn"/);
    assert.match(page.text, /id="settingsSessionPresentationList"/);
    assert.match(page.text, /id="voiceInputAppId"/);
    assert.match(page.text, /id="voiceInputProviderSelect"/);
    assert.match(page.text, /id="voiceInputClusterPresetSelect"/);
    assert.match(page.text, /id="voiceInputGatewayApiKey"/);
    assert.match(page.text, /id="voiceBtn"/);
    assert.doesNotMatch(page.text, /id="settingsUsersList"/);
    assert.doesNotMatch(page.text, /id="settingsAppsList"/);
    assert.doesNotMatch(page.text, /id="newUserNameInput"/);
    assert.doesNotMatch(page.text, /id="createUserBtn"/);
    assert.doesNotMatch(page.text, /id="newAppNameInput"/);
    assert.doesNotMatch(page.text, /id="newAppToolSelect"/);
    assert.doesNotMatch(page.text, /id="newAppWelcomeInput"/);
    assert.doesNotMatch(page.text, /id="newAppSystemPromptInput"/);
    assert.doesNotMatch(page.text, /id="createAppConfigBtn"/);
    assert.doesNotMatch(page.text, /id="voiceSettingsMount"/);
    assert.doesNotMatch(page.text, /id="voiceInputBtn"/);
    assert.doesNotMatch(page.text, /id="voiceFileInput"/);
    assert.doesNotMatch(page.text, /id="voiceCleanupToggle"/);
    assert.match(page.text, /class="header-btn header-btn--sessions" id="menuBtn"/, 'mobile header should promote the session entry as a primary button');
    assert.match(page.text, /id="menuBtn"[\s\S]*class="header-btn-label" data-i18n="nav\.sessions">Sessions</, 'session button should include an explicit text label');
    assert.doesNotMatch(page.text, /id="forkSessionBtn"/, 'fork should no longer occupy the top header');
    assert.match(page.text, /id="shareSnapshotBtn"[\s\S]*data-icon="share"/, 'share should render as a lighter icon-led secondary action');
    assert.match(page.text, /class="input-config-row"[\s\S]*class="input-wrapper"/, 'composer should keep tooling controls above the dedicated input shell');
    assert.match(page.text, /id="msgInput"[\s\S]*class="input-actions-row"[\s\S]*id="imgBtn"[\s\S]*id="voiceBtn"[\s\S]*id="sendBtn"/, 'composer should stack textarea above the action row so buttons no longer squeeze the text width');
    assert.match(page.text, /id="quickEntryFocusPrompt" hidden/, 'chat page should include the quick-entry focus recovery prompt shell');
    assert.match(page.text, /id="voiceInputStatus"/);
    assert.match(page.text, /id="tabSettings"/);
    assert.doesNotMatch(page.text, /id="collapseBtn"/, 'desktop sidebar should no longer expose a collapse control');
    assert.doesNotMatch(page.text, /id="tabProgress"/);
    assert.doesNotMatch(page.text, /id="saveTemplateBtn"/);
    assert.doesNotMatch(page.text, /id="sessionTemplateSelect"/);
    assert.match(page.text, /<div class="app-shell">/, 'chat page should render inside a dedicated app shell');
    assert.match(page.text, /chat\/chat\.css\?v=/, 'chat page should fingerprint the split chat stylesheet');
    const chatStylesheet = await request(port, 'GET', '/chat/chat.css');
    assert.equal(chatStylesheet.status, 200, 'chat stylesheet should load');
    assert.equal(
      chatStylesheet.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'chat stylesheet should use safe revalidation caching',
    );
    assert.ok(chatStylesheet.headers.etag, 'chat stylesheet should expose an ETag');
    assert.match(chatStylesheet.text, /@import url\("chat-base\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-sidebar\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-messages\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-input\.css"\);/);
    assert.match(chatStylesheet.text, /@import url\("chat-responsive\.css"\);/);

    const chatBaseStylesheet = await request(port, 'GET', '/chat/chat-base.css');
    const chatSidebarStylesheet = await request(port, 'GET', '/chat/chat-sidebar.css');
    const chatMessagesStylesheet = await request(port, 'GET', '/chat/chat-messages.css');
    const chatInputStylesheet = await request(port, 'GET', '/chat/chat-input.css');
    const chatResponsiveStylesheet = await request(port, 'GET', '/chat/chat-responsive.css');
    for (const stylesheet of [chatBaseStylesheet, chatSidebarStylesheet, chatMessagesStylesheet, chatInputStylesheet, chatResponsiveStylesheet]) {
      assert.equal(stylesheet.status, 200, 'split chat stylesheet should load');
      assert.equal(
        stylesheet.headers['cache-control'],
        'public, no-cache, max-age=0, must-revalidate',
        'split chat stylesheet should use safe revalidation caching',
      );
      assert.ok(stylesheet.headers.etag, 'split chat stylesheet should expose an ETag');
    }
    const combinedChatStyles = [
      chatBaseStylesheet.text,
      chatSidebarStylesheet.text,
      chatMessagesStylesheet.text,
      chatInputStylesheet.text,
      chatResponsiveStylesheet.text,
    ].join('\n');
    assert.match(combinedChatStyles, /\.header-btn,\s*\.sidebar-tab,\s*\.sidebar-filter-select,\s*\.new-session-btn,\s*\.session-action-btn,\s*\.session-item,\s*\.folder-group-header,\s*\.archived-section-header\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent;/, 'sidebar interactions should suppress the mobile tap highlight flash');
    assert.match(combinedChatStyles, /--app-height:\s*100dvh/);
    assert.match(combinedChatStyles, /--keyboard-inset-height:\s*0px/);
    assert.match(combinedChatStyles, /--sidebar-width-expanded:\s*min\(80vw, calc\(100vw - 240px\)\);/);
    assert.match(combinedChatStyles, /\.app-shell\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'app shell should reserve a fixed header row and a flexible body row');
    assert.match(combinedChatStyles, /\.app-container\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(combinedChatStyles, /\.chat-area\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto auto;[\s\S]*?min-height:\s*0;/, 'chat area should model content, queued panel, and composer as explicit rows');
    assert.match(combinedChatStyles, /\.chat-area > \*\s*\{[\s\S]*?min-width:\s*0;/, 'chat-area grid children should be allowed to shrink horizontally instead of expanding the column');
    assert.match(combinedChatStyles, /\.messages\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(combinedChatStyles, /\.messages-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/, 'message column should stay bound to the available chat width');
    assert.match(combinedChatStyles, /\.input-resize-handle\s*\{[\s\S]*?margin:\s*0 calc\(var\(--chat-gutter\) \* -1\) 8px;/, 'resize handle should mirror the current chat gutter so it does not create horizontal overflow on mobile');
    assert.match(combinedChatStyles, /\.quick-entry-focus-btn\s*\{[\s\S]*?width:\s*100%;/, 'chat styles should expose a full-width quick-entry focus fallback button');
    assert.doesNotMatch(combinedChatStyles, /\.sidebar-overlay\.collapsed/, 'desktop sidebar should no longer render a collapsed state');
    assert.match(combinedChatStyles, /\.modal-backdrop\s*\{[\s\S]*?padding-left:\s*calc\(var\(--sidebar-width\) \+ 24px\);/, 'desktop modals should offset against the fixed-width sidebar');
    assert.match(combinedChatStyles, /body\.keyboard-open \.messages/);
    assert.match(combinedChatStyles, /body\.keyboard-open \.input-area/);
    assert.doesNotMatch(combinedChatStyles, /--app-top-offset/);
    assert.ok(!page.text.includes('/chat.js?v='), 'chat page should not pin the chat frontend to a versioned URL');
    assert.match(page.text, /<base href="\/">/, 'chat page should set an explicit product-base href');
    assert.match(page.text, /marked\.min\.js\?v=/, 'chat page should fingerprint marked.min.js alongside the split chat assets');
    assert.match(page.text, /manifest\.json\?v=/, 'chat page should fingerprint the manifest URL so installed PWAs refresh policy changes');
    assert.match(page.text, /title="Attach files"/, 'chat page should advertise file uploads in the composer');
    assert.match(page.text, /accept="\*\/\*"/, 'chat page should allow arbitrary file selection');

    const manifest = await request(port, 'GET', '/manifest.json');
    assert.equal(manifest.status, 200, 'manifest should load');
    const manifestJson = JSON.parse(manifest.text);
    assert.equal(manifestJson.id, './', 'manifest should declare a stable app id inside the current product scope');
    assert.equal(manifestJson.display, 'standalone', 'manifest should still advertise standalone install mode');
    assert.equal('orientation' in manifestJson, false, 'manifest should not force an orientation policy in the installed PWA shell');
    assert.equal(Array.isArray(manifestJson.shortcuts), true, 'manifest should advertise launcher shortcuts for installed Android PWAs');
    assert.equal(manifestJson.shortcuts.length, 1, 'manifest should keep the first quick-entry release to a single shortcut');
    assert.equal(manifestJson.shortcuts[0]?.name, '快速记录', 'manifest should expose the quick-entry shortcut label');
    assert.equal(manifestJson.shortcuts[0]?.url, './?intent=new-session', 'manifest shortcut should stay inside the current product scope');
    assert.equal(manifestJson.icons[0]?.src, 'icon.svg', 'manifest icons should resolve relative to the current product scope');

    const prefixedPage = await request(port, 'GET', '/', null, { 'x-forwarded-prefix': '/owner' });
    assert.equal(prefixedPage.status, 200, 'chat page should still render behind a forwarded product prefix');
    assert.match(prefixedPage.text, /<base href="\/owner\/">/, 'chat page should advertise the forwarded product prefix through base href');
    assert.match(prefixedPage.text, /<link rel="manifest" href="manifest\.json\?v=/, 'chat page should keep the manifest link relative inside a prefixed surface');
    assert.match(prefixedPage.text, /<link rel="stylesheet" href="chat\/chat\.css\?v=/, 'chat page should keep the split stylesheet inside the forwarded product scope');
    assert.match(prefixedPage.text, /<script src="chat\/product-paths\.js(?:\?v=[^"]*)?"/, 'chat page should continue to load the product-path helper under a prefix');

    const loginPage = await request(port, 'GET', '/login', null, { Cookie: '' });
    assert.equal(loginPage.status, 200, 'login page should render without auth');
    assert.match(loginPage.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(loginPage.text, /<meta name="application-name" content="RemoteLab">/);
    assert.match(loginPage.text, /<meta name="theme-color" content="#f8f8fa" media="\(prefers-color-scheme: light\)">/);
    assert.match(loginPage.text, /<meta name="theme-color" content="#161618" media="\(prefers-color-scheme: dark\)">/);
    assert.match(loginPage.text, /@media \(prefers-color-scheme: dark\)/);

    const prefixedLoginPage = await request(port, 'GET', '/login', null, {
      Cookie: '',
      'x-forwarded-prefix': '/owner',
    });
    assert.equal(prefixedLoginPage.status, 200, 'login page should still render behind a forwarded product prefix');
    assert.match(prefixedLoginPage.text, /<base href="\/owner\/">/, 'login page should advertise the forwarded product prefix through base href');
    assert.match(prefixedLoginPage.text, /<form id="pw-form" method="POST" action="login">/, 'login password form should stay inside the forwarded product scope');
    assert.match(prefixedLoginPage.text, /<form id="token-form" class="hidden" method="POST" action="login">/, 'login token form should stay inside the forwarded product scope');

    const agents = await request(port, 'GET', '/api/agents');
    assert.equal(agents.status, 200, 'owner agents endpoint should be available');
    const agentList = JSON.parse(agents.text);
    assert.ok(Array.isArray(agentList.agents), 'owner agents endpoint should return a collection');

    const legacyApps = await request(port, 'GET', '/api/apps');
    assert.equal(legacyApps.status, 404, 'legacy owner apps endpoint should be absent from the product surface');

    const users = await request(port, 'GET', '/api/users');
    assert.equal(users.status, 404, 'owner users endpoint should be absent from the product surface');

    const visitors = await request(port, 'GET', '/api/visitors');
    assert.equal(visitors.status, 404, 'owner visitors endpoint should be absent from the product surface');

    const legacyAgentShare = await request(port, 'GET', '/app/example-token', null, { Cookie: '' });
    assert.equal(legacyAgentShare.status, 404, 'legacy app share route should stay absent');

    const agentShare = await request(port, 'GET', '/agent/example-token', null, { Cookie: '' });
    assert.equal(agentShare.status, 404, 'interactive agent share route should reject unknown tokens');

    const visitorShare = await request(port, 'GET', '/visitor/example-token');
    assert.equal(visitorShare.status, 404, 'interactive visitor share route should be absent');

    const createdAgent = await request(port, 'POST', '/api/agents', {
      name: 'Shared Drawing Agent',
      systemPrompt: 'You are a shared drawing agent.',
      welcomeMessage: 'Welcome to the shared drawing agent.',
      tool: 'codex',
    });
    assert.equal(createdAgent.status, 201, 'owner should be able to create a shareable agent');
    const createdAgentJson = JSON.parse(createdAgent.text);
    assert.ok(createdAgentJson.shareToken, 'created agent should include a share token');

    const legacySharedEntry = await request(port, 'GET', `/app/${createdAgentJson.shareToken}`, null, { Cookie: '' });
    assert.equal(legacySharedEntry.status, 404, 'legacy app share links should stay removed');

    const sharedEntry = await request(port, 'GET', `/agent/${createdAgentJson.shareToken}`, null, { Cookie: '' });
    assert.equal(sharedEntry.status, 302, 'shared agent route should mint a visitor session and redirect into visitor mode');
    assert.equal(sharedEntry.headers.location, '/?visitor=1');
    assert.ok(Array.isArray(sharedEntry.headers['set-cookie']), 'shared agent route should set a visitor cookie');
    const sharedVisitorCookie = sharedEntry.headers['set-cookie'][0].split(';')[0];
    assert.match(sharedVisitorCookie, /^visitor_session_token=/);

    const sharedVisitorPage = await request(port, 'GET', '/?visitor=1', null, { Cookie: sharedVisitorCookie });
    assert.equal(sharedVisitorPage.status, 200, 'shared visitor session should be able to open the chat surface');
    const sharedVisitorBootstrapMatch = sharedVisitorPage.text.match(/window\.__REMOTELAB_BOOTSTRAP__ = ([^;]+);/);
    assert.ok(sharedVisitorBootstrapMatch, 'shared visitor page should inline bootstrap payload');
    const sharedVisitorBootstrap = JSON.parse(sharedVisitorBootstrapMatch[1]);
    assert.equal(sharedVisitorBootstrap.auth?.role, 'visitor');
    assert.equal(sharedVisitorBootstrap.auth?.surfaceMode, 'agent_scoped', 'shared agent bootstrap should identify the agent-scoped surface');
    assert.equal(sharedVisitorBootstrap.auth?.principalKind, 'agent_guest', 'shared agent bootstrap should identify the shared guest principal');
    assert.equal(sharedVisitorBootstrap.auth?.agentId, createdAgentJson.id);
    assert.equal(sharedVisitorBootstrap.auth?.currentAgent?.id, createdAgentJson.id, 'shared agent bootstrap should expose the current agent context');
    assert.equal(sharedVisitorBootstrap.auth?.currentAgent?.tool, 'codex', 'shared agent bootstrap should expose the current agent tool');
    assert.ok(sharedVisitorBootstrap.auth?.principalId, 'shared visitor bootstrap should expose a principal identity');
    assert.ok(sharedVisitorBootstrap.auth?.visitorId, 'shared visitor bootstrap should expose a visitor identity');
    assert.equal(sharedVisitorBootstrap.auth?.capabilities?.listSessions, true, 'shared agent bootstrap should allow listing sessions');
    assert.equal(sharedVisitorBootstrap.auth?.capabilities?.createSession, true, 'shared agent bootstrap should allow creating sessions');
    assert.equal(sharedVisitorBootstrap.auth?.capabilities?.changeRuntime, false, 'shared agent bootstrap should keep runtime selection disabled');
    assert.equal(sharedVisitorBootstrap.auth?.capabilities?.switchAgents, false, 'shared agent bootstrap should keep agent switching disabled');

    const sharedAuthMe = await request(port, 'GET', '/api/auth/me?visitor=1', null, { Cookie: sharedVisitorCookie });
    assert.equal(sharedAuthMe.status, 200, 'shared visitor auth endpoint should resolve on the visitor cookie');
    const sharedAuthMeJson = JSON.parse(sharedAuthMe.text);
    assert.equal(sharedAuthMeJson.surfaceMode, 'agent_scoped', 'shared visitor auth should report the agent-scoped surface');
    assert.equal(sharedAuthMeJson.currentAgent?.id, createdAgentJson.id, 'shared visitor auth should expose current agent metadata');
    assert.ok(sharedAuthMeJson.principalId, 'shared visitor auth should expose a principal id');

    const sharedCreated = await request(port, 'POST', '/api/sessions?visitor=1', {
      name: 'Shared guest workspace session',
    }, { Cookie: sharedVisitorCookie });
    assert.equal(sharedCreated.status, 201, 'shared visitors should be able to create sessions inside the shared agent workspace');
    const sharedCreatedJson = JSON.parse(sharedCreated.text);
    assert.equal(sharedCreatedJson.session?.templateId, createdAgentJson.id, 'shared visitor sessions should be pinned to the shared agent template');
    assert.equal(sharedCreatedJson.session?.agentId, createdAgentJson.id, 'shared visitor sessions should persist the shared agent id');
    assert.equal(sharedCreatedJson.session?.visitorId, sharedVisitorBootstrap.auth?.principalId, 'shared visitor sessions should be isolated to the minted principal');
    assert.equal(sharedCreatedJson.session?.tool, 'codex', 'shared visitor sessions should inherit the shared agent tool');
    assert.equal(sharedCreatedJson.session?.folder, join(home, '.remotelab', 'workspace'), 'shared visitor sessions should default to the managed work root');

    const defaultOwnerCreated = await request(port, 'POST', '/api/sessions', {
      tool: 'codex',
      name: 'Owner default workspace session',
    });
    assert.equal(defaultOwnerCreated.status, 201, 'owner sessions should be creatable without an explicit folder');
    const defaultOwnerCreatedJson = JSON.parse(defaultOwnerCreated.text);
    assert.equal(defaultOwnerCreatedJson.session?.folder, join(home, '.remotelab', 'workspace'), 'owner sessions without a folder should default to the managed work root');

    const sharedList = await request(port, 'GET', '/api/sessions?visitor=1', null, { Cookie: sharedVisitorCookie });
    assert.equal(sharedList.status, 200, 'shared visitors should be able to list their workspace sessions');
    const sharedListJson = JSON.parse(sharedList.text);
    assert.equal(sharedListJson.sessions?.length, 1, 'shared visitor list should expose only the visitor-owned workspace session');
    assert.equal(sharedListJson.sessions?.[0]?.id, sharedCreatedJson.session.id, 'shared visitor list should contain the created workspace session');

    const sharedRenamed = await request(port, 'PATCH', `/api/sessions/${sharedCreatedJson.session.id}?visitor=1`, {
      name: 'Shared guest workspace session renamed',
    }, { Cookie: sharedVisitorCookie });
    assert.equal(sharedRenamed.status, 200, 'shared visitors should be able to rename their workspace session');
    assert.match(sharedRenamed.text, /Shared guest workspace session renamed/);

    const createdChat = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'codex',
      name: 'Owner chat session',
    });
    assert.equal(createdChat.status, 201, 'owner chat session should be creatable over HTTP');
    const createdChatJson = JSON.parse(createdChat.text);

    const createdGithub = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'codex',
      name: 'GitHub session',
      sourceId: 'github',
      sourceName: 'GitHub',
    });
    assert.equal(createdGithub.status, 201, 'GitHub-source session should be creatable over HTTP');
    const createdGithubJson = JSON.parse(createdGithub.text);

    const pinned = await request(port, 'PATCH', `/api/sessions/${createdChatJson.session.id}`, {
      pinned: true,
    });
    assert.equal(pinned.status, 200, 'session pinning should be available over HTTP');
    assert.match(pinned.text, /"pinned":true/);

    const allSessions = await request(port, 'GET', '/api/sessions');
    assert.equal(allSessions.status, 200, 'full session list should load');
    const allSessionsJson = JSON.parse(allSessions.text);
    assert.equal(
      allSessionsJson.sessions?.[0]?.id,
      createdChatJson.session.id,
      'pinned session should sort to the top of the session list',
    );
    assert.equal(
      allSessionsJson.sessions?.some((session) => session.id === createdGithubJson.session.id),
      true,
      'other sessions should remain visible after pinning',
    );

    const sharedListAfterOwnerCreates = await request(port, 'GET', '/api/sessions?visitor=1', null, { Cookie: sharedVisitorCookie });
    assert.equal(sharedListAfterOwnerCreates.status, 200, 'shared visitors should still list sessions after owner creates more sessions');
    const sharedListAfterOwnerCreatesJson = JSON.parse(sharedListAfterOwnerCreates.text);
    assert.equal(
      sharedListAfterOwnerCreatesJson.sessions?.some((session) => session.id === createdChatJson.session.id),
      false,
      'shared visitors should not see owner sessions outside their scoped workspace',
    );

    const githubOnly = await request(port, 'GET', '/api/sessions?sourceId=github');
    assert.equal(githubOnly.status, 200, 'source-filtered session list should load');
    assert.match(githubOnly.text, /"sourceId":"github"/);
    assert.match(githubOnly.text, /"sourceName":"GitHub"/);
    assert.doesNotMatch(githubOnly.text, /"name":"Owner chat session"/);

    const splitAsset = await request(port, 'GET', '/chat/bootstrap.js');
    assert.equal(splitAsset.status, 200, 'split chat asset should load');
    assert.equal(
      splitAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'split asset should use safe revalidation caching',
    );
    assert.ok(splitAsset.headers.etag, 'split asset should expose an ETag');
    assert.match(splitAsset.text, /const buildInfo = window\.__REMOTELAB_BUILD__ \|\| \{\};/);

    const initAsset = await request(port, 'GET', '/chat/init.js');
    assert.equal(initAsset.status, 200, 'chat init asset should load');
    assert.match(
      initAsset.text,
      /await openInstallFlow\(\{ source: "auto", replace: true \}\)/,
      'mobile install redirects should funnel through the shared install helper',
    );
    assert.match(initAsset.text, /window\.remotelabOpenInstallFlow = openInstallFlow;/, 'chat init should expose the install entry helper');

    const productPathsAsset = await request(port, 'GET', '/chat/product-paths.js');
    assert.equal(productPathsAsset.status, 200, 'product path helper asset should load');
    assert.match(productPathsAsset.text, /function resolveProductPath\(/);
    assert.match(productPathsAsset.text, /remotelabResolveProductPath = resolveProductPath/);

    const sessionHttpHelpersAsset = await request(port, 'GET', '/chat/session-http-helpers.js');
    assert.equal(sessionHttpHelpersAsset.status, 200, 'session http helpers asset should load');
    assert.match(sessionHttpHelpersAsset.text, /function enhanceRenderedContentLinks\(/);
    assert.match(sessionHttpHelpersAsset.text, /const SESSION_LIST_URL = "\/api\/sessions";/);

    const sessionHttpListStateAsset = await request(port, 'GET', '/chat/session-http-list-state.js');
    assert.equal(sessionHttpListStateAsset.status, 200, 'session http list state asset should load');
    assert.match(sessionHttpListStateAsset.text, /function applySessionListState\(/);
    assert.match(sessionHttpListStateAsset.text, /function applyArchivedSessionListState\(/);

    const sessionHttpAsset = await request(port, 'GET', '/chat/session-http.js');
    assert.equal(sessionHttpAsset.status, 200, 'session http asset should load');
    const sessionStoreAsset = await request(port, 'GET', '/chat/session-store.js');
    assert.equal(sessionStoreAsset.status, 200, 'session store asset should load');
    assert.match(sessionStoreAsset.text, /RemoteLabChatStore/);
    const composerStoreAsset = await request(port, 'GET', '/chat/composer-store.js');
    assert.equal(composerStoreAsset.status, 200, 'composer store asset should load');
    assert.match(composerStoreAsset.text, /RemoteLabComposerStore/);
    const bootstrapCatalogAsset = await request(port, 'GET', '/chat/bootstrap-session-catalog.js');
    assert.equal(bootstrapCatalogAsset.status, 200, 'bootstrap session catalog asset should load');
    assert.match(bootstrapCatalogAsset.text, /function getEffectiveSessionSourceId\(/);
    assert.match(bootstrapCatalogAsset.text, /function sortSessionsInPlace\(/);

    if (/getEffectiveSessionSourceId\(/.test(sessionHttpAsset.text)) {
      assert.match(
        bootstrapCatalogAsset.text,
        /function getEffectiveSessionSourceId\(/,
        'bootstrap session catalog asset should define the effective source helper used by session-http',
      );
    }

    const versionedSplitAsset = await request(port, 'GET', '/chat/bootstrap.js?v=test-build');
    assert.equal(versionedSplitAsset.status, 200, 'versioned split chat asset should load');
    assert.equal(
      versionedSplitAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned split assets should be immutable cache hits',
    );

    const versionedBootstrapCatalogAsset = await request(port, 'GET', '/chat/bootstrap-session-catalog.js?v=test-build');
    assert.equal(versionedBootstrapCatalogAsset.status, 200, 'versioned bootstrap session catalog asset should load');
    assert.equal(
      versionedBootstrapCatalogAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned bootstrap session catalog asset should be immutable cache hits',
    );

    const versionedSessionStoreAsset = await request(port, 'GET', '/chat/session-store.js?v=test-build');
    assert.equal(versionedSessionStoreAsset.status, 200, 'versioned session store asset should load');
    assert.equal(
      versionedSessionStoreAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session store asset should be immutable cache hits',
    );

    const versionedComposerStoreAsset = await request(port, 'GET', '/chat/composer-store.js?v=test-build');
    assert.equal(versionedComposerStoreAsset.status, 200, 'versioned composer store asset should load');
    assert.equal(
      versionedComposerStoreAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned composer store asset should be immutable cache hits',
    );

    const versionedSessionHttpHelpersAsset = await request(port, 'GET', '/chat/session-http-helpers.js?v=test-build');
    assert.equal(versionedSessionHttpHelpersAsset.status, 200, 'versioned session http helpers asset should load');
    assert.equal(
      versionedSessionHttpHelpersAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session http helpers asset should be immutable cache hits',
    );

    const versionedSessionHttpListStateAsset = await request(port, 'GET', '/chat/session-http-list-state.js?v=test-build');
    assert.equal(versionedSessionHttpListStateAsset.status, 200, 'versioned session http list state asset should load');
    assert.equal(
      versionedSessionHttpListStateAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session http list state asset should be immutable cache hits',
    );

    const versionedLayoutToolingAsset = await request(port, 'GET', '/chat/layout-tooling.js?v=test-build');
    assert.equal(versionedLayoutToolingAsset.status, 200, 'versioned layout tooling asset should load');
    assert.equal(
      versionedLayoutToolingAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned layout tooling asset should be immutable cache hits',
    );

    const versionedRealtimeRenderAsset = await request(port, 'GET', '/chat/realtime-render.js?v=test-build');
    assert.equal(versionedRealtimeRenderAsset.status, 200, 'versioned realtime render asset should load');
    assert.equal(
      versionedRealtimeRenderAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned realtime render asset should be immutable cache hits',
    );

    const versionedChatStylesheet = await request(port, 'GET', '/chat/chat.css?v=test-build');
    assert.equal(versionedChatStylesheet.status, 200, 'versioned chat stylesheet should load');
    assert.equal(
      versionedChatStylesheet.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned chat stylesheet should be immutable cache hits',
    );
    assert.match(versionedChatStylesheet.text, /@import url\("chat-base\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-sidebar\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-messages\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-input\.css\?v=test-build"\);/);
    assert.match(versionedChatStylesheet.text, /@import url\("chat-responsive\.css\?v=test-build"\);/);

    const versionedChatBaseStylesheet = await request(port, 'GET', '/chat/chat-base.css?v=test-build');
    assert.equal(versionedChatBaseStylesheet.status, 200, 'versioned split chat stylesheet should load');
    assert.equal(
      versionedChatBaseStylesheet.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned split chat stylesheet should be immutable cache hits',
    );

    const stateModelAsset = await request(port, 'GET', '/chat/session-state-model.js');
    assert.equal(stateModelAsset.status, 200, 'session state model asset should load');
    assert.equal(
      stateModelAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'session state model should use safe revalidation caching',
    );
    assert.ok(stateModelAsset.headers.etag, 'session state model asset should expose an ETag');
    assert.match(stateModelAsset.text, /RemoteLabSessionStateModel/);

    const sessionStoreModelAsset = await request(port, 'GET', '/chat/session-store.js');
    assert.equal(sessionStoreModelAsset.status, 200, 'session store model asset should load');
    assert.equal(
      sessionStoreModelAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'session store model should use safe revalidation caching',
    );
    assert.ok(sessionStoreModelAsset.headers.etag, 'session store model asset should expose an ETag');
    assert.match(sessionStoreModelAsset.text, /RemoteLabChatStore/);

    const composerStoreModelAsset = await request(port, 'GET', '/chat/composer-store.js');
    assert.equal(composerStoreModelAsset.status, 200, 'composer store model asset should load');
    assert.equal(
      composerStoreModelAsset.headers['cache-control'],
      'public, no-cache, max-age=0, must-revalidate',
      'composer store model should use safe revalidation caching',
    );
    assert.ok(composerStoreModelAsset.headers.etag, 'composer store model asset should expose an ETag');
    assert.match(composerStoreModelAsset.text, /RemoteLabComposerStore/);

    const layoutToolingAsset = await request(port, 'GET', '/chat/layout-tooling.js');
    assert.equal(layoutToolingAsset.status, 200, 'layout tooling asset should load');
    assert.match(layoutToolingAsset.text, /document\.documentElement\.style\.setProperty\("--app-height"/);
    assert.match(layoutToolingAsset.text, /document\.documentElement\.style\.setProperty\("--keyboard-inset-height"/);
    assert.match(layoutToolingAsset.text, /function requestLayoutPass\(/);
    assert.match(layoutToolingAsset.text, /window\.RemoteLabLayout = \{/);
    assert.match(layoutToolingAsset.text, /window\.visualViewport\?\.addEventListener\("resize", \(\) => requestLayoutPass\("visual-viewport-resize"\)\)/);
    assert.match(layoutToolingAsset.text, /window\.visualViewport\?\.addEventListener\("scroll", \(\) => requestLayoutPass\("visual-viewport-scroll"\)\)/);
    assert.match(layoutToolingAsset.text, /function focusComposer\(/);

    const toolingAsset = await request(port, 'GET', '/chat/tooling.js');
    assert.equal(toolingAsset.status, 200, 'tooling asset should load');
    assert.match(toolingAsset.text, /const modelResponseCache = new Map\(\);/);
    assert.match(toolingAsset.text, /async function fetchModelResponse\(/);

    const realtimeRenderAsset = await request(port, 'GET', '/chat/realtime-render.js');
    assert.equal(realtimeRenderAsset.status, 200, 'realtime render asset should load');
    assert.match(realtimeRenderAsset.text, /function renderEvent\(/);
    assert.match(realtimeRenderAsset.text, /async function hydrateLazyNodes\(/);

    const uiAsset = await request(port, 'GET', '/chat/ui.js');
    assert.equal(uiAsset.status, 200, 'ui asset should load');
    assert.match(uiAsset.text, /\/api\/media\//, 'ui asset should load persisted media attachments from the media route');

    const sessionSurfaceUiAsset = await request(port, 'GET', '/chat/session-surface-ui.js');
    assert.equal(sessionSurfaceUiAsset.status, 200, 'session surface ui asset should load');
    assert.match(sessionSurfaceUiAsset.text, /function createActiveSessionItem\(/);
    assert.match(sessionSurfaceUiAsset.text, /function buildSessionMetaParts\(/);

    const sessionListUiAsset = await request(port, 'GET', '/chat/session-list-ui.js');
    assert.equal(sessionListUiAsset.status, 200, 'session list ui asset should load');
    assert.match(sessionListUiAsset.text, /function renderSessionList\(/);
    assert.match(sessionListUiAsset.text, /function attachSession\(/);
    assert.match(sessionListUiAsset.text, /focusComposer\(\{ force: forceComposerFocus === true, preventScroll: true \}\)/);

    const sidebarUiAsset = await request(port, 'GET', '/chat/sidebar-ui.js');
    assert.equal(sidebarUiAsset.status, 200, 'sidebar ui asset should load');
    assert.match(sidebarUiAsset.text, /function openSidebar\(/);
    assert.match(sidebarUiAsset.text, /menuBtn\.addEventListener\("click", openSessionsSidebar\);/, 'header session button should always open the sessions tab');
    assert.match(sidebarUiAsset.text, /function createNewSessionShortcut\(/);
    assert.match(sidebarUiAsset.text, /requestLayoutPass\("composer-images"\)/);

    const settingsUiAsset = await request(port, 'GET', '/chat/settings-ui.js');
    assert.equal(settingsUiAsset.status, 200, 'settings ui asset should load');
    assert.match(settingsUiAsset.text, /function initUiLanguageSettings\(/);
    assert.match(settingsUiAsset.text, /function renderSettingsSessionPresentationPanel\(/);
    assert.match(settingsUiAsset.text, /function initInstallSettings\(/);
    assert.match(settingsUiAsset.text, /function initVoiceInputSettings\(/);
    assert.match(settingsUiAsset.text, /function renderVoiceInputClusterOptions\(/);

    const instanceSettingsAsset = await request(port, 'GET', '/chat/instance-settings.js');
    assert.equal(instanceSettingsAsset.status, 200, 'instance settings asset should load');
    assert.match(instanceSettingsAsset.text, /function fetchInstanceSettings\(/);
    assert.match(instanceSettingsAsset.text, /remotelabUpdateInstanceSettings/);

    const composeAsset = await request(port, 'GET', '/chat/compose.js');
    assert.equal(composeAsset.status, 200, 'compose asset should load');
    assert.match(composeAsset.text, /focusComposer\(\{ force: true, preventScroll: true \}\)/);
    assert.match(composeAsset.text, /window\.RemoteLabLayout\?\.subscribe/);
    assert.doesNotMatch(composeAsset.text, /voice-transcriptions/);

    const voiceInputAsset = await request(port, 'GET', '/chat/voice-input.js');
    assert.equal(voiceInputAsset.status, 200, 'voice input asset should load');
    assert.match(voiceInputAsset.text, /DOUBAO_VOICE_WS_PATH/);
    assert.match(voiceInputAsset.text, /function startVoiceCapture\(/);
    assert.match(voiceInputAsset.text, /VOICE_WORKLET_MODULE_PATH/);

    const voiceWorkletAsset = await request(port, 'GET', '/chat/voice-input-worklet.js');
    assert.equal(voiceWorkletAsset.status, 200, 'voice input worklet asset should load');
    assert.match(voiceWorkletAsset.text, /registerProcessor\("remotelab-voice-input-processor"/);

    const initAssetReload = await request(port, 'GET', '/chat/init.js');
    assert.equal(initAssetReload.status, 200, 'init asset should load');
    assert.match(initAssetReload.text, /typeof getBootstrapAuthInfo === "function"/);
    assert.match(initAssetReload.text, /loadInlineTools\(\{ skipModelLoad: true \}\)/);
    assert.match(initAssetReload.text, /bootstrapViaHttp\(\{ deferOwnerRestore: true \}\)/);
    assert.match(initAssetReload.text, /intent !== "new-session"/, 'init should recognize the quick-entry launch intent');
    assert.match(initAssetReload.text, /forceComposerFocus: true/, 'launch intent should request a one-time forced composer focus');
    assert.match(page.text, /id="settingsInstallAppBtn"/, 'settings page should expose a direct install button');
    assert.match(page.text, /id="settingsInstallStatus"/, 'settings page should expose install status copy');
    assert.match(page.text, /class="voice-btn-meter"/, 'voice button should expose a live meter surface');

    const tokenLogin = await request(
      port,
      'GET',
      '/?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      null,
      { Cookie: '' },
    );
    assert.equal(tokenLogin.status, 302, 'token login should redirect into the app');
    assert.equal(tokenLogin.headers.location, '/', 'token login should land on the root app');
    assert.equal(tokenLogin.headers['set-cookie']?.length, 1, 'token login should issue a session cookie');
    assert.match(tokenLogin.headers['set-cookie'][0], /SameSite=Lax/i, 'token login cookie should use SameSite=Lax');
    assert.match(tokenLogin.headers['set-cookie'][0], /Max-Age=86400/i, 'token login cookie should include Max-Age');

    const splitAsset304 = await request(port, 'GET', '/chat/bootstrap.js', null, {
      'If-None-Match': splitAsset.headers.etag,
    });
    assert.equal(splitAsset304.status, 304, 'split asset should support conditional GETs');
    assert.equal(splitAsset304.text, '', '304 response should not include a body');

    const versionedSettingsUiAsset = await request(port, 'GET', '/chat/settings-ui.js?v=test-build');
    assert.equal(versionedSettingsUiAsset.status, 200, 'versioned settings ui asset should load');
    assert.equal(
      versionedSettingsUiAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned settings ui asset should be immutable cache hits',
    );

    const versionedSessionSurfaceUiAsset = await request(port, 'GET', '/chat/session-surface-ui.js?v=test-build');
    assert.equal(versionedSessionSurfaceUiAsset.status, 200, 'versioned session surface ui asset should load');
    assert.equal(
      versionedSessionSurfaceUiAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned session surface ui asset should be immutable cache hits',
    );

    const loader = await request(port, 'GET', '/chat.js');
    assert.equal(loader.status, 200, 'compatibility loader should still exist');
    assert.ok(loader.headers.etag, 'compatibility loader should expose an ETag');

    const loader304 = await request(port, 'GET', '/chat.js', null, {
      'If-None-Match': loader.headers.etag,
    });
    assert.equal(loader304.status, 304, 'loader should also support conditional GETs');
  } finally {
    try { ownerWs?.close(); } catch {}
    try { visitorWs?.close(); } catch {}
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

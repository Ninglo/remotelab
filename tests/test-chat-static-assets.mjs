#!/usr/bin/env node
import assert from 'assert/strict';
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
        appId: 'shared-app',
        sessionId: 'visitor-session-id',
        visitorId: 'visitor-123',
      },
    }, null, 2),
    'utf8',
  );

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

  try {
    const authMe = await request(port, 'GET', '/api/auth/me');
    assert.equal(authMe.status, 200, 'auth info endpoint should work for owner session');
    assert.equal(authMe.headers['set-cookie']?.length, 1, 'auth info should refresh a near-expiry auth cookie');
    assert.match(authMe.headers['set-cookie'][0], /SameSite=Lax/i, 'auth cookie should use SameSite=Lax for better PWA compatibility');
    assert.match(authMe.headers['set-cookie'][0], /Max-Age=86400/i, 'auth cookie should include an explicit Max-Age');
    const refreshedSessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    assert.ok(
      refreshedSessions['test-session']?.expiry > Date.now() + 23 * 60 * 60 * 1000,
      'auth info should extend server-side session expiry as a sliding session',
    );

    const page = await request(port, 'GET', '/');
    assert.equal(page.status, 200, 'chat page should render for owner session');
    assert.match(page.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(page.text, /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)">/);
    assert.match(page.text, /<meta name="theme-color" content="#1e1e1e" media="\(prefers-color-scheme: dark\)">/);
    assert.match(page.text, /@media \(prefers-color-scheme: dark\)/);
    assert.match(page.text, /window\.__REMOTELAB_BOOTSTRAP__ = \{"auth":\{"role":"owner"\}\};/);
    assert.match(page.text, /<script src="\/chat\/bootstrap\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="\/chat\/session-http\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="\/chat\/tooling\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="\/chat\/realtime\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="\/chat\/ui\.js(?:\?v=[^"]*)?"/);
    assert.match(page.text, /<script src="\/chat\/compose\.js(?:\?v=[^"]*)?"/);

    const visitorPage = await request(port, 'GET', '/?visitor=1', null, { Cookie: visitorCookie });
    assert.equal(visitorPage.status, 200, 'chat page should also render for visitor session');
    assert.match(
      visitorPage.text,
      /window\.__REMOTELAB_BOOTSTRAP__ = \{"auth":\{"role":"visitor","appId":"shared-app","sessionId":"visitor-session-id","visitorId":"visitor-123"\}\};/,
      'visitor page should inline auth bootstrap data from the server render',
    );
    assert.match(page.text, /<script src="\/chat\/init\.js(?:\?v=[^"]*)?"/);
    assert.doesNotMatch(page.text, /id="appFilterSelect"/);
    assert.match(page.text, /id="sourceFilterSelect"/);
    assert.match(page.text, /id="sessionAppFilterSelect"/);
    assert.match(page.text, /id="userFilterSelect"/);
    assert.match(page.text, /id="newAppBtn"/);
    assert.match(page.text, /id="settingsAppsList"/);
    assert.match(page.text, /id="tabBoard"/);
    assert.match(page.text, /id="boardPanel"/);
    assert.match(page.text, /id="settingsUsersList"/);
    assert.match(page.text, /id="newUserNameInput"/);
    assert.match(page.text, /id="createUserBtn"/);
    assert.match(page.text, /id="newAppNameInput"/);
    assert.match(page.text, /id="newAppToolSelect"/);
    assert.match(page.text, /id="newAppWelcomeInput"/);
    assert.match(page.text, /id="newAppSystemPromptInput"/);
    assert.match(page.text, /id="createAppConfigBtn"/);
    assert.match(page.text, /id="tabSettings"/);
    assert.doesNotMatch(page.text, /id="collapseBtn"/, 'desktop sidebar should no longer expose a collapse control');
    assert.doesNotMatch(page.text, /id="tabProgress"/);
    assert.doesNotMatch(page.text, /id="saveTemplateBtn"/);
    assert.doesNotMatch(page.text, /id="sessionTemplateSelect"/);
    assert.match(page.text, /<div class="app-shell">/, 'chat page should render inside a dedicated app shell');
    assert.match(page.text, /\.header-btn,\s*\.sidebar-tab,\s*\.sidebar-filter-select,\s*\.new-session-btn,\s*\.session-action-btn,\s*\.session-item,\s*\.folder-group-header,\s*\.archived-section-header\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent;/, 'sidebar interactions should suppress the mobile tap highlight flash');
    assert.match(page.text, /--app-height:\s*100dvh/);
    assert.match(page.text, /--keyboard-inset-height:\s*0px/);
    assert.match(page.text, /--sidebar-width-expanded:\s*min\(80vw, calc\(100vw - 240px\)\);/);
    assert.match(page.text, /body\.board-tab-expanded\s*\{[\s\S]*?--sidebar-width:\s*var\(--sidebar-width-expanded\);/, 'desktop board hover mode should widen the sidebar via CSS variables');
    assert.match(page.text, /\.board-column-attention\s*\{[\s\S]*?border-radius:\s*999px;/, 'board columns should surface a compact high-priority count');
    assert.match(page.text, /\.board-priority-pill\s*\{[\s\S]*?border-radius:\s*999px;/, 'board cards should render compact priority pills');
    assert.match(page.text, /\.app-shell\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\);/, 'app shell should reserve a fixed header row and a flexible body row');
    assert.match(page.text, /\.app-container\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(page.text, /\.chat-area\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto auto;[\s\S]*?min-height:\s*0;/, 'chat area should model content, queued panel, and composer as explicit rows');
    assert.match(page.text, /\.chat-area > \*\s*\{[\s\S]*?min-width:\s*0;/, 'chat-area grid children should be allowed to shrink horizontally instead of expanding the column');
    assert.match(page.text, /\.messages\s*\{[\s\S]*?min-height:\s*0;/);
    assert.match(page.text, /\.messages-inner\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/, 'message column should stay bound to the available chat width');
    assert.match(page.text, /\.input-resize-handle\s*\{[\s\S]*?margin:\s*0 calc\(var\(--chat-gutter\) \* -1\) 8px;/, 'resize handle should mirror the current chat gutter so it does not create horizontal overflow on mobile');
    assert.doesNotMatch(page.text, /\.sidebar-overlay\.collapsed/, 'desktop sidebar should no longer render a collapsed state');
    assert.match(page.text, /\.modal-backdrop\s*\{[\s\S]*?padding-left:\s*calc\(var\(--sidebar-width\) \+ 24px\);/, 'desktop modals should offset against the fixed-width sidebar');
    assert.match(page.text, /body\.keyboard-open \.messages/);
    assert.match(page.text, /body\.keyboard-open \.input-area/);
    assert.doesNotMatch(page.text, /--app-top-offset/);
    assert.ok(!page.text.includes('/chat.js?v='), 'chat page should not pin the chat frontend to a versioned URL');
    assert.match(page.text, /\/marked\.min\.js\?v=/, 'chat page should fingerprint marked.min.js alongside the split chat assets');
    assert.match(page.text, /\/manifest\.json\?v=/, 'chat page should fingerprint the manifest URL so installed PWAs refresh policy changes');
    assert.match(page.text, /title="Attach media"/, 'chat page should advertise media uploads in the composer');
    assert.match(page.text, /accept="image\/\*,video\/\*"/, 'chat page should allow both image and video selection');

    const manifest = await request(port, 'GET', '/manifest.json');
    assert.equal(manifest.status, 200, 'manifest should load');
    const manifestJson = JSON.parse(manifest.text);
    assert.equal(manifestJson.display, 'standalone', 'manifest should still advertise standalone install mode');
    assert.equal('orientation' in manifestJson, false, 'manifest should not force an orientation policy in the installed PWA shell');

    const loginPage = await request(port, 'GET', '/login', null, { Cookie: '' });
    assert.equal(loginPage.status, 200, 'login page should render without auth');
    assert.match(loginPage.text, /<meta name="color-scheme" content="light dark">/);
    assert.match(loginPage.text, /<meta name="theme-color" content="#f5f5f5" media="\(prefers-color-scheme: light\)">/);
    assert.match(loginPage.text, /<meta name="theme-color" content="#181818" media="\(prefers-color-scheme: dark\)">/);
    assert.match(loginPage.text, /@media \(prefers-color-scheme: dark\)/);

    const apps = await request(port, 'GET', '/api/apps');
    assert.equal(apps.status, 200, 'owner apps endpoint should be available');
    assert.match(apps.text, /"id":"chat"/);
    assert.match(apps.text, /"id":"email"/);
    assert.match(apps.text, /"id":"app_basic_chat"/);
    assert.match(apps.text, /"id":"app_create_app"/);
    assert.doesNotMatch(apps.text, /"id":"app_video_cut"/);
    assert.doesNotMatch(apps.text, /"id":"feishu"/);
    assert.doesNotMatch(apps.text, /"id":"github"/);
    assert.doesNotMatch(apps.text, /"id":"automation"/);

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
      appId: 'github',
      appName: 'GitHub',
    });
    assert.equal(createdGithub.status, 201, 'GitHub-scoped session should be creatable over HTTP');
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

    const githubOnly = await request(port, 'GET', '/api/sessions?appId=github');
    assert.equal(githubOnly.status, 200, 'app-filtered session list should load');
    assert.match(githubOnly.text, /"appId":"github"/);
    assert.match(githubOnly.text, /"appName":"GitHub"/);
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

    const sessionHttpAsset = await request(port, 'GET', '/chat/session-http.js');
    assert.equal(sessionHttpAsset.status, 200, 'session http asset should load');
    if (/getEffectiveSessionAppId\(/.test(sessionHttpAsset.text)) {
      assert.match(
        splitAsset.text,
        /function getEffectiveSessionAppId\(/,
        'bootstrap asset should define the effective app helper used by session-http',
      );
    }

    const versionedSplitAsset = await request(port, 'GET', '/chat/bootstrap.js?v=test-build');
    assert.equal(versionedSplitAsset.status, 200, 'versioned split chat asset should load');
    assert.equal(
      versionedSplitAsset.headers['cache-control'],
      'public, max-age=31536000, immutable',
      'versioned split assets should be immutable cache hits',
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

    const toolingAsset = await request(port, 'GET', '/chat/tooling.js');
    assert.equal(toolingAsset.status, 200, 'tooling asset should load');
    assert.match(toolingAsset.text, /document\.documentElement\.style\.setProperty\("--app-height"/);
    assert.match(toolingAsset.text, /document\.documentElement\.style\.setProperty\("--keyboard-inset-height"/);
    assert.match(toolingAsset.text, /function requestLayoutPass\(/);
    assert.match(toolingAsset.text, /window\.RemoteLabLayout = \{/);
    assert.match(toolingAsset.text, /window\.visualViewport\?\.addEventListener\("resize", \(\) => requestLayoutPass\("visual-viewport-resize"\)\)/);
    assert.doesNotMatch(toolingAsset.text, /window\.visualViewport\?\.addEventListener\("scroll"/);
    assert.match(toolingAsset.text, /function focusComposer\(/);
    assert.match(toolingAsset.text, /const modelResponseCache = new Map\(\);/);
    assert.match(toolingAsset.text, /async function fetchModelResponse\(/);

    const uiAsset = await request(port, 'GET', '/chat/ui.js');
    assert.equal(uiAsset.status, 200, 'ui asset should load');
    assert.match(uiAsset.text, /focusComposer\(\{ preventScroll: true \}\)/);
    assert.match(uiAsset.text, /requestLayoutPass\("composer-images"\)/);
    assert.match(uiAsset.text, /\/api\/media\//, 'ui asset should load persisted media attachments from the media route');

    const composeAsset = await request(port, 'GET', '/chat/compose.js');
    assert.equal(composeAsset.status, 200, 'compose asset should load');
    assert.match(composeAsset.text, /focusComposer\(\{ force: true, preventScroll: true \}\)/);
    assert.match(composeAsset.text, /window\.RemoteLabLayout\?\.subscribe/);

    const initAsset = await request(port, 'GET', '/chat/init.js');
    assert.equal(initAsset.status, 200, 'init asset should load');
    assert.match(initAsset.text, /typeof getBootstrapAuthInfo === "function"/);
    assert.match(initAsset.text, /loadInlineTools\(\{ skipModelLoad: true \}\)/);
    assert.match(initAsset.text, /bootstrapViaHttp\(\{ deferOwnerRestore: true \}\)/);

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

    const loader = await request(port, 'GET', '/chat.js');
    assert.equal(loader.status, 200, 'compatibility loader should still exist');
    assert.ok(loader.headers.etag, 'compatibility loader should expose an ETag');

    const loader304 = await request(port, 'GET', '/chat.js', null, {
      'If-None-Match': loader.headers.etag,
    });
    assert.equal(loader304.status, 304, 'loader should also support conditional GETs');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

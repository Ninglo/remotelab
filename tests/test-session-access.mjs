import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { scryptSync } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-session-access-'));
setIsolatedTestHome(home);
process.env.SECURE_COOKIES = '0';
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
const people = ['a', 'b', 'admin'].map((id, i) => ({ id, name: id, handle: id,
  credentials: [{ id: 'credential-' + id, type: 'token', token: String(i + 1).repeat(64) }],
  identities: [{ id: 'web-' + id, kind: 'web', realm: 'remotelab', subjectId: id },
    { id: 'feishu-' + id, kind: 'feishu', realm: 'test', subjectId: 'ou-' + id }] }));
const adminPassword = 'isolated-admin-password';
const adminSalt = Buffer.alloc(16, 7);
people.find(p => p.id === 'admin').credentials.push({ id: 'admin-password', type: 'password', username: 'admin', passwordHash: 'scrypt$16384$8$1$' + adminSalt.toString('hex') + '$' + scryptSync(adminPassword, adminSalt, 32, { N: 16384, r: 8, p: 1 }).toString('hex') });
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'a',
  administratorPersonIds: ['admin'], people, serviceToken: 'f'.repeat(64) }));
const ids = { a: 'a'.repeat(32), b: 'b'.repeat(32), group: 'c'.repeat(32), unknown: 'd'.repeat(32) };
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify(Object.entries(ids).map(([who, id]) => ({
  id, name: who + '-secret', folder: home, tool: 'codex', sourceId: 'web', created: new Date().toISOString(),
  ...(who === 'a' ? { initiatedByIdentityId: 'feishu-a' } : who === 'b' ? { initiatedByIdentityId: 'web-b' }
    : who === 'group' ? { groupFeed: true, initiatedByIdentityId: 'identity_system' } : {}),
}))));
const { handleRequest } = await import('../chat/router.mjs');
const { attachWebSocket } = await import('../chat/ws.mjs');
const { broadcastAll } = await import('../chat/ws-clients.mjs');
const { canReadSession } = await import('../chat/session-access.mjs');
const server = http.createServer((req, res) => void handleRequest(req, res).catch(error => {
  console.error(error); if (!res.headersSent) res.writeHead(500); res.end();
}));
const wss = attachWebSocket(server);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const cookies = {};
async function call(who, path, method = 'GET', body) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: {
    ...(cookies[who] ? { Cookie: cookies[who] } : { Authorization: `Bearer ${who === 'service' ? 'f'.repeat(64) : people.find(p => p.id === who).credentials[0].token}` }),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
try {
  const anonymous = await fetch(base + '/?session=' + ids.b + '&tab=sessions', { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(new URL(anonymous.headers.get('location'), base).searchParams.get('next'), '/?session=' + ids.b + '&tab=sessions');
  // Real token login creates the same cookies used by browsers; primary != admin.
  for (const p of people) {
    const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ type: 'token', token: p.credentials[0].token }) });
    assert.equal(res.status, 302); cookies[p.id] = res.headers.get('set-cookie').split(';')[0];
  }
  for (const who of ['a', 'b', 'admin', 'service']) {
    const result = await call(who, '/api/sessions'); assert.equal(result.status, 200);
    const visible = result.data.sessions.map(s => s.id);
    assert.deepEqual(visible.sort(), (['admin', 'service'].includes(who) ? Object.values(ids) : [ids[who]]).sort());
  }
  for (const route of [`/?session=${ids.b}`, `/api/sessions/${ids.b}`, `/api/sessions/${ids.b}?view=summary`,
    `/api/sessions/${ids.b}/events?filter=all`, `/api/sessions/${ids.b}/events/1/body`, `/api/sessions/${ids.b}/source-context`,
    `/api/sessions/${ids.b}/workboards`]) assert.equal((await call('a', route)).status, 403, route);
  assert.equal((await call('b', `/api/sessions/${ids.b}`)).status, 200);
  const deniedPage = await call('a', '/?session=' + ids.b);
  assert.match(deniedPage.data, /进入我的工作区/);
  assert.ok(!deniedPage.data.includes('b-secret'), 'denial page reveals no private Session details');
  assert.equal((await call('a', `/api/sessions/${ids.b}`, 'PATCH', { name: 'stolen' })).status, 403);
  assert.equal((await call('a', `/api/sessions/${ids.b}/share`, 'POST', {})).status, 403);
  for (const path of ['/api/monitoring/sessions', '/api/work-awareness', '/api/usage/session-totals', '/api/memory-context-view', '/api/source-delivery-issues', '/browser/']) assert.equal((await call('a', path)).status, 403, path);
  assert.equal((await call('a', '/api/people/admin/credentials', 'POST', { type: 'token' })).status, 403);
  assert.equal((await call('a', '/api/people/a/identities', 'POST', { identityId: 'web-admin' })).status, 403);
  assert.equal((await call('a', '/api/people')).data.people.length, 1);
  assert.equal((await call('admin', '/api/people')).data.people.length, 3);
  const refs = await call('a', '/api/sessions?view=refs');
  assert.deepEqual(refs.data.sessionRefs.map(s => s.id), [ids.a]);
  const { resolveOrCreateExternalIdentity, updateAuthDocument } = await import('../lib/auth-config.mjs');
  const impostor = await resolveOrCreateExternalIdentity({ kind: 'feishu', realm: 'test', subjectId: 'ou-impostor', displayName: 'admin', handleHint: 'admin' });
  assert.notEqual(impostor.personId, 'admin');
  await assert.rejects(updateAuthDocument(doc => { doc.administratorPersonIds.push('b'); }), { code: 'ADMINISTRATOR_PROCEDURE_REQUIRED' });
  assert.equal((await call('service', '/api/people/admin/credentials', 'POST', { type: 'token' })).status, 403);
  assert.equal((await call('admin', '/api/people/admin/credentials', 'POST', { type: 'token' })).status, 403);
  assert.equal((await call('service', '/api/people/admin/credentials/admin-password', 'DELETE')).status, 403);
  assert.equal((await call('service', '/api/people/b/identities', 'POST', { identityId: 'feishu-admin' })).status, 403);
  assert.equal((await call('service', '/api/admin/session-administrators', 'POST', {})).status, 403);
  assert.equal((await call('a', '/admin/session-administrators')).status, 403);
  assert.equal((await call('admin', '/admin/session-administrators')).status, 200);
  const adminPost = async (who, body, origin = base, useBearer = false) => {
    const res = await fetch(base + '/api/admin/session-administrators', { method: 'POST', headers: {
      ...(useBearer ? { Authorization: 'Bearer ' + people.find(p => p.id === who).credentials[0].token } : { Cookie: cookies[who] }),
      ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    const data = await res.json(); return { status: res.status, data };
  };
  const grant = { targetPersonId: 'b', action: 'grant', confirmation: 'b', reason: 'Isolated test administrator approval', password: adminPassword };
  assert.equal((await adminPost('a', grant)).status, 403);
  assert.equal((await adminPost('admin', grant, base, true)).status, 403);
  assert.equal((await adminPost('admin', grant, '')).status, 403);
  assert.equal((await adminPost('admin', grant, 'https://elsewhere.example')).status, 403);
  assert.equal((await adminPost('admin', { ...grant, confirmation: 'a' })).status, 400);
  assert.equal((await adminPost('admin', { ...grant, password: 'wrong' })).status, 403);
  const approved = await adminPost('admin', grant); assert.equal(approved.status, 200); assert(approved.data.auditId);
  assert((await call('b', '/api/sessions')).data.sessions.length > 1);
  const audit = JSON.parse(await readFile(join(config, 'administrator-changes', approved.data.auditId + '.json')));
  assert.equal(audit.status, 'applied'); assert.equal(audit.actorPersonId, 'admin'); assert.equal(audit.targetPersonId, 'b');
  assert(!JSON.stringify(audit).includes(adminPassword));
  assert.equal((await adminPost('admin', { ...grant, action: 'revoke' })).status, 200);
  assert.equal((await call('b', '/api/sessions')).data.sessions.length, 1, 'Role revocation cannot reuse the administrator list cache');
  assert.equal((await adminPost('admin', { ...grant, targetPersonId: 'admin', confirmation: 'admin', action: 'revoke' })).status, 409);
  // Audit failure must reject a grant before changing the account's role.
  await rm(join(config, 'administrator-changes'), { recursive: true });
  await writeFile(join(config, 'administrator-changes'), 'blocked audit directory');
  assert.equal((await adminPost('admin', grant)).status, 503);
  assert.equal((await call('b', '/api/auth/me')).data.person.administrator, false);
  await rm(join(config, 'administrator-changes'));
  const workspaceGrant = await fetch(base + '/api/feishu-web-workspace/grant', { method: 'POST', headers: { Cookie: cookies.a, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://chat.feishu.cn', nativeAccount: '1234567890123', confirm: true }) });
  assert.equal(workspaceGrant.status, 201, await workspaceGrant.text());
  const aSession = (await call('a', `/api/sessions/${ids.a}`)).data.session;
  assert(canReadSession({ personId: 'a', identityId: 'web-a' }, aSession));
  assert(canReadSession({ personId: 'a', identityId: 'feishu-a' }, aSession));
  assert(!canReadSession({ personId: 'b' }, aSession));
  const uploaded = await call('b', `/api/sessions/${ids.b}/assistant-messages`, 'POST', {
    text: 'B private attachment', attachments: [{ data: Buffer.from('B attachment secret').toString('base64'), mimeType: 'text/plain', originalName: 'secret.txt' }],
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  const attachments = uploaded.data.event.attachments || uploaded.data.event.images;
  assert(attachments?.length, JSON.stringify(uploaded.data.event));
  const filename = attachments[0].filename;
  assert.equal((await call('b', '/api/media/' + filename)).status, 200);
  assert.equal((await call('a', '/api/media/' + filename)).status, 403);
  assert.equal((await call('admin', '/api/media/' + filename)).status, 200);
  assert.equal((await call('a', `/api/sessions/${ids.a}/assistant-messages`, 'POST', { text: 'steal', attachments: [{ filename }] })).status, 403);
  const intent = await call('b', '/api/assets/upload-intents', 'POST', { sessionId: ids.b, originalName: 'private.txt', mimeType: 'text/plain', sizeBytes: 6 });
  assert.equal(intent.status, 200, JSON.stringify(intent.data));
  const assetId = intent.data.asset.id;
  assert.equal((await call('b', '/api/assets/' + assetId)).status, 200);
  for (const suffix of ['', '/download', '/upload', '/finalize']) {
    const method = ['/upload', '/finalize'].includes(suffix) ? 'POST' : 'GET';
    assert.equal((await call('a', '/api/assets/' + assetId + suffix, method, method === 'POST' ? {} : undefined)).status, 403);
  }
  assert.equal((await call('a', `/api/sessions/${ids.a}/assistant-messages`, 'POST', { text: 'steal asset', attachments: [{ assetId }] })).status, 403);
  const scheduled = await call('b', '/api/triggers', 'POST', { sessionId: ids.b, text: 'isolated future test', scheduledAt: new Date(Date.now() + 86400000).toISOString(), tool: 'codex' });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.data));
  const triggerId = scheduled.data.trigger.id;
  assert.equal((await call('a', '/api/triggers/' + triggerId)).status, 403);
  assert.equal((await call('a', '/api/triggers')).data.triggers.length, 0);
  assert.equal((await call('b', '/api/triggers')).data.triggers.length, 1);
  assert.equal((await call('admin', '/api/triggers/' + triggerId)).status, 200);
  const forbiddenTemplate = await call('a', '/api/triggers', 'POST', { sessionId: ids.a, text: 'forbidden', scheduledAt: new Date(Date.now() + 86400000).toISOString(), tool: 'codex', sessionTemplate: { folder: home, tool: 'codex', reuse: 'fixed_session', sessionId: ids.b } });
  assert.equal(forbiddenTemplate.status, 400);
  const search = await call('a', '/api/sessions/search?q=secret');
  assert.equal(search.status, 200); assert(search.data.sessions.every(s => s.id === ids.a));
  const created = await call('a', '/api/sessions', 'POST', { tool: 'codex', folder: home, name: 'owned', creatorIdentityId: 'web-b', initiatedByIdentityId: 'web-b' });
  assert.equal(created.status, 201, JSON.stringify(created.data)); assert.equal(created.data.session.creatorIdentityId, 'web-a');
  assert.equal((await call('b', '/api/sessions/' + created.data.session.id)).status, 403);
  assert.equal((await call('a', '/api/sessions', 'POST', { tool: 'codex', folder: home, sourceContext: { sender: { openId: 'ou-b' } } })).status, 403);
  const fork = await call('a', `/api/sessions/${ids.a}/fork`, 'POST', {});
  assert.equal(fork.status, 201); assert.equal(fork.data.session.creatorIdentityId, 'web-a');
  assert.equal((await call('a', `/api/sessions/${ids.a}/fork`, 'POST', { externalTriggerId: 'steal' })).status, 403);
  // Connector/executor access is distinct from a person's browser privileges.
  assert.equal((await call('service', `/api/sessions/${ids.group}/assistant-messages`, 'POST', { text: 'isolated connector result' })).status, 201);
  assert.equal((await call('a', `/api/sessions/${ids.group}/events`)).status, 403);
  const { WebSocket } = await import('ws');
  const aSocket = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: cookies.a } });
  await once(aSocket, 'open'); const hints = []; aSocket.on('message', msg => hints.push(JSON.parse(msg)));
  broadcastAll({ type: 'session_invalidated', sessionId: ids.b });
  const ownHint = new Promise(resolve => aSocket.on('message', raw => { const m = JSON.parse(raw); if (m.sessionId === ids.a) resolve(m); }));
  broadcastAll({ type: 'session_invalidated', sessionId: ids.a });
  await Promise.race([ownHint, new Promise((_, reject) => setTimeout(() => reject(Error('Missing own hint')), 3000))]);
  assert(!hints.some(m => m.sessionId === ids.b)); aSocket.close();
  if (process.env.REMOTELAB_TEST_PLAYWRIGHT_MODULE) {
    const { chromium } = await import(process.env.REMOTELAB_TEST_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ headless: true, ...(process.env.REMOTELAB_TEST_CHROMIUM_PATH ? { executablePath: process.env.REMOTELAB_TEST_CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
    try {
      for (const who of ['a', 'b', 'admin']) {
        const context = await browser.newContext(); const page = await context.newPage();
        await page.goto(base + '/login'); await page.click('#toggle-link'); await page.fill('#token-input', people.find(p => p.id === who).credentials[0].token);
        await Promise.all([page.waitForURL(base + '/'), page.click('#token-form button')]);
        const result = await page.evaluate(async () => (await fetch('/api/sessions')).json());
        assert(result.sessions.some(s => s.id === ids[who === 'admin' ? 'a' : who]));
        if (who === 'a') { const res = await page.goto(base + '/?session=' + ids.b); assert.equal(res.status(), 403); }
        if (who === 'admin') {
          await page.goto(base + '/admin/session-administrators');
          await page.selectOption('#target', 'b');
          await page.fill('#reason', 'Browser form isolated administrator verification');
          await page.fill('#confirmation', 'wrong-user'); await page.fill('#password', adminPassword);
          await page.click('#submit'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('exact target username'));
          assert.equal(await page.inputValue('#password'), '', 'Password is cleared on a failed confirmation');
          await page.fill('#confirmation', 'b'); await page.fill('#password', adminPassword);
          await page.click('#submit'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('审计编号'));
          assert.equal((await call('b', '/api/auth/me')).data.person.administrator, true);
          await page.waitForFunction(() => [...document.querySelector('#target').options].some(o => o.value === 'b' && o.textContent.includes('管理员')));
          await page.selectOption('#target', 'b'); await page.selectOption('#action', 'revoke');
          await page.fill('#confirmation', 'b'); await page.fill('#password', adminPassword);
          await page.click('#submit'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('审计编号'));
          assert.equal((await call('b', '/api/auth/me')).data.person.administrator, false);
          assert.equal(await page.inputValue('#password'), '');
        }
        await context.close();
      }
      console.log('Headless Chromium: three separate login contexts, lists, forbidden direct URL and reauthenticated administrator form passed');
    } finally { await browser.close(); }
  }
  console.log('Session access: HTTP login, lists, direct URLs, APIs, media, search, forged identity, forks, service and WS passed');
} finally {
  for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
process.exit(0);

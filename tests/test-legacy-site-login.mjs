import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'legacy-site-login-'));
setIsolatedTestHome(root); process.env.REMOTELAB_CONFIG_DIR = root;
const { handlePreviewProxy } = await import('../chat/preview-proxy.mjs');
const { legacySiteLogin } = await import('../lib/legacy-site-login.mjs');
const { runPreviewCommand } = await import('../lib/preview-command.mjs');
const { resolveSiteUsageSite } = await import('../chat/router-site-usage.mjs');
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
const realm = 'fixture-app', tenantKey = 'fixture-company';
await writeFile(join(root, 'site-login.json'), JSON.stringify({ realm, tenantKey, feishuConfigPath: join(root, 'unused.json') }));
const people = ['a', 'b'].map(n => ({ id: 'person_' + n, name: n, credentials: [], identities: [
  { id: 'identity_' + n, kind: 'feishu', realm, subjectId: 'open_' + n }] }));
await updateAuthDocument(d => d.people.push(...people));
const hash = v => createHash('sha256').update(v).digest('hex');
const sessions = Object.fromEntries(people.map((p, i) => [hash('cookie_' + i),
  { personId: p.id, openId: 'open_' + ['a', 'b'][i], realm, tenantKey, expiresAt: Date.now() + 86400000 }]));
await writeFile(join(root, 'qianyan-identity.json'), JSON.stringify({ pending: {}, sessions }));
let originalAuthorization = 'Basic ' + Buffer.from('shared:fixture-secret').toString('base64');
const upstream = http.createServer((req, res) => {
  if (req.headers.authorization !== originalAuthorization) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); res.end('original challenge'); return;
  }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ person: req.headers['x-remotelab-person-id'] || null, method: req.method }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const routes = { old: { port: upstream.address().port, postPaths: ['/save'], requestHeaders: ['x-fixture'], ownerPersonId: 'person_old' } };
await writeFile(join(root, 'preview-routes.json'), JSON.stringify(routes));
const server = http.createServer(async (req, res) => {
  try { await handlePreviewProxy(req, res, new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (headers = {}, options = {}) => fetch(base + '/preview/old/' + (options.path || ''), { ...options, headers, redirect: 'manual' });
try {
  await runPreviewCommand(['reuse-identity', '--slug', 'old']);
  const saved = JSON.parse(await readFile(join(root, 'preview-routes.json')));
  assert.deepEqual(saved.old, routes.old, 'identity overlay leaves the entire original route unchanged');
  const policy = JSON.parse(await readFile(join(root, 'site-identity-policies.json')));
  assert.deepEqual(policy.routes.old, { port: routes.old.port, reuseIdentity: true });
  assert.equal((await request()).status, 401);
  assert.equal((await request({ Authorization: originalAuthorization })).status, 200, 'original callers need no employee login');
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_0' })).status, 401, 'employee identity alone has no legacy-site grant');
  const res = await request({ Cookie: 'employee_site_session=cookie_0', Authorization: originalAuthorization });
  assert.equal(res.status, 200); assert.equal((await res.json()).person, people[0].id);
  await legacySiteLogin.flush();
  assert.equal(await legacySiteLogin.lookup('old', people[0].id, routes.old.port + 1), '', 'a replaced upstream cannot receive an old credential');
  const source = { headers: { referer: base + '/preview/old/', origin: base } };
  assert.equal(await resolveSiteUsageSite(source, { configDir: root, personId: people[0].id }), 'preview:old');
  assert.equal(await resolveSiteUsageSite(source, { configDir: root, personId: people[1].id }), null,
    'site usage of a private old site requires that Person’s own grant');
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_0' })).status, 200, 'previous original login is reused without another challenge');
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_1' })).status, 401, 'a second employee cannot borrow the first person’s grant');
  assert.equal((await request({ 'X-Remotelab-Person-Id': people[0].id })).status, 401);
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_0', Authorization: 'Basic invalid' })).status, 401, 'bad explicit credential never falls back to a saved one');
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_0', Origin: 'https://evil.test' }, { method: 'POST', path: 'save' })).status, 403);
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_0', Origin: base }, { method: 'POST', path: 'save' })).status, 200);
  assert.equal((await request({ Authorization: originalAuthorization }, { method: 'POST', path: 'save' })).status, 200, 'original authenticated writes remain unchanged');
  assert.equal((await stat(join(root, 'site-legacy-logins.json'))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(saved).includes('fixture-secret'), 'route metadata never contains the credential');
  originalAuthorization = 'Basic changed-upstream';
  assert.equal((await request({ Cookie: 'employee_site_session=cookie_0' })).status, 401, 'upstream revocation still takes effect');
  console.log('Legacy identity reuse: original access and writes preserved, per-person grants, no forgery or broadening, revocation and private persistence PASS');
} finally {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await rm(root, { recursive: true, force: true });
}

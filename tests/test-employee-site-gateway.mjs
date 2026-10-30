import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'employee-sso-gateway-'));
setIsolatedTestHome(root);
process.env.REMOTELAB_CONFIG_DIR = root;
process.env.REMOTELAB_PUBLIC_PAGES_DIR = join(root, 'pages');
const cfg = { provider: 'muka-sso-gateway', issuer: 'https://auth.example.test', publicOrigin: 'https://sites.example.test',
  appId: 'remotelab-sites', entryPermission: 'app.remotelab-sites.access', sourceKeyFile: join(root, 'source.key') };
const sourceKey = 'isolated-test-key-not-a-production-secret';
await writeFile(cfg.sourceKeyFile, sourceKey, { mode: 0o600 });
await writeFile(join(root, 'site-login.json'), JSON.stringify(cfg));
const auth = await import('../lib/auth-config.mjs');
const { registerEmployeeIdentity, researchSiteIdentity } = await import('../chat/employee-site-auth.mjs');
const { createSiteLoginHandler } = await import('../chat/router-site-login.mjs');
const { checkEmployeeStaticAccess } = await import('../chat/employee-static-access.mjs');
const { handlePreviewProxy } = await import('../chat/preview-proxy.mjs');
const { runPreviewCommand } = await import('../lib/preview-command.mjs');
const { isAuthenticated } = await import('../lib/auth.mjs');
const { resolveSitePolicy } = await import('../lib/site-publication-policy.mjs');
const { createManagedSiteIdentity } = await import('../lib/managed-site-identity.mjs');
const employee = { kind: 'muka-sso', realm: cfg.issuer, openId: 'user:fixture-1', name: '测试员工' };
const p = await registerEmployeeIdentity(employee);
assert.equal((await registerEmployeeIdentity(employee)).id, p.id);
assert.notEqual((await registerEmployeeIdentity({ ...employee, kind: 'feishu' })).id, p.id, 'names never merge provider identities');
assert.deepEqual((await auth.loadAuthDocument()).people.find(x => x.id === p.id).credentials, []);
const policy = await resolveSitePolicy({ ownerPersonId: p.id });
assert.equal(policy.access, 'employee'); assert.equal(policy.ownerPersonId, p.id); assert.deepEqual(policy.adminPersonIds, []);
for (const slug of ['a', 'b']) {
  await mkdir(join(root, 'pages', slug), { recursive: true });
  await writeFile(join(root, 'pages', slug, '_remote_publish.json'), JSON.stringify(policy));
}
const identityHeaders = { 'x-muka-source-key': sourceKey, 'x-muka-user-id': employee.openId, 'x-muka-platform-role': 'member',
  'x-muka-permissions': cfg.entryPermission, 'x-muka-user-profile': Buffer.from(JSON.stringify({ id: employee.openId, displayName: employee.name })).toString('base64url'),
  'x-forwarded-host': 'sites.example.test', 'x-forwarded-proto': 'https' };
const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
await runPreviewCommand(['expose', '--slug', 'dynamic', '--port', String(upstream.address().port), '--owner', p.id, '--post-path', '/save']);
const login = createSiteLoginHandler();
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, cfg.publicOrigin).pathname;
    if (await login(req, res, path)) return;
    if (await checkEmployeeStaticAccess(req, res, path)) return;
    if (await handlePreviewProxy(req, res, path)) return;
    if (path === '/api/auth/me') { res.writeHead(await isAuthenticated(req) ? 200 : 401); res.end(); return; }
    res.writeHead(200); res.end('isolated protected fixture');
  } catch { res.writeHead(503); res.end('unavailable'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (path, headers = {}, options = {}) => fetch(base + path, { redirect: 'manual', ...options, headers });
try {
  for (const path of ['/public-pages/a/index.html', '/public-pages/b/private.json', '/preview/dynamic/', '/api/site-login/me']) {
    assert.equal((await request(path)).status, 401);
    for (const altered of [ { 'x-muka-source-key': '' }, { 'x-muka-source-key': sourceKey.replace('isolated', 'attacker') },
      { 'x-forwarded-host': 'unregistered.test' }, { 'x-forwarded-proto': 'http' }, { 'x-muka-permissions': 'app.hub.access' },
      { 'x-muka-user-profile': Buffer.from('{"id":"other","displayName":"伪造"}').toString('base64url') } ]) {
      assert.equal((await request(path, { ...identityHeaders, ...altered })).status, 401, `reject ${Object.keys(altered)[0]}`);
    }
    const valid = await request(path, identityHeaders);
    assert.equal(valid.status, 200); assert.equal(valid.headers.get('set-cookie'), null, 'do not mint a second session');
  }
  const forwarded = await (await request('/preview/dynamic/', { ...identityHeaders, cookie: 'fixture', authorization: 'Bearer forged', 'x-remotelab-person-id': 'forged' })).json();
  assert.equal(forwarded['x-remotelab-person-id'], p.id);
  for (const key of ['cookie', 'authorization', ...Object.keys(identityHeaders)]) assert.equal(forwarded[key], undefined, `no upstream leak: ${key}`);
  assert.equal((await request('/preview/dynamic/save', { ...identityHeaders, origin: 'https://evil.test' }, { method: 'POST' })).status, 403);
  assert.equal((await request('/preview/dynamic/save', { ...identityHeaders, origin: cfg.publicOrigin }, { method: 'POST' })).status, 200);
  assert.equal((await request('/api/auth/me', identityHeaders)).status, 401, 'employees do not enter the control plane');
  assert.equal((await request('/api/auth/me', { ...identityHeaders, 'x-muka-platform-role': 'platform_admin' })).status, 401, 'company admins do not become console admins');
  assert.equal((await request('/site-login')).status, 503, 'unconnected ingress must not redirect forever');
  const back = await request('/site-login?returnTo=%2Fpublic-pages%2Fa%2F%3Fx%3D1', identityHeaders);
  assert.equal(back.status, 303); assert.equal(back.headers.get('location'), '/public-pages/a/?x=1');
  assert.equal((await request('/site-login?returnTo=https://evil.test', identityHeaders)).headers.get('location'), null);
  assert.equal((await request('/site-login?returnTo=%2F%2Fevil.test', identityHeaders)).headers.get('location'), null);
  assert.equal((await request('/api/site-login/logout', { ...identityHeaders, origin: 'https://evil.test' }, { method: 'POST' })).status, 403);
  const logout = await (await request('/api/site-login/logout', { ...identityHeaders, origin: cfg.publicOrigin }, { method: 'POST' })).json();
  assert.equal(logout.state, 'redirect'); assert.equal(logout.redirect_url, cfg.issuer + '/sso/logout/start?app=remotelab-sites');
  const before = await readFile(join(root, 'auth.json'), 'utf8');
  const requestObject = { headers: identityHeaders };
  const restored = createManagedSiteIdentity({ configDir: root, authDocument: auth.loadAuthDocument, registerIdentity: registerEmployeeIdentity });
  assert.equal((await restored.member(requestObject, null)).id, p.id, 'gateway session remains usable across application restart');
  assert.equal(await readFile(join(root, 'auth.json'), 'utf8'), before, 'repeat requests do not write identities');
  assert.equal(await restored.member({ headers: { cookie: 'employee_site_session=old', 'x-forwarded-host': 'sites.example.test' } }, { personId: p.id, authKind: 'remotelab' }), null, 'old cookies and console login do not bypass gateway');
  await writeFile(join(root, 'qianyan-internal.json'), JSON.stringify({ realm: 'legacy-research', tenantKey: 'fixture-company', personIds: [p.id] }));
  assert.equal((await researchSiteIdentity.member({ headers: {} }, { personId: p.id, authKind: 'remotelab' })).id, p.id, 'separate research login retains its own configuration');
  assert.equal((await request('/public-pages/a/index.html', {})).status, 401, 'identity is not cached after the gateway stops vouching');
  await writeFile(cfg.sourceKeyFile, 'rotated-fixture-key-with-at-least-32-characters');
  assert.equal((await request('/public-pages/a/index.html', identityHeaders)).status, 401, 'key rotation rejects previous gateway key');
  await writeFile(cfg.sourceKeyFile, 'short');
  assert.equal((await request('/public-pages/a/index.html', identityHeaders)).status, 503);
  await writeFile(join(root, 'site-login.json'), JSON.stringify({ ...cfg, provider: 'unknown' }));
  assert.equal((await request('/api/site-login/me', identityHeaders)).status, 503);
  await writeFile(join(root, 'site-login.json'), JSON.stringify({ ...cfg, enabled: false }));
  assert.equal((await request('/api/site-login/me', identityHeaders)).status, 503);
  console.log('Muka gateway adapter PASS: shared sites, stable identity, forged-header rejection, expiry boundary, key rotation, return URL, logout, CSRF, proxy secret stripping, no console access. Gateway/provider fixtures only.');
} finally {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  await rm(root, { recursive: true, force: true });
}

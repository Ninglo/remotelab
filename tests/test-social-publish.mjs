import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { prepare, splitX, xWeight, sealImages, publish, saveSettings, settings, personDir, writeJson, hash, withPersonLock } from '../skills/social-publish/scripts/publisher.mjs';
import { createBindingServer } from '../skills/social-publish/scripts/binding-server.mjs';
import { cardPages } from '../skills/social-publish/scripts/render-cards.mjs';

const person = 'person_publisher_test', source = { sessionId: 'test-session', messageId: 'test-message' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'social-publish-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, 'image.png'); await writeFile(image, 'test-image');
  const m = await sealImages(prepare({ personId: person, source, authorization: 'publish', platforms: { x: { text: '一次发布的内容' }, xiaohongshu: { title: '本地测试', content: '这条不会发到真实平台。', images: [image] } } }));
  await saveSettings(person, { x: { apiKey: 'mock-private-buffer-key', channelId: 'x-channel', organizationId: 'org' }, xiaohongshu: { baseUrl: 'http://127.0.0.1:18061', token: 'mock-token', accountId: 'xhs-account' } }, root);
  const counts = { x: 0, xhs: 0 }; const state = { xhsVisible: true, loseXhs: false, rejectXhs: false, xhsWrong: false, xError: false, channelId: 'x-channel', accountId: 'xhs-account' };
  const response = data => ({ ok: true, status: 200, json: async () => data });
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.buffer.com') {
      const d = JSON.parse(options.body);
      if (d.query.includes('account {')) return response({ data: { account: { organizations: [{ id: 'org', name: 'Test' }] } } });
      if (d.query.includes('channels(')) return response({ data: { channels: [{ id: state.channelId, name: 'test-x', service: 'twitter' }] } });
      if (d.query.includes('createPost(')) {
        counts.x++; assert.equal(d.variables.input.metadata?.twitter?.thread?.[0]?.text || d.variables.input.text, d.variables.input.text);
        if (state.xError) return response({ errors: [{ message: 'ambiguous resolver failure' }] });
        return response({ data: { createPost: { post: { id: 'buffer-post' } } } });
      }
      if (d.query.includes('post(input:')) return response({ data: { post: { id: 'buffer-post', text: m.platforms.x.thread[0], status: m.publishAt ? 'buffer' : 'sent', dueAt: m.publishAt, externalLink: 'https://x.com/test/status/100' } } });
    }
    const path = new URL(url).pathname;
    if (path.endsWith('/login/status')) return response({ success: true, data: { is_logged_in: true, user_id: state.accountId, username: 'test-xhs' } });
    if (path.endsWith('/login/qrcode')) return response({ success: true, data: { is_logged_in: false, img: 'data:image/png;base64,AA==', timeout: '4m0s' } });
    if (path.endsWith('/user/me')) return response({ success: true, data: { feeds: [{ id: 'old-note', noteCard: { displayTitle: '本地测试' } }, ...(counts.xhs && state.xhsVisible ? [{ id: 'new-note', xsecToken: 'test-token', noteCard: { displayTitle: m.platforms.xiaohongshu.title } }] : [])] } });
    if (path.endsWith('/publish')) { counts.xhs++; if (state.rejectXhs) return { ok: false, status: 400 }; if (state.loseXhs) throw new Error('socket disconnected after submit'); return response({ success: true, data: { status: '发布完成' } }); }
    if (path.endsWith('/feeds/detail')) return response({ success: true, data: { note: { title: m.platforms.xiaohongshu.title, desc: m.platforms.xiaohongshu.content + (state.xhsWrong ? '额外的不同内容' : ''), user: { userId: 'xhs-account' }, time: Date.now() } } });
    throw new Error('Unexpected mock request ' + url);
  };
  return { root, image, m, counts, state, fetchImpl };
}

test('Chinese and URLs split without losing text; multiline cards preserve all content', () => {
  const text = '消息中的中文内容。'.repeat(60) + ' https://example.com/' + 'a'.repeat(400);
  const parts = splitX(text); assert.equal(parts.join(''), text); assert.ok(parts.every(p => xWeight(p) <= 280));
  const body = '第一行\n第二行\n'.repeat(30); assert.equal(cardPages(body).join(''), body); assert.ok(cardPages(body).length > 1);
  assert.throws(() => prepare({ personId: '../other', source, platforms: { x: { text: 'x' } } }));
  assert.throws(() => prepare({ personId: person, source, platforms: { zhihu: { text: 'x' } } }), /知乎/);
});
test('explicit authorization and all required bindings are checked before any write', async t => {
  const f = await fixture(t); const draft = structuredClone(f.m); delete draft.authorization;
  await assert.rejects(publish(draft, f), /发布授权/);
  await saveSettings(person, { x: {} }, f.root);
  await assert.rejects(publish(f.m, f), /X 尚未绑定/); assert.deepEqual(f.counts, { x: 0, xhs: 0 });
});
test('receipt readback verifies both platforms and repeat execution sends neither again', async t => {
  const f = await fixture(t); const r = await publish(f.m, f);
  assert.equal(r.platforms.x.status, 'sent'); assert.equal(r.platforms.xiaohongshu.status, 'sent');
  await publish(f.m, f); assert.deepEqual(f.counts, { x: 1, xhs: 1 });
  const mode = (await stat(join(personDir(person, f.root), 'receipts', f.m.jobId + '.json'))).mode & 0o777; assert.equal(mode, 0o600);
});
test('lost response remains uncertain until readback, with no resend while the other platform succeeded', async t => {
  const f = await fixture(t); f.state.loseXhs = true; f.state.xhsVisible = false;
  const first = await publish(f.m, f); assert.equal(first.platforms.x.status, 'sent'); assert.equal(first.platforms.xiaohongshu.status, 'uncertain');
  await publish(f.m, f); assert.deepEqual(f.counts, { x: 1, xhs: 1 });
  f.state.xhsVisible = true;
  const recovered = await publish(f.m, { ...f, readOnly: true }); assert.equal(recovered.platforms.xiaohongshu.status, 'sent'); assert.deepEqual(f.counts, { x: 1, xhs: 1 });
});
test('ambiguous GraphQL mutation error cannot be treated as safe to resend', async t => {
  const f = await fixture(t); f.state.xError = true;
  const r = await publish(f.m, f); assert.equal(r.platforms.x.status, 'uncertain');
  await publish(f.m, { ...f, retryRejected: true }); assert.equal(f.counts.x, 1);
});
test('changed account, image or previously submitted payload stops publishing', async t => {
  const f = await fixture(t); f.state.accountId = 'other-account';
  await assert.rejects(publish(f.m, f), /账号/); assert.equal(f.counts.x, 0);
  f.state.accountId = 'xhs-account'; await writeFile(f.image, 'replaced');
  await assert.rejects(publish(f.m, f), /配图发生变化/); assert.equal(f.counts.x, 0);
  await writeFile(f.image, 'test-image'); await publish(f.m, f);
  const changed = structuredClone(f.m); changed.platforms.x.thread[0] += 'changed';
  await assert.rejects(publish(changed, f), /内容已变/); assert.deepEqual(f.counts, { x: 1, xhs: 1 });
});
test('same title and a body that only starts with our content is not sufficient evidence', async t => {
  const f = await fixture(t); f.state.xhsWrong = true;
  const r = await publish(f.m, f); assert.equal(r.platforms.xiaohongshu.status, 'submitted');
});
test('scheduled acceptance is different from a public post', async t => {
  const f = await fixture(t); f.m.publishAt = new Date(Date.now() + 7200000).toISOString(); f.state.xhsVisible = false;
  const r = await publish(f.m, f); assert.equal(r.platforms.x.status, 'scheduled'); assert.equal(r.platforms.xiaohongshu.status, 'submitted');
});
test('repair only the explicitly rejected platform, retaining the old manifest and successful platform', async t => {
  const f = await fixture(t); f.state.rejectXhs = true;
  const first = await publish(f.m, f); assert.equal(first.platforms.x.status, 'sent'); assert.equal(first.platforms.xiaohongshu.status, 'rejected');
  const revised = structuredClone(f.m); revised.platforms.xiaohongshu.content += '修正。'; f.state.rejectXhs = false;
  const r = await publish(revised, { ...f, retryRejected: true });
  assert.deepEqual(f.counts, { x: 1, xhs: 2 }); assert.equal(r.revisions.length, 1); assert.equal(r.revisions[0].previousManifest.platforms.xiaohongshu.content, f.m.platforms.xiaohongshu.content);
  assert.equal(r.platforms.x.status, 'sent'); assert.equal(r.manifest.platforms.xiaohongshu.content, revised.platforms.xiaohongshu.content);
});
test('recovered dead-process lock does not permit resend of a persisted sending attempt', async t => {
  const f = await fixture(t); const dir = join(personDir(person, f.root), 'receipts'); await mkdir(dir);
  await writeJson(join(dir, f.m.jobId + '.json'), { jobId: f.m.jobId, fingerprint: hash(JSON.stringify(f.m)), platforms: { x: { status: 'sending', channelId: 'x-channel' }, xiaohongshu: { status: 'sending', accountId: 'xhs-account', beforeNoteIds: ['old-note'], startedAt: new Date().toISOString() } } });
  await writeJson(join(personDir(person, f.root), 'operation.lock'), { pid: 2147483647 });
  await publish(f.m, f); assert.deepEqual(f.counts, { x: 0, xhs: 0 });
});
test('person operation lock rejects concurrent publication', async t => {
  const f = await fixture(t);
  await withPersonLock(person, f.root, async () => { await assert.rejects(publish(f.m, f), /操作进行中/); });
});
test('binding page authenticates its owner, rejects CSRF and validates channel before persisting secrets', async t => {
  const f = await fixture(t), salt = Buffer.from('test-salt');
  const passwordHash = 'scrypt$16384$8$1$' + salt.toString('hex') + '$' + (await promisify(scrypt)('owner-password', salt, 32)).toString('hex');
  const authFile = join(f.root, 'auth.json'); await writeJson(authFile, { people: [{ id: person, credentials: [{ type: 'password', username: 'owner', passwordHash }] }, { id: 'person_other', credentials: [{ type: 'password', username: 'other', passwordHash }] }] });
  const server = await createBindingServer({ person, authFile, root: f.root, fetchImpl: f.fetchImpl }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`, auth = 'Basic ' + Buffer.from('owner:owner-password').toString('base64');
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('other:owner-password').toString('base64') } })).status, 401);
  const page = await (await fetch(url, { headers: { Authorization: auth } })).text(), csrf = page.match(/name="csrf" content="([^"]+)/)[1];
  const post = (route, body, extra = {}) => fetch(url + '/api/' + route, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('buffer/bind', { apiKey: 'mock-private-buffer-key' })).status, 403);
  assert.equal((await post('buffer/bind', { apiKey: 'mock-private-buffer-key', channelId: 'other', organizationId: 'org' }, { 'X-CSRF-Token': csrf })).status, 400);
  const r = await post('buffer/bind', { apiKey: 'mock-private-buffer-key', channelId: 'x-channel', organizationId: 'org' }, { 'X-CSRF-Token': csrf });
  assert.equal(r.status, 200); assert.ok(!(await r.text()).includes('mock-private-buffer-key'));
  assert.equal((await settings(person, f.root)).x.channelId, 'x-channel');
  assert.equal((await stat(join(personDir(person, f.root), 'settings.json'))).mode & 0o777, 0o600);
});

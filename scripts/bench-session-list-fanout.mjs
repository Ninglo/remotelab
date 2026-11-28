#!/usr/bin/env node
// Run only under run-with-clean-instance-env. All callers and data are local fixtures.
// Usage: node scripts/run-with-clean-instance-env.mjs node scripts/bench-session-list-fanout.mjs <checkout> <old|new> <tabs> <result.json> [messages] [intervalMs]
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { setIsolatedTestHome } from '../tests/isolate-test-environment.mjs';

const [checkout, mode, tabsArg, output, nArg = '4', gapArg = '30000', archivedPctArg = '0'] = process.argv.slice(2);
const tabs = Number(tabsArg), messages = Number(nArg), intervalMs = Number(gapArg), archivedPct = Number(archivedPctArg);
assert.ok(archivedPct >= 0 && archivedPct <= 100);
assert.ok(checkout && output && ['old', 'new'].includes(mode) && [20, 60].includes(tabs)
  && Number.isInteger(messages) && messages > 0 && intervalMs >= 0);
const commit = (await promisify(execFile)('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
const home = await mkdtemp(join(tmpdir(), 'remotelab-fanout-bench-'));
setIsolatedTestHome(home);
const config = join(home, '.config', 'remotelab'), bin = join(home, '.local', 'bin');
const ids = Array.from({ length: 7000 }, (_, n) => (n + 1).toString(16).padStart(32, '0'));
const sha = data => createHash('sha256').update(data).digest('hex');
const q = (rows, p) => rows.length ? [...rows].sort((a, b) => a - b)[Math.ceil(rows.length * p) - 1] : null;
const webCookie = 'session_token=bench-web', botCookie = 'session_token=bench-bot';
const route = 'synthetic-fanout';
const pending = new Set(), sockets = [], admission = [], rootLatency = [], loopSamples = [], errors = [];
let allGets = 0, pointGets = 0, refsGets = 0, bytes = 0, delivered = new Map(), admissions = new Map(), warm = true, child;
let serverLog = '', healthAt = '', sessionListFullLoads = 0, sessionListResponses = 0;
let started, childCpuStart = 0;
async function linuxCpuTicks() {
  try {
    const line = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    const fields = line.slice(line.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch { return 0; }
}
try {
  await Promise.all([bin, join(config, 'chat-sessions.json.records'), join(config, 'chat-history')].map(p => mkdir(p, { recursive: true })));
  await Promise.all([
    writeFile(join(config, 'auth.json'), JSON.stringify({ token: 'a'.repeat(64) })),
    writeFile(join(config, 'auth-sessions.json'), JSON.stringify({ 'bench-web': { expiry: Date.now() + 3600000, role: 'owner' },
      'bench-bot': { expiry: Date.now() + 3600000, role: 'owner', authKind: 'service' } })),
    writeFile(join(config, 'tools.json'), JSON.stringify([{ id: 'bench-codex', command: 'bench-codex', name: 'Synthetic runner', runtimeFamily: 'codex-json', models: [{ id: 'bench-model', label: 'Synthetic' }] }])),
    writeFile(join(bin, 'bench-codex'), `#!/usr/bin/env node
for (const event of [{ type:'thread.started', thread_id:'fake-thread' }, { type:'turn.started' }, {type:'item.completed',item:{type:'agent_message',text:'A synthetic response.'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) console.log(JSON.stringify(event));
`),
  ]);
  await chmod(join(bin, 'bench-codex'), 0o700);
  const records = {};
  for (let start = 0; start < ids.length; start += 32) {
    await Promise.all(ids.slice(start, start + 32).map(async (id, offset) => {
      const n = start + offset, created = new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString();
      const row = { id, name: `Synthetic conversation ${n}`, folder: home, tool: 'bench-codex', model: 'bench-model', created, updatedAt: created,
        archived: n >= 1050, sourceId: 'chat', description: 'Synthetic project context. '.repeat(64) };
      const text = JSON.stringify(row), hash = sha(text);
      records[id] = hash;
      const dir = join(config, 'chat-history', id);
      await mkdir(dir);
      await Promise.all([
        writeFile(join(config, 'chat-sessions.json.records', `${hash}.json`), text),
        writeFile(join(dir, 'meta.json'), JSON.stringify({ latestSeq: 0, counts: {}, lastEventAt: created })),
        writeFile(join(dir, 'context.json'), JSON.stringify({ summary: 'Synthetic summary. '.repeat(32), activeFromSeq: 0 })),
      ]);
    }));
  }
  await writeFile(join(config, 'chat-sessions.json'), JSON.stringify({ schema: 'session-catalog-v1', revision: 1, order: ids, records }));
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  assert.notEqual(port, 7696);
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['chat-server.mjs'], { cwd: resolve(checkout), env: { ...process.env, CHAT_PORT: String(port),
    CHAT_BIND_HOST: '127.0.0.1', SECURE_COOKIES: '0', REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER: '1',
    REMOTELAB_SESSION_STATE_CLASSIFIER: '0', PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { serverLog = (serverLog + chunk).slice(-12000); });
  async function req(path, { body, bot, tab, list, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const t = performance.now();
    const cached = tab?.cache.get(path);
    const res = await fetch(base + path, { method, headers: {
      Cookie: bot ? botCookie : webCookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cached?.etag && mode === 'new' ? { 'If-None-Match': cached.etag } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!warm && list) {
      bytes += Buffer.byteLength(text);
      if (list === 'full') allGets++; else if (list === 'ref') refsGets++; else pointGets++;
    }
    if (res.status === 304) return { data: cached.data, status: 304, ms: performance.now() - t };
    const data = res.headers.get('Content-Type')?.includes('application/json') && text ? JSON.parse(text) : null;
    if (tab && res.headers.get('etag')) tab.cache.set(path, { data, etag: res.headers.get('etag') });
    return { data, status: res.status, ms: performance.now() - t };
  }
  async function until(fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && child.exitCode === null) {
      const value = await fn(); if (value) return value;
      await sleep(100);
    }
    throw new Error(`Fixture did not reach expected state. ${serverLog}`);
  }
  await until(() => req('/api/auth/me').then(r => r.status === 200).catch(() => false), 20_000);
  const created = await req('/api/sessions', { bot: true, body: { folder: home, tool: 'bench-codex', model: 'bench-model', name: 'Benchmark input', sourceId: 'feishu',
    conversation: { connector: 'feishu', sourceRouteId: route, target: { chatType: 'p2p', conversationKind: 'main', chatId: 'synthetic-chat', tenantKey: 'synthetic' } } } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.session.id;
  const warmPath = mode === 'old' ? '/api/sessions' : '/api/sessions?withRefs=1';
  const initial = await req(warmPath);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.sessions.length, 1051);
  function track(work) {
    pending.add(work);
    void work.catch(error => errors.push(error.message)).finally(() => pending.delete(work));
  }
  const waitOpen = [];
  const archiveOpeners = Math.round(tabs * archivedPct / 100);
  if (archiveOpeners) await req(mode === 'old' ? '/api/sessions/archived' : '/api/sessions/archived?withRefs=1');
  for (let n = 0; n < tabs; n++) {
    const socket = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: webCookie } });
    sockets.push(socket);
    waitOpen.push(once(socket, 'open'));
    const tab = { cache: new Map(), versions: new Map((initial.data.sessionRefs || []).map(r => [r.id, r.summaryEtag])), dirty: new Set(), timer: null, global: false };
    socket.on('message', raw => {
      const msg = JSON.parse(raw);
      if (warm) return;
      if (mode === 'old') {
        if (msg.type === 'sessions_invalidated') {
          track(req('/api/sessions', { tab, list: 'full' }));
          if (n < archiveOpeners) track(req('/api/sessions/archived', { tab, list: 'full' }));
        }
        else if (msg.type === 'session_invalidated' && msg.sessionId) track(req(`/api/sessions/${msg.sessionId}?view=sidebar`, { tab, list: 'point' }));
        return;
      }
      if (!['session_invalidated', 'sessions_invalidated'].includes(msg.type)) return;
      if (msg.sessionId) tab.dirty.add(msg.sessionId); else tab.global = true;
      if (tab.timer) return;
      tab.timer = setTimeout(() => {
        tab.timer = null;
        const dirty = [...tab.dirty]; tab.dirty.clear();
        const global = tab.global; tab.global = false;
        track((async () => {
          if (global) {
            const { data } = await req('/api/sessions?view=refs', { tab, list: 'ref' });
            const next = new Map(data.sessionRefs.map(r => [r.id, r.summaryEtag]));
            dirty.splice(0, dirty.length, ...[...next].filter(([key, ver]) => tab.versions.get(key) !== ver).map(([key]) => key));
            tab.versions = next;
          }
          await Promise.all(dirty.map(key => req(`/api/sessions/${key}?view=sidebar`, { tab, list: 'point' })));
        })());
      }, 250);
    });
  }
  await Promise.all(waitOpen);
  // Drop warm-up metrics; only interval snapshots after the sample boundary are counted.
  const healthFile = join(config, 'runtime-health.json');
  async function sampleHealth() {
    let health;
    try { health = JSON.parse(await readFile(healthFile)); } catch { return; }
    if (health.observedAt === healthAt) return;
    healthAt = health.observedAt;
    if (warm) return;
    loopSamples.push(health.eventLoopP99Ms);
    if (Number.isInteger(health.sessionListFullLoads)) sessionListFullLoads += health.sessionListFullLoads;
    if (Number.isInteger(health.sessionListResponses)) sessionListResponses += health.sessionListResponses;
  }
  await sampleHealth();
  // Wait until the next completed interval so the startup full build does not
  // enter measured steady-state counters.
  const firstSample = healthAt;
  await until(async () => { await sampleHealth(); return healthAt && healthAt !== firstSample; }, 20_000);
  warm = false; started = performance.now(); childCpuStart = await linuxCpuTicks();
  let stop = false;
  const polling = (async () => {
    while (!stop) {
      await Promise.all([req('/').then(r => rootLatency.push(r.ms)).catch(e => errors.push(e.message)), sampleHealth()]);
      await sleep(100);
    }
  })();
  try {
    for (let n = 0; n < messages; n++) {
      if (n) await sleep(Math.max(0, (started + n * intervalMs) - performance.now()));
      const requestId = `feishu:bench-${n}`, target = { chatType: 'p2p', conversationKind: 'main', chatId: 'synthetic-chat', tenantKey: 'synthetic', messageId: `bench-${n}` };
      const r = await req(`/api/sessions/${id}/messages`, { bot: true, body: { requestId, text: `Synthetic message ${n}.`, tool: 'bench-codex', model: 'bench-model',
        feishuAdmissionOnly: true, sourceContext: { connector: 'feishu', sourceRouteId: route, ...target },
        sourceDelivery: { connector: 'feishu', sourceRouteId: route, target } } });
      assert.equal(r.status, 202, JSON.stringify(r.data));
      admissions.set(requestId, (admissions.get(requestId) || 0) + 1);
      admission.push(r.ms);
      // Exercise the legacy global work-awareness/pin fan-out while the input
      // remains in flight. The same operation is run unchanged in both arms.
      const pin = await req(`/api/sessions/${id}`, { method: 'PATCH', body: { pinned: n % 2 === 0 } });
      assert.equal(pin.status, 200, JSON.stringify(pin.data));
      await until(async () => {
        const r = await req('/api/source-deliveries/claim', { body: { connector: 'feishu', sourceRouteId: route } });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        const claim = r.data.claim;
        if (!claim) return false;
        const done = await req(`/api/source-deliveries/${claim.delivery.id}/complete`, { body: { leaseId: claim.leaseId, externalId: `fixture-${n}` } });
        assert.equal(done.status, 200, JSON.stringify(done.data));
        if (claim.delivery.kind !== 'content') return false;
        delivered.set(claim.delivery.responseId, (delivered.get(claim.delivery.responseId) || 0) + 1);
        return true;
      }, 45_000);
    }
    await sleep(700);
    await Promise.allSettled([...pending]);
    await sleep(10_000);
    await sampleHealth();
  } finally { stop = true; await polling; }
  const cpuTicks = (await linuxCpuTicks()) - childCpuStart;
  assert.equal(admissions.size, messages);
  assert.equal(delivered.size, messages);
  for (const [requestId, count] of admissions) { assert.equal(count, 1); assert.equal(delivered.get(requestId), 1); }
  const result = { commit, mode, tabs, messages, intervalMs, archiveOpeners, fixtureSessions: ids.length, activeSessions: initial.data.sessions.length,
    fullListGets: allGets, refsGets, sidebarGets: pointGets, fullListGetsPerMessage: allGets / messages,
    sidebarGetsPerMessagePerTab: pointGets / messages / tabs, listResponseBytes: bytes,
    sessionListFullLoads: mode === 'new' ? sessionListFullLoads : null, sessionListResponses: mode === 'new' ? sessionListResponses : null,
    rootP99Ms: q(rootLatency, .99), eventLoopP99MsP99: q(loopSamples.filter(Number.isFinite), .99),
    admissionP50Ms: q(admission, .5), admissionP90Ms: q(admission, .9), admissionMaxMs: q(admission, 1),
    rootSamples: rootLatency.length, eventLoopSamples: loopSamples.length, cpuTicks, elapsedMs: performance.now() - started,
    admissions: admissions.size, contentReceipts: delivered.size, errors };
  await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'close'), sleep(3000)]); }
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
  await rm(home, { recursive: true, force: true });
}

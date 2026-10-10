import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuApiLogger, feishuApiEndpoint } from '../lib/feishu-api-log.mjs';
import { createFeishuHttpInstance } from '../lib/feishu-http-client.mjs';

const root = await mkdtemp(join(tmpdir(), 'feishu-api-log-'));
const directory = join(root, 'logs');
const rows = async () => (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.jsonl'))
  .map(name => readFile(join(directory, name), 'utf8')))).join('').trim().split('\n').filter(Boolean).map(JSON.parse);
try {
  const logger = createFeishuApiLogger({ directory, appId: 'cli-fixture', sourceRouteId: 'bot-2', component: 'connector' });
  const calls = [];
  const transport = createFeishuHttpInstance({ request: async options => {
    calls.push(options);
    if (options.url.includes('/auth/')) return { code: 0, expire: 7200, tenant_access_token: 'private-token', app_access_token: 'private-token' };
    return { code: 0, data: { secret: 'private-response' }, log_id: 'provider-log-1' };
  } }, 30000, { logger });
  const client = new Lark.Client({ appId: 'cli-fixture', appSecret: 'private-secret', httpInstance: transport,
    loggerLevel: Lark.LoggerLevel.error });
  await client.request({ url: '/open-apis/drive/v1/files/private-doc/comments', method: 'GET',
    params: { query: 'private-query' }, data: { text: 'private-body' } });
  await transport.flushLog();
  let ledger = await rows();
  assert.equal(ledger.length, calls.length, 'auth and business SDK requests each have exactly one record');
  assert(ledger.some(row => row.endpoint.includes('/auth/') && row.method === 'POST'));
  assert(ledger.some(row => row.endpoint === '/open-apis/drive/v1/files/:id/comments' && row.logId === 'provider-log-1'));
  assert(ledger.every(row => row.appId === 'cli-fixture' && row.outcome === 'success'));
  assert.equal(feishuApiEndpoint('https://user:secret@open.feishu.cn/open-apis/im/v1/messages/om-private?text=private-query'),
    '/open-apis/im/v1/messages/:id');

  await createFeishuHttpInstance({ request: async () => ({ code: 99991672, msg: 'private-error',
    error: { log_id: 'permission-log' } }) }, 30000, { logger }).get('/open-apis/docx/v1/documents/private-doc');
  const forbidden = createFeishuHttpInstance({ request: async () => {
    throw Object.assign(new Error('private-error'), { code: 'ERR_BAD_REQUEST', config: { headers: { Authorization: 'private-token' } },
      response: { status: 403, headers: { 'retry-after': '60' }, data: { code: 99991672, msg: 'private-error' } } });
  } }, 30000, { logger });
  await assert.rejects(forbidden.get('/open-apis/drive/v1/files/private-doc'), error => {
    assert.equal(error.code, 99991672); assert.equal(error.retryAfterMs, 60000); return true;
  });

  let finishLate, markDispatched;
  const dispatched = new Promise(resolve => { markDispatched = resolve; });
  const controller = new AbortController();
  const hanging = createFeishuHttpInstance({ request: () => { markDispatched(); return new Promise(resolve => { finishLate = resolve; }); } },
    30000, { logger });
  const pending = hanging.get('/open-apis/im/v1/messages/om-private', { signal: controller.signal });
  await dispatched; controller.abort(); await assert.rejects(pending);
  finishLate({ code: 0 }); await Promise.resolve(); await Promise.resolve();
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(hanging.get('/should-not-dispatch', { signal: alreadyAborted.signal }));
  await logger.flush(); ledger = await rows();
  assert.equal(ledger.length, calls.length + 3, 'late completion and pre-dispatch cancellation do not double-count calls');
  assert.equal(ledger.filter(row => row.outcome === 'business_error').length, 1);
  assert.equal(ledger.filter(row => row.outcome === 'transport_error' && row.httpStatus === 403 && row.code === 99991672).length, 1);
  assert.equal(ledger.filter(row => row.outcome === 'aborted').length, 1);
  for (const secret of ['private-token', 'private-secret', 'private-body', 'private-response', 'private-query', 'private-doc', 'om-private', 'private-error'])
    assert(!JSON.stringify(ledger).includes(secret), `ledger must omit ${secret}`);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const usage = JSON.parse((await promisify(execFile)(process.execPath,
    ['scripts/feishu-api-usage.mjs', '--directory', directory, '--days', '7'])).stdout);
  assert.equal(usage.totals.calls, ledger.length); assert.equal(usage.totals.failed, 3);
  assert.equal(usage.byEndpoint.reduce((count, group) => count + group.calls, 0), ledger.length);

  const rotated = join(root, 'rotated'); await mkdir(rotated);
  await writeFile(join(rotated, '2020-01-01.123.abcdef.0.jsonl'), 'old');
  await writeFile(join(rotated, 'keep.txt'), 'unrelated');
  const rotation = createFeishuApiLogger({ directory: rotated, maxFileBytes: 500,
    now: () => new Date('2026-10-10T00:00:00Z') });
  for (let i = 0; i < 5; i++) await rotation.record({ ts: '2026-10-10T00:00:00Z', url: '/open-apis/bot/v3/info', outcome: 'success' });
  assert(!(await readdir(rotated)).includes('2020-01-01.123.abcdef.0.jsonl'));
  assert((await readdir(rotated)).filter(name => name.endsWith('.jsonl')).length > 1);
  assert.equal(await readFile(join(rotated, 'keep.txt'), 'utf8'), 'unrelated');

  const cannotWrite = join(root, 'ordinary-file'); await writeFile(cannotWrite, 'file');
  let warnings = 0;
  const failing = createFeishuApiLogger({ directory: cannotWrite, onError: () => { warnings++; throw new Error('warning failed'); } });
  const failOpen = createFeishuHttpInstance({ request: async () => ({ code: 0 }) }, 30000, { logger: failing });
  assert.equal((await failOpen.get('/open-apis/bot/v3/info')).code, 0); await failing.flush();
  assert.equal(warnings, 1);
  const throwing = createFeishuHttpInstance({ request: async () => ({ code: 0 }) }, 30000,
    { logger: { record() { throw new Error('logging bug'); } } });
  assert.equal((await throwing.get('/open-apis/bot/v3/info')).code, 0);
  const limited = createFeishuApiLogger({ directory: join(root, 'limited'), maxPending: 1, onError: () => {} });
  const first = limited.record({ url: '/open-apis/bot/v3/info' });
  assert.equal(await limited.record({ url: '/open-apis/bot/v3/info' }), false, 'overflow drops logs instead of blocking API handling');
  assert.equal(await first, true);
  console.log('Feishu API ledger: real SDK auth/business calls, exactly-once outcomes, privacy, aggregation, rotation and fail-open pass');
} finally { await rm(root, { recursive: true, force: true }); }

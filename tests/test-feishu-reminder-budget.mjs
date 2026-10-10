import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuUserReminders } from '../display/feishu-user-reminders.mjs';

const dir = await mkdtemp(join(tmpdir(), 'display-feishu-budget-'));
let clock = Date.parse('2026-10-10T08:00:00Z');
let failure = false;
let failureCode = 99991400;
let retryAfter = null;
let messageIds = ['om_old'];
const calls = [];
const reply = (json, status = 200) => ({ ok: status === 200, status,
  headers: { get: name => name === 'retry-after' ? retryAfter : null }, json: async () => json });
const fakeFetch = async (url, options) => {
  const parsed = new URL(url), path = parsed.pathname;
  calls.push(path);
  if (failure) return reply({ code: failureCode }, 429);
  if (path.endsWith('/messages/search')) return reply({ code: 0, data: { items: messageIds.map(id => ({ id,
    meta_data: { message_id: id, from_id: 'ou_other', is_p2p_chat: true, create_time: String(clock) } })), has_more: false } });
  if (path.endsWith('/messages/mget')) return reply({ code: 0, data: { items: parsed.searchParams.getAll('message_ids')
    .map(message_id => ({ message_id, deleted: false, body: { content: 'private-body' } })) } });
  if (path.endsWith('/messages/read_status')) return reply({ code: 0, data: { items: JSON.parse(options.body).message_ids
    .map(message_id => ({ message_id, is_read: message_id === 'om_old' })) } });
  if (path.endsWith('/calendars/primary')) return reply({ code: 0, data: { calendar_id: 'private-calendar' } });
  if (path.endsWith('/events/instance_view')) return reply({ code: 0, data: {} });
  throw new Error(`Unexpected fixture endpoint ${path}`);
};
try {
  await mkdir(join(dir, 'feishu-connectors', 'bot-2'), { recursive: true });
  await writeFile(join(dir, 'feishu-connectors', 'bot-2', 'config.json'), JSON.stringify({ appId: 'fixture-app', appSecret: 'private-secret' }));
  await mkdir(join(dir, 'display-private'));
  await writeFile(join(dir, 'display-private', 'feishu-reminders.json'), JSON.stringify({ version: 1,
    people: { person_a: { token: { realm: 'bot-2', openId: 'ou_expected', accessToken: 'private-token',
      expiresAt: clock + 7_200_000, scope: 'im:message:readonly search:message calendar:calendar:read calendar:calendar.event:read' } } } }));
  const service = createFeishuUserReminders({ configDir: dir, now: () => clock, fetchImpl: fakeFetch,
    identityFor: async () => ({ realm: 'bot-2', openId: 'ou_expected' }) });
  await service.summary('person_a');
  await service.calendarSummary('person_a');
  const baseline = calls.length;
  for (let i = 0; i < 149; i++) {
    clock += 2000;
    assert.equal(service.latest('person_a').connected, true);
    await service.summary('person_a');
  }
  assert.equal(calls.length, baseline, 'two-second frame reads spend no additional Feishu calls for five minutes');
  clock += 2000;
  assert.equal(service.latest('person_a').available, true, 'refreshing a cached connected snapshot does not falsely disconnect it');
  await service.summary('person_a');
  assert.equal(calls.length - baseline, 3, 'unchanged completed messages reuse details; only searches and read state recur');
  assert.equal(calls.filter(path => path.endsWith('/messages/mget')).length, 1);
  clock += 300_000;
  messageIds = ['om_new', ...messageIds];
  const arrival = await service.summary('person_a');
  assert.equal(arrival.newMessages, 1, 'new arrivals still alert at the next reconciliation');
  const beforeDismissal = calls.length;
  await service.acknowledge('person_a', arrival.observedAt);
  for (let i = 0; i < 20; i++) {
    await service.acknowledge('person_a', arrival.observedAt);
    assert.equal((await service.summary('person_a')).newMessages, 0);
  }
  assert.equal(calls.length, beforeDismissal, 'dismissal cannot bypass the refresh budget');
  assert.deepEqual((await service.summary('person_a')).sources, []);
  clock += 300_000;
  await service.calendarSummary('person_a');
  assert.equal(calls.filter(path => path.endsWith('/calendars/primary')).length, 2, 'calendars are refreshed every fifteen minutes');
  failure = true;
  retryAfter = '600';
  await service.summary('person_a');
  const failedCalls = calls.length;
  for (let i = 0; i < 149; i++) {
    clock += 2000;
    service.latest('person_a');
    assert.equal((await service.summary('person_a')).available, false);
  }
  assert.equal(calls.length, failedCalls, 'failed refreshes cannot turn frame reads into a retry storm');
  clock += 2000;
  await service.summary('person_a');
  assert.equal(calls.length, failedCalls, 'Retry-After pauses the next round without an outgoing request');
  clock += 599_999;
  await service.summary('person_a');
  assert.equal(calls.length, failedCalls, 'successive failures back off for ten minutes');
  clock++;
  await service.summary('person_a');
  assert(calls.length > failedCalls, 'the provider can be retried after the bounded backoff');
  failureCode = 99991403;
  const quotaService = createFeishuUserReminders({ configDir: dir, now: () => clock, fetchImpl: fakeFetch,
    identityFor: async () => ({ realm: 'bot-2', openId: 'ou_expected' }) });
  assert.equal((await quotaService.summary('person_a')).quotaBlocked, true);
  const quotaCalls = calls.length;
  clock += 60 * 60_000;
  assert.equal((await quotaService.summary('person_a')).quotaBlocked, true);
  await quotaService.calendarSummary('person_a');
  assert.equal(calls.length, quotaCalls, 'monthly quota exhaustion stops all message and calendar requests for the application');
  const logDir = join(dir, 'feishu-api-logs');
  const rows = (await Promise.all((await readdir(logDir)).filter(name => name.endsWith('.jsonl'))
    .map(name => readFile(join(logDir, name), 'utf8')))).join('').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, calls.length, 'every actual outgoing request is counted exactly once');
  assert(rows.every(row => row.component === 'display' && row.sourceRouteId === 'bot-2'));
  assert(rows.some(row => row.endpoint === '/open-apis/im/v1/messages/search' && row.outcome === 'failed'));
  assert(!JSON.stringify(rows).match(/private-(?:token|secret|body|calendar)|ou_expected|om_old/), 'the ledger contains no credentials or message data');
  console.log('ok - display provider budget, cached details, acknowledgement, backoff, and private call counts');
} finally { await rm(dir, { recursive: true, force: true }); }

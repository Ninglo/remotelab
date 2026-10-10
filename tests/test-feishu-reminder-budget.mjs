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
const scheduled = new Map();
let timerId = 0;
const schedule = (fn, ms) => { const id = ++timerId; scheduled.set(id, { fn, at: clock + ms }); return id; };
const cancel = id => scheduled.delete(id);
const reply = (json, status = 200) => ({ ok: status === 200, status,
  headers: { get: name => name === 'retry-after' ? retryAfter : null }, json: async () => json });
const fakeFetch = async (url, options) => {
  const parsed = new URL(url), path = parsed.pathname;
  calls.push(path);
  if (failure) return reply({ code: failureCode }, 429);
  if (path.endsWith('/oauth/token')) return reply({ access_token: 'private-token', refresh_token: 'private-refresh',
    expires_in: 7200, refresh_token_expires_in: 604800, scope: 'im:message:readonly search:message calendar:calendar:read calendar:calendar.event:read' });
  if (path.endsWith('/messages/search')) return reply({ code: 0, data: { items: messageIds.map(id => ({ id,
    meta_data: { message_id: id, from_id: 'ou_other', is_p2p_chat: true, create_time: String(clock) } })), has_more: false } });
  if (path.endsWith('/messages/mget')) return reply({ code: 0, data: { items: parsed.searchParams.getAll('message_ids')
    .map(message_id => ({ message_id, deleted: false, body: { content: 'private-body' } })) } });
  if (path.endsWith('/messages/read_status')) return reply({ code: 0, data: { items: JSON.parse(options.body).message_ids
    .map(message_id => ({ message_id, is_read: message_id === 'om_old' })) } });
  if (path.endsWith('/calendars/primary')) return reply({ code: 0, data: { calendar_id: 'private-calendar' } });
  if (path.endsWith('/events/instance_view')) return reply({ code: 0, data: { items: [
    { event_id: 'evt_due', summary: 'local-deadline', start_time: { timestamp: Math.floor(clock / 1000) + 31 * 60 } },
  ] } });
  throw new Error(`Unexpected fixture endpoint ${path}`);
};
try {
  await mkdir(join(dir, 'feishu-connectors', 'bot-2'), { recursive: true });
  await writeFile(join(dir, 'feishu-connectors', 'bot-2', 'config.json'), JSON.stringify({ appId: 'fixture-app', appSecret: 'private-secret' }));
  await mkdir(join(dir, 'display-private'));
  await writeFile(join(dir, 'display-private', 'feishu-reminders.json'), JSON.stringify({ version: 1,
    people: { person_a: { token: { realm: 'bot-2', openId: 'ou_expected', accessToken: 'private-token',
      refreshToken: 'private-refresh', refreshExpiresAt: clock + 7 * 86_400_000,
      expiresAt: clock + 86_400_000, scope: 'im:message:readonly search:message calendar:calendar:read calendar:calendar.event:read' } } } }));
  const service = createFeishuUserReminders({ configDir: dir, now: () => clock, fetchImpl: fakeFetch, schedule, cancel,
    identityFor: async () => ({ realm: 'bot-2', openId: 'ou_expected' }) });
  await service.refreshMessages('person_a');
  await service.refreshCalendar('person_a');
  const baseline = calls.length;
  for (let i = 0; i < 149; i++) {
    clock += 2000;
    assert.equal(service.latest('person_a').connected, true);
    await service.refreshMessages('person_a');
  }
  assert.equal(calls.length, baseline, 'two-second frame reads spend no additional Feishu calls for five minutes');
  clock += 2000;
  assert.equal(service.latest('person_a').available, true, 'refreshing a cached connected snapshot does not falsely disconnect it');
  await service.refreshMessages('person_a');
  assert.equal(calls.length - baseline, 3, 'unchanged completed messages reuse details; only searches and read state recur');
  assert.equal(calls.filter(path => path.endsWith('/messages/mget')).length, 1);
  clock += 300_000;
  messageIds = ['om_new', ...messageIds];
  const arrival = await service.refreshMessages('person_a');
  assert.equal(arrival.newMessages, 1, 'new arrivals still alert at the next reconciliation');
  const beforeDismissal = calls.length;
  await service.acknowledge('person_a', arrival.observedAt);
  for (let i = 0; i < 20; i++) {
    await service.acknowledge('person_a', arrival.observedAt);
    assert.equal((await service.refreshMessages('person_a')).newMessages, 0);
  }
  assert.equal(calls.length, beforeDismissal, 'dismissal cannot bypass the refresh budget');
  assert.deepEqual((await service.refreshMessages('person_a')).sources, []);
  clock += 300_000;
  await service.refreshCalendar('person_a');
  assert.equal(calls.filter(path => path.endsWith('/calendars/primary')).length, 2, 'calendars are refreshed every fifteen minutes');
  const quietCalls = calls.length;
  clock += 61_000;
  assert.equal(service.latest('person_a').calendar.due.length, 1, 'a calendar deadline is projected locally without an API call');
  for (let i = 0; i < 300; i++) {
    clock += 12_000;
    service.latest('person_a');
    await service.summary('person_a');
    await service.calendarSummary('person_a');
  }
  assert.equal(calls.length, quietCalls, 'expired cache, dashboard reads, and calendar deadlines cannot start a time loop');
  assert.equal(service.latest('person_a').stale, true);
  assert.equal(service.latest('person_a').available, false, 'an old partial snapshot is not presented as a verified current inbox');
  assert.equal(service.latest('person_a').coverage, 'partial');
  messageIds = ['om_event_new', ...messageIds];
  await service.notifyRealm('unrelated', { messages: clock });
  await service.idle();
  assert.equal(calls.length, quietCalls, 'events never cross application realms');
  await service.notifyRealm('bot-2', { calendar: { changedAt: clock, everyoneAt: 0, subjects: { unrelated: clock } } });
  await service.idle();
  assert.equal(calls.length, quietCalls, 'another calendar recipient does not wake this Person');
  await service.notifyRealm('bot-2', { messages: clock });
  await service.idle();
  const afterEvent = calls.length;
  assert.equal(service.latest('person_a').newMessages, 1, 'a change event wakes one message reconciliation');
  assert.equal(calls.filter(path => path.endsWith('/calendars/primary')).length, 2, 'message changes do not query calendars');
  await service.notifyRealm('bot-2', { messages: clock });
  assert.equal(calls.length, afterEvent, 'a replayed event already covered by the snapshot costs nothing');
  for (let i = 0; i < 30; i++) {
    clock += 1000;
    await service.notifyRealm('bot-2', { messages: clock });
  }
  assert.equal(scheduled.size, 1, 'a burst during the API cooldown has only one pending event deadline');
  assert.equal(calls.length, afterEvent);
  clock = [...scheduled.values()][0].at;
  for (const [id, timer] of scheduled) { scheduled.delete(id); timer.fn(); }
  await service.idle();
  assert(calls.length > afterEvent);
  assert.equal(scheduled.size, 0, 'finishing an event creates no recurring timer');
  const restarted = createFeishuUserReminders({ configDir: dir, now: () => clock, fetchImpl: fakeFetch,
    identityFor: async () => ({ realm: 'bot-2', openId: 'ou_expected' }) });
  const beforeRestore = calls.length;
  await restarted.restore();
  assert.equal(restarted.latest('person_a').newMessages, 1, 'restart retains the verified reminder snapshot');
  await restarted.notifyRealm('bot-2', { messages: clock - 1 });
  await restarted.idle();
  assert.equal(calls.length, beforeRestore, 'restoring snapshots and old change hints sends no API request');
  restarted.stop();
  clock += 300_000;
  failure = true;
  retryAfter = '600';
  await service.refreshMessages('person_a');
  const failedCalls = calls.length;
  for (let i = 0; i < 149; i++) {
    clock += 2000;
    service.latest('person_a');
    assert.equal((await service.refreshMessages('person_a')).available, false);
  }
  assert.equal(calls.length, failedCalls, 'failed refreshes cannot turn frame reads into a retry storm');
  clock += 2000;
  await service.refreshMessages('person_a');
  assert.equal(calls.length, failedCalls, 'Retry-After pauses the next round without an outgoing request');
  clock += 599_999;
  await service.refreshMessages('person_a');
  assert.equal(calls.length, failedCalls, 'successive failures back off for ten minutes');
  clock++;
  await service.refreshMessages('person_a');
  assert(calls.length > failedCalls, 'the provider can be retried after the bounded backoff');
  failureCode = 99991403;
  const quotaService = createFeishuUserReminders({ configDir: dir, now: () => clock, fetchImpl: fakeFetch,
    identityFor: async () => ({ realm: 'bot-2', openId: 'ou_expected' }) });
  assert.equal((await quotaService.refreshMessages('person_a')).quotaBlocked, true);
  const quotaCalls = calls.length;
  clock += 60 * 60_000;
  assert.equal((await quotaService.refreshMessages('person_a')).quotaBlocked, true);
  await quotaService.refreshCalendar('person_a');
  assert.equal(calls.length, quotaCalls, 'monthly quota exhaustion stops all message and calendar requests for the application');
  clock = Date.parse('2026-10-10T08:00:00Z') + 86_400_000 - 4 * 60_000;
  await quotaService.maintain();
  await quotaService.status('person_a');
  assert.equal(calls.length, quotaCalls, 'token maintenance and status reads cannot keep calling an exhausted application');
  const quotaRestarted = createFeishuUserReminders({ configDir: dir, now: () => clock, fetchImpl: fakeFetch,
    identityFor: async () => ({ realm: 'bot-2', openId: 'ou_expected' }) });
  await quotaRestarted.restore();
  await quotaRestarted.refreshMessages('person_a');
  await quotaRestarted.notifyRealm('bot-2', { messages: clock });
  await quotaRestarted.idle();
  assert.equal(calls.length, quotaCalls, 'a persisted monthly rejection remains fenced after restart and new events');
  failure = false;
  const resumed = await quotaRestarted.refresh('person_a', { quotaRestored: true });
  assert.equal(resumed.available, true, 'only an explicit operator restoration probe can resume the saved rejection');
  assert.equal(resumed.quotaBlocked, false);
  quotaRestarted.stop(); service.stop(); quotaService.stop();
  const logDir = join(dir, 'feishu-api-logs');
  const rows = (await Promise.all((await readdir(logDir)).filter(name => name.endsWith('.jsonl'))
    .map(name => readFile(join(logDir, name), 'utf8')))).join('').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, calls.length, 'every actual outgoing request is counted exactly once');
  assert(rows.every(row => row.component === 'display' && row.sourceRouteId === 'bot-2'));
  assert(rows.some(row => row.endpoint === '/open-apis/im/v1/messages/search' && row.outcome === 'failed'));
  assert(!JSON.stringify(rows).match(/private-(?:token|secret|body|calendar)|ou_expected|om_old/), 'the ledger contains no credentials or message data');
  console.log('ok - display provider budget, cached details, acknowledgement, backoff, and private call counts');
} finally { await rm(dir, { recursive: true, force: true }); }

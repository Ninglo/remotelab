import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuMeetingObserver } from '../connectors/feishu/meeting-observer.mjs';

const root = await mkdtemp(join(tmpdir(), 'meeting-observer-test-'));
const clock = Date.parse('2026-10-09T12:00:00Z');
const p = { enabled: true, appId: 'test-app', tenantKey: 'test-tenant', targets: [{
  meetingNo: '123456789', ownerOpenIds: ['ou_test'],
  notBefore: '2026-10-09T11:55:00Z', expiresAt: '2026-10-09T12:30:00Z',
}] };
const runtime = { config: { appId: p.appId, storageDir: root } };
const tasks = new Map(); let sequence = 0;
const schedule = (fn, ms) => { const n = ++sequence; tasks.set(n, { fn, ms }); return n; };
const cancel = n => tasks.delete(n);
const start = 'vc.meeting.all_meeting_started_v1';
const end = 'vc.meeting.all_meeting_ended_v1';
const envelope = (id, no = '123456789', tenant = p.tenantKey) => ({
  header: { event_id: `start-${id}`, tenant_key: tenant, app_id: p.appId },
  event: { meeting: { id, meeting_no: no, owner: { id: { open_id: 'ou_test' } }, topic: 'Test', start_time: String(clock / 1000) } },
});
const calls = [];
const transcript = { event_id: 'event-1', event_type: 'transcript_received', payload: {
  transcript_received_items: [{ text: '测试转写', start_time_ms: '1', speaker: { name: 'Test' } }],
} };
let page = 0;
const request = async args => {
  calls.push(args);
  if (args.method === 'POST') return { code: 0, data: { meeting: { id: '123456789000' } } };
  page++;
  return { code: 0, data: { events: [transcript], page_token: `page-${page}`, has_more: page === 1 } };
};
const create = req => createFeishuMeetingObserver(runtime, { now: () => clock, schedule, cancel, request: req });
try {
  const disabled = create(request);
  assert.equal(await disabled.restore(), false);
  await disabled.handle(start, envelope('123456789000'));
  assert.equal(calls.length, 0);
  await writeFile(join(root, 'meeting-observer-policy.json'), JSON.stringify(p));
  const worker = create(request); await worker.restore();
  await worker.handle(start, envelope('123456789000', '123456789', 'other-tenant'));
  assert.equal(calls.length, 0);
  await worker.handle(start, envelope('123456789001', '987654321'));
  await worker.idle(); assert.equal(calls.length, 0);
  const stale = envelope('123456789003'); stale.event.meeting.start_time = '1';
  await worker.handle(start, stale); await worker.idle(); assert.equal(calls.length, 0);
  await worker.handle(start, envelope('123456789000')); await worker.idle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(calls[0].data.action, undefined, 'never start the human meeting');
  assert.equal([...tasks.values()][0].ms, 0, 'drain available pages immediately');
  for (const [key, task] of [...tasks]) { tasks.delete(key); task.fn(); }
  await worker.idle();
  await worker.handle(start, envelope('123456789000')); await worker.idle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'duplicate delivery must not rejoin');
  let saved = JSON.parse(await readFile(join(root, 'meeting-observer', '123456789000.json')));
  assert.equal(saved.transcript.length, 1, 'page overlap must not duplicate utterances');
  assert.ok(saved.joinVerifiedAt);
  worker.stop();
  const resumed = create(request); await resumed.restore(); await resumed.idle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'restart only reads');
  resumed.stop();
  const finisher = create(request);
  const ended = envelope('123456789000'); ended.header.event_id = 'end'; ended.event.meeting.end_time = '1791547800';
  await finisher.handle(end, ended); await finisher.idle();
  saved = JSON.parse(await readFile(join(root, 'meeting-observer', '123456789000.json')));
  assert.equal(saved.captureStatus, 'ended_with_saved_events');
  assert.equal(saved.transcript.length, 1); finisher.stop();
  const denied = create(async args => { calls.push(args); return { code: 120002, msg: 'Enable AI Summary', error: { log_id: 'fixture-log-id' } }; });
  await denied.handle(start, envelope('123456789002')); await denied.idle();
  saved = JSON.parse(await readFile(join(root, 'meeting-observer', '123456789002.json')));
  assert.equal(saved.captureStatus, 'join_or_access_denied');
  assert.equal(saved.lastError.code, 120002);
  assert.equal(saved.lastError.logId, 'fixture-log-id');
  assert.equal(saved.joinVerifiedAt, undefined); denied.stop();
  await writeFile(join(root, 'meeting-observer-policy.json'), JSON.stringify({ ...p, appId: 'other-app' }));
  const wrongApp = create(request); assert.equal(await wrongApp.restore(), false);
  console.log('feishu meeting observer: tenant and target boundaries, join deduplication, restart, pagination, transcript retention and failure evidence passed');
} finally { await rm(root, { recursive: true, force: true }); }

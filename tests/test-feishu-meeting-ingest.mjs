import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuMeetingIngest, meetingIngestKey } from '../connectors/feishu/meeting-ingest.mjs';
import { createFeishuMeetingObserver } from '../connectors/feishu/meeting-observer.mjs';
import { createMeetingMaterialReader, transcriptLink, artifactToken } from '../connectors/feishu/meeting-materials.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const root = await mkdtemp(join(tmpdir(), 'meeting-ingest-'));
let clock = Date.parse('2026-10-15T16:00:00Z');
const runtime = { config: { storageDir: root, appId: 'cli_test', sourceRouteId: 'bot-2' } };
const p = { enabled: true, appId: 'cli_test', tenantKey: 'tenant', chatId: 'oc_target',
  documentBaseUrl: 'https://tenant.feishu.cn', notBefore: '2026-10-15T15:00:00Z' };
const policyPath = join(root, 'meeting-ingest-policy.json');
const discovery = id => ({ meetingId: id, appId: p.appId, tenantKey: p.tenantKey, topic: 'Meeting',
  startedAt: String(Math.floor((clock - 100000) / 1000)), endedAt: String(Math.floor(clock / 1000)), discoveryEvents: [] });
const messages = [], submissions = [], calls = [];
let materialMode = 'ready', sendMode = 'ok', failAdmission = false;
const material = id => ({ status: 'readable_transcript', transcriptPath: `/private/${id}.txt`, sourcePath: `/private/${id}.json`,
  transcriptUrl: 'https://tenant.feishu.cn/docx/transcript', minuteUrl: `https://tenant.feishu.cn/minutes/m${id}`,
  minuteToken: `m${id}`, sha256: 'hash', characters: 100 });
const readMaterials = async state => materialMode === 'ready' ? material(state.meetingId) : { status: materialMode };
const api = async args => {
  calls.push(args);
  if (args.method === 'POST') {
    if (sendMode === 'reject') throw Object.assign(new Error('permission denied'), { code: 99991672 });
    const item = { message_id: `om_${messages.length}`, thread_id: `omt_${messages.length}`, chat_id: p.chatId,
      sender: { sender_type: 'app', id: p.appId }, body: { content: args.data.content } };
    if (sendMode !== 'lost') messages.push(item);
    if (sendMode === 'ambiguous' || sendMode === 'lost') throw new Error('socket closed');
    return item;
  }
  if (args.url === '/open-apis/im/v1/messages') return { items: messages, has_more: false };
  return { items: messages.filter(m => args.url.endsWith(m.message_id)) };
};
const submit = async (summary, options) => {
  const prepared = options.prepared || { sessionId: 'session', payload: { requestId: `feishu:${summary.messageId}` }, receipt: {} };
  if (!options.prepared) await options.saveSubmission(prepared);
  submissions.push({ summary, prepared });
  if (failAdmission) { failAdmission = false; throw new Error('admission response lost'); }
  return { sessionId: 'session', requestId: prepared.payload.requestId, runId: 'run' };
};
const make = opts => createFeishuMeetingIngest(runtime, { api, readMaterials, submit, now: () => clock, ...opts });
const run = async w => { await w.tick(); await w.idle(); };
const state = (w, id) => w.store.get(meetingIngestKey(id));
const workers = [];
try {
  await writeDurableJson(policyPath, p);
  const w = make(); workers.push(w);
  assert.equal(await w.accept({ ...discovery('123456789001'), tenantKey: 'other' }), null);
  assert.equal(await w.accept({ ...discovery('123456789001'), endedAt: '1' }), null);
  assert.equal(await w.accept({ ...discovery('123456789001'), endedAt: undefined }), null);
  await w.accept(discovery('123456789001')); await run(w);
  assert.equal(messages.length, 1); assert.equal(submissions.length, 1);
  assert.equal((await state(w, '123456789001')).status, 'analysis_accepted');
  assert.equal(submissions[0].summary.sender.senderType, 'app', 'do not impersonate a human approver');
  assert.match(submissions[0].summary.messageText, /不执行会议拟行动/);
  await w.accept({ ...discovery('123456789001'), topic: 'enriched duplicate', discoveryEvents: ['extra'] }); await run(w);
  assert.equal(messages.length, 1); assert.equal(submissions.length, 1);
  w.stop();
  const resumed = make(); workers.push(resumed); await run(resumed);
  assert.equal(messages.length, 1, 'restart preserves dedup beyond UUID window');
  // A genuinely subsequent discovery enters automatically through the same observer callback.
  await writeDurableJson(join(root, 'meeting-observer-policy.json'), { enabled: true, appId: p.appId, tenantKey: p.tenantKey, targets: [] });
  const observer = createFeishuMeetingObserver(runtime, { onEnded: resumed.accept,
    request: async () => { throw new Error('attendance must remain disabled'); } });
  await observer.handle('vc.meeting.all_meeting_ended_v1', { header: { tenant_key: p.tenantKey, app_id: p.appId, event_id: 'new-end' },
    event: { meeting: { id: '123456789002', end_time: String(Math.floor(clock / 1000)), topic: 'Next meeting' } } });
  await observer.idle(); await run(resumed);
  assert.equal(messages.length, 2); observer.stop();
  materialMode = 'waiting_material';
  await resumed.accept(discovery('123456789003')); await run(resumed);
  assert.equal((await state(resumed, '123456789003')).complete, false);
  assert.equal(messages.length, 2);
  materialMode = 'ready'; clock += 60001; await run(resumed);
  assert.equal(messages.length, 3);
  materialMode = 'permission_denied';
  await resumed.accept(discovery('123456789004')); await run(resumed);
  const denied = await state(resumed, '123456789004'); assert.equal(denied.complete, true); assert.equal(denied.status, 'permission_denied');
  clock += 3600000; await run(resumed); assert.equal(messages.length, 3, 'denial never requests access or loops');
  materialMode = 'ready'; sendMode = 'ambiguous';
  await resumed.accept(discovery('123456789005')); await run(resumed);
  assert.equal(messages.length, 4);
  sendMode = 'ok'; clock += 5001; await run(resumed);
  assert.equal(messages.length, 4); assert.equal((await state(resumed, '123456789005')).status, 'analysis_accepted');
  sendMode = 'lost';
  await resumed.accept(discovery('123456789006')); await run(resumed);
  clock += 5001; await run(resumed);
  assert.equal((await state(resumed, '123456789006')).status, 'delivery_unknown');
  assert.equal((await state(resumed, '123456789006')).complete, true);
  assert.equal(messages.length, 4);
  sendMode = 'ok'; failAdmission = true;
  await resumed.accept(discovery('123456789007')); await run(resumed);
  const saved = await state(resumed, '123456789007'); assert.ok(saved.submission);
  clock += 5001; await run(resumed);
  assert.equal(messages.length, 5);
  assert.deepEqual(submissions.at(-1).prepared, submissions.at(-2).prepared, 'admission retries reuse immutable request');
  // A pause during material fetching must prevent the visible send.
  const pausing = make({ readMaterials: async d => { await writeDurableJson(policyPath, { ...p, enabled: false }); return material(d.meetingId); } }); workers.push(pausing);
  await pausing.accept(discovery('123456789008')); await run(pausing);
  assert.equal(messages.length, 5);
  await writeDurableJson(policyPath, p);
  // Alias dedup even if two discoveries point at the same Minutes token.
  const alias = make({ readMaterials: async () => material('123456789001') }); workers.push(alias);
  await alias.accept(discovery('123456789009')); await run(alias);
  assert.equal(messages.length, 5); assert.equal((await state(alias, '123456789009')).status, 'duplicate_material');
  // Missing materials exhaust a finite budget and retain their recovery packet.
  const pending = make({ readMaterials: async () => ({ status: 'waiting_material' }) }); workers.push(pending);
  await pending.accept(discovery('123456789010'));
  for (let n = 0; n < 12; n++) { clock += 16 * 60000; await run(pending); }
  assert.equal((await state(pending, '123456789010')).receipt.failed, true);
  assert.ok((await state(pending, '123456789010')).attempts <= 12);
  // Queue retry through the same mailbox used by the deployed process.
  await mkdir(join(root, 'meeting-ingest', 'commands'), { recursive: true });
  await mkdir(join(root, 'meeting-ingest', 'processed-commands'), { recursive: true });
  await writeDurableJson(join(root, 'meeting-observer', '123456789004.json'), discovery('123456789004'));
  await writeDurableJson(join(root, 'meeting-ingest', 'commands', 'a'.repeat(24) + '.json'), { action: 'retry', meetingId: '123456789004' });
  await resumed.commands(); await resumed.idle();
  assert.equal((await state(resumed, '123456789004')).status, 'analysis_accepted');
  assert.equal(messages.length, 6);
  assert.ok(calls.filter(c => c.method === 'POST').every(c => c.data.receive_id === p.chatId));
  assert.equal(artifactToken('https://evil.test/docx/token', 'docx'), '');
  assert.equal(transcriptLink('<a href="https://tenant.feishu.cn/docx/summary">summary</a>'), '');
  const reader = createMeetingMaterialReader(runtime, {
    api: async args => args.url.endsWith('/recording') ? { recording: { url: 'https://tenant.feishu.cn/minutes/minute' } } : { related_artifacts: {} },
    exportTranscript: async () => { throw Object.assign(new Error('permission deny'), { code: 2091005 }); },
    cli: async args => ({ document: { content: args.includes('https://tenant.feishu.cn/docx/note')
      ? '<p>AI summary</p><h1>文字记录</h1><a href="https://tenant.feishu.cn/docx/transcript">source</a>'
      : '<title>文字记录</title><p>speaker 00:00:01 hello</p><p>speaker 00:16:27 end</p>' } }),
  });
  const read = await reader(discovery('123456789011'), { noteUrl: 'https://tenant.feishu.cn/docx/note' });
  assert.equal(read.status, 'readable_transcript'); assert.equal(read.errors[0].code, 2091005);
  assert.equal((await readRecord(read.sourcePath)).transcriptUrl, 'https://tenant.feishu.cn/docx/transcript');
  console.log('meeting ingest: scope, observer handoff, subsequent event, retry, restart, material aliases, ambiguous send readback, durable admission, pause, limits and ACL fallback passed');
} finally { for (const w of workers) w.stop(); await rm(root, { recursive: true, force: true }); }

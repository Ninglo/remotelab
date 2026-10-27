import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMeetingScopeChecker } from '../connectors/feishu/meeting-scope.mjs';
import { createMeetingIntakeWriter, meetingIntakeKey } from '../connectors/feishu/meeting-intake.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'meeting-intake-'));
const id = '1234567890123456789';
const runtime = { config: { storageDir: root, appId: 'cli_test', sourceRouteId: 'test' }, botIdentity: { openId: 'ou_bot' } };
const discovery = { meetingId: id, appId: 'cli_test', tenantKey: 'tenant', endedAt: '1793094000', topic: 'Fixture meeting' };
const policy = { enabled: true, appId: 'cli_test', tenantKey: 'tenant', chatId: 'oc_target', notBefore: '2026-10-26T00:00:00Z',
  scope: { mode: 'source_group_or_organizer', organizerOpenIds: ['ou_authorized'],
    organizerNotBefore: '2026-10-27T09:28:24Z', userGroupLookup: true, groupMemberOpenIds: ['ou_member'] },
  intake: { root: join(root, 'intake'), scriptPath: '/existing/intake.py' }, recovery: { dailyRetry: true } };
let meeting = { id, start_time: '1793093900' }, inChat = false, searchCalls = 0, membershipFails = false;
const api = async args => {
  if (!args.url.endsWith('is_in_chat')) return { meeting };
  if (membershipFails) throw Error('Membership lookup unavailable');
  return { is_in_chat: inChat };
};
const checker = createMeetingScopeChecker(runtime, api, { cli: async args => {
  searchCalls++;
  assert.equal(args[0], 'vc', 'new policy must never use human group membership');
  return args.includes('--page-token') ? { items: [{ meeting_id: id }], has_more: false }
    : { items: [{ meeting_id: 'different' }], has_more: true, page_token: 'next' };
} });
try {
  meeting.participants = [{ id: 'ou_bot', first_join_time: '1793093900' }];
  assert.equal((await checker(policy, discovery)).allowed, false, 'attendance is not a new-policy admission rule');
  meeting.host_user = { id: 'ou_authorized' };
  assert.equal((await checker(policy, discovery)).allowed, false, 'host is not organizer');
  assert.equal((await checker(policy, { ...discovery, ownerOpenId: 'ou_authorized' })).allowed, false, 'caller owner claim is not evidence');
  meeting.owner = { id: 'ou_authorized' };
  assert.equal((await checker(policy, discovery)).reason, 'authorized_organizer');
  assert.equal((await checker(policy, { ...discovery, endedAt: '1793000000' })).allowed, false, 'organizer expansion does not replay history');
  meeting.owner = { id: 'ou_other' }; meeting.chat_id = 'oc_origin'; inChat = true;
  assert.equal((await checker(policy, discovery)).reason, 'source_group_member');
  inChat = false;
  assert.equal((await checker(policy, discovery)).allowed, false);
  assert.equal(searchCalls, 0, 'human members do not expand scope');
  delete meeting.owner; delete meeting.chat_id;
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), { ...discovery, ownerOpenId: 'ou_authorized' });
  assert.equal((await checker(policy, discovery)).evidence, 'observer_owner');
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), { ...discovery, appId: 'other', ownerOpenId: 'ou_authorized' });
  assert.equal((await checker(policy, discovery)).allowed, false);
  const searched = await checker({ ...policy, scope: { ...policy.scope, userOrganizerLookup: true } }, discovery);
  assert.equal(searched.evidence, 'provider_organizer_filtered_search');
  assert.equal(searchCalls, 2);
  meeting.chat_id = 'oc_origin'; membershipFails = true;
  assert.equal((await checker(policy, discovery)).reason, 'source_group_membership_unavailable');
  assert.equal((await checker({ ...policy, scope: { ...policy.scope, userOrganizerLookup: true } }, discovery)).allowed,
    true, 'a failed group lookup cannot suppress independent organizer evidence');
  membershipFails = false;
  assert.equal((await checker(policy, { ...discovery, endedAt: '1793000000' })).reason,
    'outside_source_group_and_organizers', 'pre-expansion personal meetings must not remain pending');
  meeting.id = 'wrong';
  assert.equal((await checker(policy, discovery)).allowed, false);

  const key = meetingIntakeKey('test', policy.chatId, id);
  const target = join(policy.intake.root, 'records', `${key}.json`);
  let conflict = false;
  const writer = createMeetingIntakeWriter(runtime, { exec: async (command, args) => {
    assert.equal(command, 'python3');
    const value = await readRecord(args[args.indexOf('--record') + 1]);
    const expected = Number(args[args.indexOf('--expected-version') + 1]);
    const old = await readRecord(target);
    if (conflict) {
      conflict = false;
      await writeDurableJson(target, { ...old, version: old.version + 1,
        consumption: { status: 'done', receipts: [{ consumer: 'review', version: old.version }] } });
      throw Object.assign(Error('registry conflict'), { stderr: 'version conflict; current version changed' });
    }
    assert.equal(expected, old?.version || 0);
    for (const path of Object.values(value.files)) assert.ok((await readFile(path)).length > 0);
    await writeDurableJson(target, { ...value, key, version: expected + 1 });
    return { stdout: JSON.stringify({ status: 'saved', path: target, version: expected + 1 }) };
  } });
  const record = { meetingId: id, chatId: policy.chatId, discovery, status: 'queued' };
  await writer(record, policy);
  let indexed = await readRecord(target);
  assert.equal(indexed.stages.capture, 'partial');
  assert.equal(indexed.stages.transcription, 'pending');
  assert.ok(indexed.gaps.length);
  record.status = 'material_deadline_expired'; record.failure = { message: 'No material returned' };
  await writer(record, policy);
  assert.equal((await readRecord(target)).stages.transcription, 'failed');
  const transcript = join(root, 'original.txt'); await writeFile(transcript, 'Speaker 00:00:01 actual fixture speech');
  record.material = { transcriptPath: transcript }; record.status = 'analysis_accepted';
  record.analysis = { sessionId: 'session', requestId: 'request' };
  await writer(record, policy);
  indexed = await readRecord(target);
  assert.equal(indexed.stages.transcription, 'complete');
  assert.equal(indexed.stages.analysis, 'pending', 'admission cannot claim analysis completion');
  assert.deepEqual(indexed.gaps, []);
  const result = join(root, 'result.md'), review = join(root, 'review.json');
  await writeFile(result, 'Fixture analysis'); await writeFile(review, '{}');
  await writeDurableJson(target, { ...indexed, stages: { ...indexed.stages, analysis: 'complete' },
    files: { ...indexed.files, result, review }, gaps: ['speaker identity uncertain'] });
  conflict = true;
  await writer(record, policy);
  indexed = await readRecord(target);
  assert.equal(indexed.stages.analysis, 'complete');
  assert.equal(indexed.consumption.status, 'done', 'concurrent consumer receipt must survive producer retry');
  assert.deepEqual(indexed.gaps, ['speaker identity uncertain']);
  const pyKey = JSON.parse((await exec('python3', ['-c',
    'import hashlib,json;print(json.dumps(hashlib.sha256(json.dumps(["test","oc_target","feishu-meeting:1234567890123456789"],ensure_ascii=False).encode()).hexdigest()[:24]))'])).stdout);
  assert.equal(key, pyKey, 'same stable source key as the existing registry');

  await writeDurableJson(join(root, 'meeting-ingest-policy.json'), policy);
  const jobRoot = join(root, 'meeting-ingest', 'jobs', 'archive'); await mkdir(jobRoot, { recursive: true });
  const failed = { meetingId: id, discovery, status: 'material_deadline_expired', complete: true, receipt: { failed: true } };
  await writeDurableJson(join(jobRoot, 'a'.repeat(24) + '.json'), failed);
  await writeDurableJson(join(jobRoot, 'b'.repeat(24) + '.json'), { ...failed, meetingId: '1234567890123456790', status: 'delivery_unknown', messageId: 'om_existing' });
  await writeDurableJson(join(jobRoot, 'c'.repeat(24) + '.json'), { ...failed, meetingId: '1234567890123456791', status: 'permission_recovery_accepted', submission: { sessionId: 'existing' } });
  const cli = resolve('scripts/feishu-meeting-ingest.mjs');
  await assert.rejects(exec(process.execPath, [cli, 'retry', '--storage-dir', root, '--meeting-id', id, '--dry-run']),
    error => error.stderr.includes('--dry-run requires retry-pending'));
  const first = JSON.parse((await exec(process.execPath, [cli, 'retry-pending', '--storage-dir', root])).stdout);
  assert.deepEqual(first.queued.map(x => x.meetingId), [id]);
  const twice = JSON.parse((await exec(process.execPath, [cli, 'retry-pending', '--storage-dir', root])).stdout);
  assert.equal(twice.queued.length, 0, 'same daily recovery cannot duplicate commands');
  const pendingId = '1234567890123456800', excludedId = '1234567890123456801', oldId = '1234567890123456802';
  const foreignId = '1234567890123456803', admittedId = '1234567890123456804', activeId = '1234567890123456805';
  const failedScopeId = '1234567890123456806';
  for (const [mid, reason, extra] of [
    [pendingId, 'organizer_unverified', {}], [excludedId, 'outside_source_group_and_organizers', {}],
    [oldId, 'scope_lookup_failed', { endedAt: '1' }], [foreignId, 'scope_lookup_failed', { appId: 'different' }],
    [admittedId, 'scope_lookup_failed', {}], [activeId, 'scope_lookup_failed', {}],
    [failedScopeId, 'source_group_membership_unavailable', {}],
  ]) {
    await writeDurableJson(join(root, 'meeting-observer', mid + '.json'), { ...discovery, meetingId: mid, ...extra });
    await writeDurableJson(join(root, 'meeting-ingest', 'scope', mid + '.json'), {
      meetingId: mid, appId: policy.appId, tenantKey: policy.tenantKey, allowed: false, reason,
    });
  }
  await writeDurableJson(join(jobRoot, 'd'.repeat(24) + '.json'), { ...failed, meetingId: admittedId,
    status: 'permission_recovery_accepted', submission: { sessionId: 'existing' } });
  await writeDurableJson(join(jobRoot, 'e'.repeat(24) + '.json'), { ...failed, meetingId: activeId, complete: false });
  await writeDurableJson(join(jobRoot, 'f'.repeat(24) + '.json'), { ...failed, meetingId: failedScopeId, status: 'scope_excluded' });
  await writeDurableJson(join(jobRoot, '1'.repeat(24) + '.json'), { ...failed, meetingId: excludedId });
  const preview = JSON.parse((await exec(process.execPath, [cli, 'retry-pending', '--storage-dir', root, '--dry-run'])).stdout);
  assert.equal(preview.dryRun, true); assert.equal(preview.queued, undefined);
  assert.deepEqual(preview.candidates.map(x => x.meetingId).sort(), [pendingId, failedScopeId]);
  const recovered = JSON.parse((await exec(process.execPath, [cli, 'retry-pending', '--storage-dir', root])).stdout);
  assert.deepEqual(recovered.queued.map(x => x.meetingId).sort(), [pendingId, failedScopeId]);
  for (const q of recovered.queued) assert.equal(q.source, 'daily_scope_recovery');
  const again = JSON.parse((await exec(process.execPath, [cli, 'retry-pending', '--storage-dir', root])).stdout);
  assert.equal(again.queued.length, 0);
  console.log('meeting intake: exact organizer/group boundary, independent lookup failures, pagination, cutoff, pending/failure index, consumer preservation, CAS merge, unadmitted scope recovery and daily retry dedup passed');
} finally { await rm(root, { recursive: true, force: true }); }

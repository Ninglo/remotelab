import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMeetingScopeChecker } from '../connectors/feishu/meeting-scope.mjs';
import { createFeishuMeetingIngest, meetingIngestKey } from '../connectors/feishu/meeting-ingest.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const root = await mkdtemp(join(tmpdir(), 'meeting-scope-'));
const runtime = { config: { storageDir: root, appId: 'cli_test' }, botIdentity: { openId: 'ou_bot' } };
const id = '1234567890123456789';
const discovery = { meetingId: id, appId: 'cli_test', tenantKey: 'tenant', endedAt: '1792775000' };
const policy = { enabled: true, appId: 'cli_test', tenantKey: 'tenant', chatId: 'oc_destination',
  documentBaseUrl: 'https://tenant.feishu.cn', notBefore: '2026-10-19T00:00:00Z', scope: { mode: 'participating' } };
const policyPath = join(root, 'meeting-ingest-policy.json');
let member = true, participants = [], failLookup = false, wrongMeeting = false, sourceChatId = '';
let reads = 0, writes = 0, submits = 0;
const api = async args => {
  if (args.method !== 'GET') { writes++; throw Error('Unexpected write'); }
  if (failLookup) throw Error('provider unavailable');
  if (args.url.endsWith('/members/is_in_chat')) return { is_in_chat: member };
  assert.equal(args.url, `/open-apis/vc/v1/meetings/${id}`);
  assert.equal(args.params.user_id_type, 'open_id');
  return { meeting: { id: wrongMeeting ? '9876543210987654321' : id, participants, chat_id: sourceChatId } };
};
const check = createMeetingScopeChecker(runtime, api);
const worker = createFeishuMeetingIngest(runtime, { api,
  readMaterials: async () => { reads++; return { transcriptPath: '/fixture.txt', minuteToken: 'fixture' }; },
  submit: async () => { submits++; return { sessionId: 'session' }; },
});
try {
  assert.equal((await check({ ...policy, scope: undefined }, discovery)).allowed, false);
  assert.equal((await check(policy, { ...discovery, joinVerifiedAt: new Date().toISOString() })).allowed, false,
    'queued discovery snapshots cannot assert attendance');
  participants = [{ id: 'ou_host', first_join_time: '1' }, { id: 'ou_bot', status: 4 }];
  assert.equal((await check(policy, discovery)).allowed, false, 'invitation is not attendance');
  participants = [{ id: 'ou_bot', first_join_time: '1792774000' }];
  assert.equal((await check(policy, discovery)).allowed, true);
  wrongMeeting = true;
  assert.equal((await check(policy, discovery)).allowed, false);
  wrongMeeting = false; participants = [];
  sourceChatId = 'oc_source';
  assert.equal((await check(policy, discovery)).reason, 'source_group_member');
  member = false;
  assert.equal((await check(policy, discovery)).allowed, false, 'leaving source group revokes admission');
  let pageCalls = 0;
  const humanPolicy = { ...policy, scope: { ...policy.scope,
    groupMemberOpenIds: ['ou_authorized'], userGroupLookup: true } };
  const humanCheck = createMeetingScopeChecker(runtime, api, { cli: async (args, identity) => {
    assert.equal(identity, 'user');
    const params = JSON.parse(args.at(-1)); assert.equal(params.chat_id, sourceChatId);
    pageCalls++;
    return params.page_token ? { items: [{ member_id: 'ou_authorized', member_id_type: 'open_id', tenant_key: 'tenant' }] }
      : { items: [{ member_id: 'ou_other', name: 'Authorized person' }], has_more: true, page_token: 'next' };
  } });
  assert.equal((await humanCheck(humanPolicy, discovery)).reason, 'authorized_source_group_member');
  assert.equal(pageCalls, 2, 'authorized member can be on a later page');
  await humanCheck(policy, discovery); assert.equal(pageCalls, 2, 'human metadata access is opt-in');
  const deniedCheck = createMeetingScopeChecker(runtime, api, { cli: async () => { throw Error('Operator outside chat'); } });
  assert.equal((await deniedCheck(humanPolicy, discovery)).reason, 'source_group_membership_unavailable');
  const foreignCheck = createMeetingScopeChecker(runtime, api, { cli: async () => ({ items: [
    { member_id: 'ou_authorized', member_id_type: 'open_id', tenant_key: 'other' },
    { member_id: 'ou_authorized', member_id_type: 'user_id', tenant_key: 'tenant' },
  ] }) });
  assert.equal((await foreignCheck(humanPolicy, discovery)).allowed, false, 'IDs require matching type and tenant');
  sourceChatId = '';
  assert.equal((await humanCheck(humanPolicy, { ...discovery, chatId: 'oc_source' })).allowed, false);
  assert.equal(pageCalls, 2, 'caller-supplied groups do not trigger human lookup');
  member = true; sourceChatId = '';
  assert.equal((await check(policy, { ...discovery, chatId: 'oc_source' })).allowed, false,
    'caller-supplied chat and ingestion destination cannot substitute for the original source');
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), {
    ...discovery, joinAttempted: true, joinReceipt: {},
  });
  assert.equal((await check(policy, discovery)).allowed, false, 'join request is not attendance');
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), {
    ...discovery, joinVerifiedAt: '2026-10-23T16:00:00Z', appId: 'other',
  });
  assert.equal((await check(policy, discovery)).allowed, false, 'other bot does not count');
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), {
    ...discovery, joinVerifiedAt: '2026-10-23T16:00:00Z',
  });
  assert.equal((await check(policy, discovery)).evidence, 'observer_events_read');
  await writeDurableJson(join(root, 'meeting-observer', id + '.json'), discovery);
  await writeDurableJson(policyPath, { ...policy, sampleMeetingIds: [id], samples: { [id]: { minuteUrl: 'https://tenant.feishu.cn/minutes/sample' } } });
  assert.equal(await worker.accept(discovery), null, 'sample links cannot bypass scope');
  assert.equal(reads + writes + submits, 0);
  failLookup = true;
  assert.equal(await worker.accept(discovery), null);
  assert.equal((await readRecord(join(root, 'meeting-ingest', 'scope', id + '.json'))).reason, 'scope_lookup_failed');
  failLookup = false;
  // A job queued under the old broad policy is denied before content/ACL work.
  await worker.store.mutate(meetingIngestKey(id), () => ({ id: `meeting:${id}`, meetingId: id,
    discovery, chatId: policy.chatId, status: 'queued', complete: false, nextAttemptAt: 0,
    permissionRecovery: true, material: { minuteToken: 'fixture' } }));
  await worker.tick(); await worker.idle();
  assert.equal(reads + writes + submits, 0);
  assert.equal((await worker.store.get(meetingIngestKey(id))).receipt.permanent, true);
  // Even cached readable text cannot escape a revoked group scope.
  sourceChatId = 'oc_source';
  await writeDurableJson(policyPath, policy);
  await worker.store.mutate(meetingIngestKey(id), current => ({ ...current, complete: false, permissionRecovery: false,
    material: { transcriptPath: '/fixture.txt', minuteToken: 'fixture' } }));
  member = false;
  await worker.tick(); await worker.idle();
  assert.equal(reads + writes + submits, 0);
  // A retry command must not reset the denial or bypass the same policy.
  await writeDurableJson(join(root, 'meeting-ingest', 'commands', 'a'.repeat(24) + '.json'), { action: 'retry', meetingId: id });
  await worker.start(); await worker.idle();
  const receipt = await readRecord(join(root, 'meeting-ingest', 'command-receipts', 'a'.repeat(24) + '.json'));
  assert.match(receipt.error, /participation scope/);
  assert.equal(reads + writes + submits, 0);
  worker.stop();
  member = true;
  const revokedDuringRead = createFeishuMeetingIngest(runtime, { api,
    readMaterials: async () => { reads++; member = false; return { transcriptPath: '/fixture.txt', minuteToken: 'fixture' }; },
    submit: async () => { submits++; return { sessionId: 'session' }; },
  });
  try {
    await revokedDuringRead.store.mutate(meetingIngestKey(id), current => ({ ...current, complete: false, material: null }));
    await revokedDuringRead.tick(); await revokedDuringRead.idle();
    assert.equal(reads, 1, 'verified source group can enter material collection');
    assert.equal(writes + submits, 0, 'scope revoked during reading prevents publication');
    assert.equal((await revokedDuringRead.store.get(meetingIngestKey(id))).status, 'scope_excluded');
  } finally { revokedDuringRead.stop(); await revokedDuringRead.idle(); }
  console.log('meeting participation: default deny, exact Bot, real attendance, source provenance, membership revocation, lookup errors, samples, old jobs, cached content and retries passed');
} finally { worker.stop(); await worker.idle(); await rm(root, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'feishu-tenant-access-'));
setIsolatedTestHome(root);
const { isAllowedByPolicy, initializeInbox, summarizeEvent, withFeishuCardAccess } =
  await import('../scripts/feishu-connector.mjs');
try {
  const allowedSendersPath = join(root, 'allowed-senders.json');
  const allowed = { openIds: [], userIds: [], unionIds: [], tenantKeys: ['company'] };
  await writeFile(allowedSendersPath, JSON.stringify(allowed));
  const policy = { mode: 'whitelist', allowedSendersPath, allowedSenders: { openIds: ['ou_outside'] } };
  const message = (tenant, overrides = {}) => summarizeEvent({
    tenant_key: 'company', app_id: 'cli_test', event_type: 'im.message.receive_v1',
    sender: { sender_id: { open_id: 'ou_person' }, sender_type: 'user', tenant_key: tenant },
    message: { message_id: 'om_test', chat_id: 'oc_external', chat_type: 'group',
      message_type: 'text', content: '{"text":"/thread do work"}', ...overrides },
  });
  for (const context of [{}, { thread_id: 'omt_existing' }, { chat_type: 'p2p' }]) {
    assert.equal(await isAllowedByPolicy(policy, message('company', context)), true);
    for (const tenant of ['external', '', undefined]) {
      assert.equal(await isAllowedByPolicy(policy, message(tenant, context)), false,
        'an app tenant and an existing thread cannot grant sender access');
    }
  }
  for (const sender of [{ tenantKey: 'company' },
    { tenantKey: 'company', openId: 'ou_bot', senderType: 'app' }]) {
    assert.equal(await isAllowedByPolicy(policy, { ...message('company'), sender }), false);
  }
  const changedCompany = { ...message('company'), tenantKey: 'foreign_group_owner' };
  assert.equal(await isAllowedByPolicy(policy, changedCompany), true,
    'the sender tenant determines admission, not the group owner or envelope');

  let actions = 0;
  const callback = withFeishuCardAccess({ appId: 'cli_test', accessPolicy: policy }, async () => {
    actions++;
    return { toast: { type: 'success' } };
  });
  const card = tenant => ({ header: { app_id: 'cli_test', tenant_key: 'company' },
    event: { operator: { open_id: 'ou_person', tenant_key: tenant }, tenant_key: 'company',
      action: { value: { namespace: 'personal-settings' } } } });
  assert.equal((await callback(card('company'))).toast.type, 'success');
  for (const tenant of ['external', '', undefined]) {
    assert.equal((await callback(card(tenant))).toast.type, 'error');
  }
  assert.equal(actions, 1, 'denied card clicks must never reach a handler or mutate settings');

  // Exercise the persisted inbox boundary, including a follow-up to a known topic.
  let entered = 0;
  const runtime = { config: { storageDir: root, sourceRouteId: 'test', accessPolicy: policy },
    storagePaths: { eventsLogPath: join(root, 'events.jsonl'), knownSendersPath: join(root, 'senders.json') },
    personalSettings: { publish: async () => { entered++; return { accepted: true }; } } };
  const inbox = initializeInbox(runtime);
  for (const [id, tenant] of [['outside', 'external'], ['missing', '']]) {
    await inbox.accept(id, { sourceLabel: 'im.message.receive_v1',
      summary: message(tenant, { message_id: id, thread_id: 'omt_existing' }) });
  }
  await inbox.accept('inside', { sourceLabel: 'test', summary: {
    ...message('company', { message_id: 'inside', chat_type: 'p2p' }), sourceKind: 'personal_chat_entered' } });
  // A manual tick processes at most one queued item per conversation.
  for (let i = 0; i < 3; i++) { await inbox.tick(); await inbox.idle(); }
  assert.equal(entered, 1);
  const receipts = await Promise.all((await readdir(join(root, 'inbox/archive'))).map(async file =>
    JSON.parse(await readFile(join(root, 'inbox/archive', file), 'utf8'))));
  assert.equal(receipts.length, 3);
  for (const r of receipts) assert.deepEqual(r.receipt,
    r.summary.messageId === 'inside' ? { accepted: true } : { blocked: true });

  await writeFile(allowedSendersPath, JSON.stringify({ ...allowed, tenantKeys: [] }));
  assert.equal(await isAllowedByPolicy(policy, message('company')), false, 'revocation takes effect without restart');
  await writeFile(allowedSendersPath, JSON.stringify({ ...allowed, tenantKeys: [], openIds: ['ou_person'] }));
  assert.equal(await isAllowedByPolicy(policy, message('')), true, 'explicit individual allowances remain supported');
  console.log('PASS: company admission; external/missing identity blocked in messages, threads, cards and persisted inbox; live revocation');
} finally {
  await rm(root, { recursive: true, force: true });
}

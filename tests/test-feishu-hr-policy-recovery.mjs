import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'feishu-hr-policy-recovery-'));
setIsolatedTestHome(root);
const originalFetch = globalThis.fetch;
let inbox;
let refreshRuntimeHrPolicy;
try {
  const credentialsPath = join(root, 'credentials.json');
  const guardPath = join(root, 'guard.json');
  await writeFile(credentialsPath, JSON.stringify({ apiKey: 'fixture', signingKey: 'fixture' }));
  await writeFile(guardPath, JSON.stringify({ hrInstance: 'hr', hrRestrictedRuntime: true,
    hrPolicyRegistry: { endpoint: 'https://fixture.invalid', credentialsPath,
      appId: 'fixture-app', tenant: 'fixture-tenant' } }));
  process.env.REMOTELAB_REQUEST_ACCESS_GUARD = guardPath;
  const policy = { schema: 1, version: 'fixture-v1', roles: { hr2: { 'hr.read': 'all' } },
    subjects: [{ id: 'fixture-user', active: true, roles: ['hr2'], bindings: [
      { kind: 'feishu', route: 'muka-hr', appId: 'fixture-app',
        tenant: 'fixture-tenant', openId: 'ou_fixture' },
    ] }] };
  let available = false;
  let reads = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.query.action, 'policy_read');
    reads++;
    return available ? Response.json({ policyVersion: 1, policy }) : new Response(null, { status: 503 });
  };
  const hrPolicy = await import('../lib/hr-policy.mjs');
  refreshRuntimeHrPolicy = hrPolicy.refreshRuntimeHrPolicy;
  const { initializeInbox } = await import('../scripts/feishu-connector.mjs');
  assert.equal(hrPolicy.runtimeHrPolicy().unavailable, true);
  let admitted = 0;
  const runtime = { config: { storageDir: root, sourceRouteId: 'muka-hr',
    accessPolicy: { mode: 'roles', roles: { hrPolicy: true, appId: 'fixture-app',
      tenantKey: 'fixture-tenant' } } },
    storagePaths: { eventsLogPath: join(root, 'events.jsonl'), knownSendersPath: join(root, 'senders.json') },
    personalSettings: { publish: async () => { admitted++; return { admitted: true }; } } };
  const accept = id => inbox.accept(id, { sourceLabel: 'im.chat.access_event.bot_p2p_chat_entered_v1',
    summary: { messageId: id, chatId: 'oc_fixture', chatType: 'p2p', sourceKind: 'personal_chat_entered',
      appId: 'fixture-app', tenantKey: 'fixture-tenant',
      sender: { senderType: 'user', openId: 'ou_fixture', tenantKey: 'fixture-tenant' } } });
  inbox = initializeInbox(runtime);

  // A failed startup read must recover before the first admission decision.
  available = true;
  const recovered = await accept('recovered');
  await inbox.tick();
  await inbox.idle();
  assert.equal(admitted, 1);
  assert.deepEqual((await inbox.store.get(recovered.key)).receipt, { admitted: true });

  // An unavailable registry keeps the original envelope pending for bounded retries.
  available = false;
  const pending = await accept('transient');
  await inbox.tick();
  await inbox.idle();
  const waiting = await inbox.store.get(pending.key);
  assert.equal(waiting.complete, false);
  assert.equal(waiting.attempts, 1);
  assert.match(waiting.lastError, /HR service unavailable \(503\)/);
  assert.equal(waiting.receipt?.blocked, undefined);
  assert.equal(admitted, 1);
  assert.deepEqual((await inbox.store.active()).map(record => record.id), ['transient']);
  available = true;
  await inbox.store.mutate(pending.key, current => ({ ...current, nextAttemptAt: 0 }));
  await inbox.tick();
  await inbox.idle();
  const retried = await inbox.store.get(pending.key);
  assert.equal(retried.complete, true);
  assert.equal(retried.attempts, 2);
  assert.deepEqual(retried.receipt, { admitted: true });
  assert.equal(admitted, 2);

  // A fresh revocation still wins over the previously valid in-memory policy.
  policy.subjects[0].active = false;
  const revoked = await accept('revoked');
  await inbox.tick();
  await inbox.idle();
  assert.deepEqual((await inbox.store.get(revoked.key)).receipt, { blocked: true });
  assert.equal(admitted, 2);
  assert.equal(reads, 5);
  assert.equal((await readdir(join(root, 'inbox/archive'))).length, 3);
  console.log('PASS: persisted HR inbox recovers after policy failure, retries the same input and enforces fresh revocation');
} finally {
  inbox?.stop();
  await inbox?.idle();
  delete process.env.REMOTELAB_REQUEST_ACCESS_GUARD;
  await refreshRuntimeHrPolicy?.();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

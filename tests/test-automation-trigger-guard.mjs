import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const root = await mkdtemp(join(tmpdir(), 'trigger-guard-'));
setIsolatedTestHome(root);
const policy = join(root, 'guard.json');
await writeFile(policy, JSON.stringify({ version: 2, policyId: 'synthetic', allowPairs: [], rules: [
  { id: 'hr-data', category: 'protected', all: ['当麻.{0,30}日志'] },
] }));
process.env.REMOTELAB_REQUEST_ACCESS_GUARD = policy;
const { createSession } = await import('../chat/session-manager.mjs');
const { loadAuthDocument } = await import('../lib/auth-config.mjs');
const { createTrigger, getTrigger, processDueTriggersNow, updateTrigger } = await import('../chat/triggers.mjs');
const { requests } = await import('../chat/requests.mjs');
const { getRun } = await import('../chat/runs.mjs');
const { projectExecution } = await import('../chat/automation-tasks.mjs');
try {
  const doc = await loadAuthDocument();
  const creator = doc.people.find(p => p.id === doc.primaryPersonId).identities[0];
  const source = await createSession(root, 'codex', 'Synthetic source');
  const t = await createTrigger({ sourceSessionId: source.id, createdByIdentityId: creator.id,
    title: 'Synthetic denied task', text: '请读取当麻日志', tool: 'codex', scheduledAt: new Date(Date.now() - 1000).toISOString(),
    sessionTemplate: { folder: root, tool: 'codex', name: 'Synthetic execution', internalRole: 'scheduled_execution' } });
  await processDueTriggersNow();
  const failed = await getTrigger(t.id);
  assert.equal(failed.status, 'failed', failed.lastError);
  assert.equal(failed.enabled, false);
  assert.equal(failed.deliveryMode, 'access_denied');
  assert.equal(failed.deliveredAt, '');
  assert.match(failed.lastError, /Access check denied/);
  const receipt = await requests.byRequest(failed.executionSessionId, t.requestId);
  assert.equal(receipt.options.automationAttribution.identityId, creator.id);
  assert.equal(receipt.options.automationAttribution.identityVerified, true);
  assert.equal(receipt.options.automationAttribution.triggerId, t.id);
  assert.equal(receipt.options.automationAttribution.name, doc.people.find(p => p.id === doc.primaryPersonId).name);
  assert.equal(await getRun(failed.runId), null, 'refusal never starts a model');
  assert.equal((await projectExecution(failed)).state, 'failed');
  // Simulate a lost dispatch acknowledgement using the original admitted ID.
  await updateTrigger(t.id, { enabled: true, scheduledAt: new Date(Date.now() - 500).toISOString() });
  await processDueTriggersNow();
  const replay = await getTrigger(t.id);
  assert.equal(replay.status, 'failed');
  assert.equal(replay.runId, failed.runId, 'reuse the original refused Request');
  assert.equal(await getRun(replay.runId), null);
  console.log('PASS: real Trigger -> Request -> guard -> failed projection, verified audit principal, no model, idempotent refusal recovery');
} finally { delete process.env.REMOTELAB_REQUEST_ACCESS_GUARD; await rm(root, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts } from '../lib/codex-accounts.mjs';
import { readSessionAccount } from '../lib/codex-session-routing.mjs';

const root = await mkdtemp(join(tmpdir(), 'scheduled-account-'));
const pool = new CodexAccounts({ root: join(root, 'accounts'), defaultHome: join(root, 'default') });
const slots = [];
const acquire = async options => { const slot = await pool.acquireForRun(options); slots.push(slot); return slot; };
try {
  const reserved = await pool.add('automation');
  const alias = await pool.add('same subscription');
  await pool.mutate(data => {
    data.autoSwitch = true; data.balanceSessions = true;
    for (const account of data.accounts) {
      account.account = { type: 'chatgpt' };
      account.identityId = account.id === alias.id ? reserved.id : account.id;
      account.usage = { status: 'ready', checkedAt: new Date().toISOString(), buckets: [
        { id: 'codex', primary: { remainingPercent: 38, resetsAt: new Date(Date.now() + 86400000).toISOString() } },
      ] };
    }
    data.automationRouting = { accountId: reserved.id, scheduleIds: ['chosen'], maxConcurrentRuns: 1 };
  });
  const human = await acquire({ sessionId: 'human', runId: 'human-run' });
  assert.equal(human.id, 'default');
  await human.lease.release();
  const original = await readSessionAccount(pool.root, 'human');
  const batch = await Promise.all(Array.from({ length: 5 }, (_, i) => acquire({
    sessionId: i ? `scheduled-${i}` : 'human', runId: `scheduled-run-${i}`, scheduleId: 'chosen',
  })));
  assert.equal(batch.filter(slot => slot.id === reserved.id).length, 1, 'concurrent admission honors the one-run budget');
  assert(!batch.some(slot => slot.id === alias.id), 'a duplicate login cannot evade the budget');
  assert.equal(batch.find(slot => slot.id === reserved.id).assignmentReason, 'scheduled_account_preference');
  assert.deepEqual(await readSessionAccount(pool.root, 'human'), original, 'automatic work never changes the human binding');
  assert.equal((await acquire({ sessionId: 'unlisted', runId: 'unlisted-run', scheduleId: 'other' })).id, 'default');
  await Promise.all(slots.map(slot => slot.lease.release()));
  const inHumanSession = await acquire({ sessionId: 'human', runId: 'scheduled-human', scheduleId: 'chosen' });
  assert.equal(inHumanSession.id, reserved.id);
  assert.deepEqual(await readSessionAccount(pool.root, 'human'), original);
  await inHumanSession.lease.release();
  const resumedHuman = await acquire({ sessionId: 'human', runId: 'next-human' });
  assert.equal(resumedHuman.id, 'default'); await resumedHuman.lease.release();
  await pool.markRateLimited(reserved.id);
  assert.equal((await acquire({ sessionId: 'cooldown', runId: 'cooldown-run', scheduleId: 'chosen' })).id, 'default');
  await pool.mutate(data => { for (const a of data.accounts) delete a.cooldownUntil; });
  const retry = await acquire({ sessionId: 'retry', runId: 'retry-run', scheduleId: 'chosen', excludedAccountIds: [reserved.id] });
  assert.equal(retry.id, 'default', 'confirmed provider failure uses another subscription');
  await retry.lease.release();
  await pool.mutate(data => { delete data.automationRouting; });
  const restored = await acquire({ sessionId: 'after-policy', runId: 'after-policy-run', scheduleId: 'chosen' });
  assert.equal(restored.id, reserved.id, 'removing the temporary policy restores ordinary allocation');
  console.log('Scheduled account preference: concurrency, aliases, foreground isolation, cooldown, failover and removal passed');
} finally {
  await Promise.all(slots.map(slot => slot.lease.release()));
  await rm(root, { recursive: true, force: true });
}

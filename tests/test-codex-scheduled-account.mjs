import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts } from '../lib/codex-accounts.mjs';
const root = await mkdtemp(join(tmpdir(), 'codex-schedule-routing-'));
const pool = new CodexAccounts({ root: join(root, 'accounts'), defaultHome: join(root, 'default') });
const slots = [];
try {
  const second = await pool.add('second');
  await pool.mutate(data => {
    data.automationRouting = { accountId: second.id, scheduleIds: ['legacy'], maxConcurrentRuns: 1 };
    for (const a of data.accounts) a.account = { type: 'chatgpt' };
  });
  for (let i = 0; i < 8; i++) slots.push(await pool.acquireForRun({ sessionId: `s-${i}`, scheduleId: i % 2 ? 'legacy' : '' }));
  assert.equal(slots.filter(s => s.id === second.id).length, 4, 'scheduled and ordinary work share one allocator without a reserved account');
  await pool.setRoutingEnabled(second.id, false);
  const next = await pool.acquireForRun({ sessionId: 'disabled-schedule', scheduleId: 'legacy' }); slots.push(next);
  assert.equal(next.id, 'default');
  console.log('Legacy scheduled preferences cannot reserve or reactivate shared accounts');
} finally { await Promise.all(slots.map(s => s.lease.release())); await rm(root, { recursive: true, force: true }); }

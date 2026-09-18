import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectQuickSessionStats } from '../lib/quick-stats-command.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-quick-stats-'));
try {
  const requestDir = join(root, 'requests', 'archive');
  const runDir = join(root, 'chat-runs', 'run_quick');
  await Promise.all([mkdir(requestDir, { recursive: true }), mkdir(runDir, { recursive: true })]);
  await writeFile(join(requestDir, 'aaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify({
    requestId: 'quick-request',
    sessionId: 'quick-session',
    runId: 'run_quick',
    acceptedAt: '2026-09-18T10:00:01.000Z',
    settledAt: '2026-09-18T10:00:04.000Z',
    options: {
      executionProfile: 'quick',
      sourceContext: { connector: 'feishu', createTime: '1789725600000' },
    },
    deliveries: [{
      kind: 'content', state: 'delivered', availableAt: '2026-09-18T10:00:04.000Z',
      deliveredAt: '2026-09-18T10:00:05.000Z',
    }],
  }));
  await writeFile(join(runDir, 'status.json'), JSON.stringify({
    startedAt: '2026-09-18T10:00:01.250Z',
    completedAt: '2026-09-18T10:00:04.000Z',
  }));
  await writeFile(join(runDir, 'spool.jsonl'), `${JSON.stringify({
    ts: '2026-09-18T10:00:02.500Z',
    json: { type: 'item.updated', item: { type: 'agent_message', text: '答' } },
  })}\n`);

  const stats = await collectQuickSessionStats({
    configDir: root,
    days: 1,
    now: new Date('2026-09-18T12:00:00.000Z'),
  });
  assert.equal(stats.total, 1);
  assert.equal(stats.bySource.feishu.total, 1);
  assert.equal(stats.overall.acceptedToRunnerMs.p50Ms, 250);
  assert.equal(stats.overall.timeToFirstAnswerMs.p50Ms, 1500);
  assert.equal(stats.overall.timeToCompleteMs.p50Ms, 3000);
  assert.equal(stats.overall.answerReadyToDeliveredMs.p50Ms, 1000);
  assert.equal(stats.overall.endToEndMs.p50Ms, 5000);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('test-quick-stats-command: ok');

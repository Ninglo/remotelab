process.env.TZ = 'UTC';

import assert from 'assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSessionToolReuseSidecar } from './lib/session-tool-reuse.mjs';

const root = mkdtempSync(join(tmpdir(), 'remotelab-tool-reuse-'));
const configDir = join(root, 'config');
const historyDir = join(configDir, 'chat-history');
const outputDir = join(root, 'reports');

mkdirSync(historyDir, { recursive: true });

const sessions = [
  { id: 's1', name: 'Task A', tool: 'codex', folder: '/repo/a' },
  { id: 's2', name: 'Task B', tool: 'codex', folder: '/repo/b' },
  { id: 's3', name: 'Task C', tool: 'codex', folder: '/repo/c' },
  { id: 'm1', name: '🔧 daily review — 2026-03-09', tool: 'codex', folder: '/home' },
];

writeFileSync(join(configDir, 'chat-sessions.json'), JSON.stringify(sessions, null, 2));

const march9 = Date.UTC(2026, 2, 9, 10, 0, 0);
const march8 = Date.UTC(2026, 2, 8, 10, 0, 0);

function toolUse(timestamp, input) {
  return {
    type: 'tool_use',
    timestamp,
    toolName: 'bash',
    toolInput: input,
  };
}

writeFileSync(join(historyDir, 's1.json'), JSON.stringify([
  toolUse(march9, 'bash -lc "cat ~/.remotelab/memory/bootstrap.md && cat ~/code/remotelab/AGENTS.md"'),
  toolUse(march9 + 1000, 'bash -lc "rg -n \"memory\" ~/.remotelab/skills/self-review.md"'),
], null, 2));

writeFileSync(join(historyDir, 's2.json'), JSON.stringify([
  toolUse(march9 + 3000, 'bash -lc "printf \"---BOOT---\"; cat ~/.remotelab/memory/bootstrap.md; printf \"---AGENTS---\"; cat ~/code/remotelab/AGENTS.md"'),
  toolUse(march9 + 4000, 'bash -lc "rg -n \"skills\" ~/.remotelab/skills/self-review.md"'),
], null, 2));

writeFileSync(join(historyDir, 's3.json'), JSON.stringify([
  toolUse(march9 + 5000, 'bash -lc "apply_patch <<\'PATCH\'\n*** Begin Patch\n*** Update File: foo.txt\n@@\n-old\n+new\n*** End Patch\nPATCH"'),
], null, 2));

writeFileSync(join(historyDir, 'm1.json'), JSON.stringify([
  toolUse(march9 + 6000, 'bash -lc "cat ~/.remotelab/memory/global.md"'),
], null, 2));

writeFileSync(join(historyDir, 'old.json'), JSON.stringify([
  toolUse(march8, 'bash -lc "cat ~/.remotelab/memory/bootstrap.md"'),
], null, 2));

try {
  const sidecar = await generateSessionToolReuseSidecar({
    configDir,
    outputDir,
    date: '2026-03-09',
    days: 1,
  });

  assert.equal(sidecar.report.window.anchorDate, '2026-03-09');
  assert.equal(sidecar.report.stats.sessionCount, 3);
  assert.equal(sidecar.report.stats.toolCallCount, 5);
  assert.equal(sidecar.report.stats.excludedSessions, 1);
  assert.ok(sidecar.report.clusters.some((cluster) => (
    cluster.sessionCount === 2
    && cluster.readOnly
    && cluster.topTokens.some((token) => token.includes('bootstrap'))
    && cluster.abstractionHint.includes('startup')
  )));
  assert.ok(sidecar.report.sequences.some((sequence) => sequence.sessionCount === 2 && sequence.length === 2));
  assert.match(sidecar.summary, /Tool-call sidecar for 2026-03-09/);
  assert.ok(existsSync(sidecar.markdownPath));
  assert.ok(existsSync(sidecar.jsonPath));

  console.log('test-session-tool-reuse: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

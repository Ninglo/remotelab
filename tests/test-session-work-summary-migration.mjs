#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'remotelab-work-summary-migration-'));
const configDir = join(home, '.config', 'remotelab');
mkdirSync(configDir, { recursive: true });
process.env.HOME = home;
process.env.REMOTELAB_CONFIG_DIR = configDir;

const sessionsPath = join(configDir, 'chat-sessions.json');
writeFileSync(sessionsPath, JSON.stringify([{
  id: 'legacy-task-card-session',
  folder: home,
  tool: 'codex',
  sourceId: 'chat',
  name: 'Legacy work state',
  autoRenamePending: false,
  created: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  taskCard: {
    mode: 'project',
    summary: 'Migrate the old task-card carrier into provider-neutral work state.',
    knownConclusions: ['RemoteLab owns cross-Harness continuity.'],
    nextSteps: ['Continue from workState.summary.'],
  },
}], null, 2));

try {
  const { loadSessionsMeta } = await import('../chat/session-meta-store.mjs');
  const sessions = await loadSessionsMeta();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].workSummary?.summary, 'Migrate the old task-card carrier into provider-neutral work state.');
  assert.equal(Object.prototype.hasOwnProperty.call(sessions[0], 'taskCard'), false);

  const persisted = JSON.parse(readFileSync(sessionsPath, 'utf8'))[0];
  assert.equal(persisted.workSummary?.mode, 'project');
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'taskCard'), false);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('test-session-work-summary-migration: ok');

#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-legacy-app-scope-'));
const configDir = join(tempHome, '.config', 'remotelab');
mkdirSync(configDir, { recursive: true });

const sessionsPath = join(configDir, 'chat-sessions.json');

const sessions = [
  {
    id: 'legacy_manual',
    folder: tempHome,
    tool: 'codex',
    name: 'Owner chat stays put',
    created: '2026-03-10T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
  },
  {
    id: 'legacy_github',
    folder: tempHome,
    tool: 'codex',
    name: 'GitHub legacy session',
    externalTriggerId: 'github:owner/repo#42',
    created: '2026-03-10T00:01:00.000Z',
    updatedAt: '2026-03-10T00:01:00.000Z',
  },
  {
    id: 'legacy_lark',
    folder: tempHome,
    tool: 'codex',
    appId: 'chat',
    name: 'Legacy Feishu session',
    externalTriggerId: 'feishu:p2p:chat_42',
    created: '2026-03-10T00:02:00.000Z',
    updatedAt: '2026-03-10T00:02:00.000Z',
  },
  {
    id: 'legacy_email',
    folder: tempHome,
    tool: 'codex',
    name: 'Legacy email session',
    externalTriggerId: 'email-thread:%3Croot-thread%40example.com%3E',
    created: '2026-03-10T00:03:00.000Z',
    updatedAt: '2026-03-10T00:03:00.000Z',
  },
  {
    id: 'legacy_maintenance',
    folder: tempHome,
    tool: 'codex',
    appId: 'chat',
    name: '🔧 daily review — 2026-03-10',
    group: 'Daily Review',
    description: 'Automated Markdown review session for daily memory and tool-reuse patterns.',
    externalTriggerId: 'maintenance:daily:2026-03-10',
    created: '2026-03-10T00:04:00.000Z',
    updatedAt: '2026-03-10T00:04:00.000Z',
  },
  {
    id: 'legacy_review_without_trigger',
    folder: tempHome,
    tool: 'codex',
    name: '🔧 weekly review — 2026-03-09',
    group: 'Weekly Review',
    description: 'Automated Markdown review session for weekly memory and tool-reuse patterns.',
    created: '2026-03-10T00:05:00.000Z',
    updatedAt: '2026-03-10T00:05:00.000Z',
  },
  {
    id: 'already_scoped',
    folder: tempHome,
    tool: 'codex',
    appId: 'github',
    name: 'Already scoped GitHub session',
    externalTriggerId: 'github:owner/repo#43',
    created: '2026-03-10T00:06:00.000Z',
    updatedAt: '2026-03-10T00:06:00.000Z',
  },
];

writeFileSync(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');

try {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'migrate-legacy-app-scopes.mjs'), '--apply'],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Applying legacy app-scope migration on 5 session\(s\)\./);

  const migrated = JSON.parse(readFileSync(sessionsPath, 'utf8'));
  const byId = new Map(migrated.map((session) => [session.id, session]));

  assert.equal(byId.get('legacy_manual')?.appId, undefined);
  assert.equal(byId.get('legacy_github')?.appId, 'github');
  assert.equal(byId.get('legacy_lark')?.appId, 'feishu');
  assert.equal(byId.get('legacy_email')?.appId, 'email');
  assert.equal(byId.get('legacy_maintenance')?.appId, 'automation');
  assert.equal(byId.get('legacy_review_without_trigger')?.appId, 'automation');
  assert.equal(byId.get('already_scoped')?.appId, 'github');

  const backupDir = join(configDir, 'backups');
  const backups = readdirSync(backupDir).filter((entry) => entry.includes('legacy-app-scope'));
  assert.equal(backups.length, 1, 'migration should create a single backup snapshot');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-legacy-app-scope-migration: ok');

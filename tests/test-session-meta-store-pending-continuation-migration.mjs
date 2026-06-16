#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const home = mkdtempSync(join(tmpdir(), 'remotelab-session-meta-migration-'));
const configDir = join(home, '.config', 'remotelab');
const sessionsFile = join(configDir, 'chat-sessions.json');

try {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(sessionsFile, JSON.stringify([
    {
      id: 'session-legacy-only',
      name: 'Legacy only',
      pendingPlanningQueue: [
        {
          requestId: 'req-legacy',
          responseId: 'resp-legacy',
          text: 'legacy continuation entry',
        },
      ],
    },
    {
      id: 'session-both-fields',
      name: 'Prefer new field',
      pendingPlanningQueue: [
        {
          requestId: 'req-old',
          responseId: 'resp-old',
          text: 'old continuation entry',
        },
      ],
      pendingContinuationQueue: [
        {
          requestId: 'req-new',
          responseId: 'resp-new',
          text: 'new continuation entry',
        },
      ],
    },
  ], null, 2));

  process.env.REMOTELAB_CONFIG_DIR = configDir;

  const { loadSessionsMeta } = await import(`${pathToFileURL(join(repoRoot, 'chat/session-meta-store.mjs')).href}?test=${Date.now()}`);
  const sessions = await loadSessionsMeta();

  const legacyOnly = sessions.find((session) => session.id === 'session-legacy-only');
  assert.ok(legacyOnly, 'legacy-only session should still load');
  assert.deepEqual(
    legacyOnly.pendingContinuationQueue,
    [
      {
        requestId: 'req-legacy',
        responseId: 'resp-legacy',
        text: 'legacy continuation entry',
      },
    ],
    'legacy planning queue should migrate into pendingContinuationQueue',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(legacyOnly, 'pendingPlanningQueue'),
    false,
    'legacy planning queue field should be removed from normalized sessions',
  );

  const bothFields = sessions.find((session) => session.id === 'session-both-fields');
  assert.ok(bothFields, 'session containing both queue fields should still load');
  assert.deepEqual(
    bothFields.pendingContinuationQueue,
    [
      {
        requestId: 'req-new',
        responseId: 'resp-new',
        text: 'new continuation entry',
      },
    ],
    'new pendingContinuationQueue should win over the legacy field when both exist',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(bothFields, 'pendingPlanningQueue'),
    false,
    'legacy field should be removed when both queue fields existed',
  );

  const persisted = JSON.parse(readFileSync(sessionsFile, 'utf8'));
  const persistedLegacyOnly = persisted.find((session) => session.id === 'session-legacy-only');
  const persistedBothFields = persisted.find((session) => session.id === 'session-both-fields');

  assert.ok(persistedLegacyOnly, 'migrated legacy-only session should persist');
  assert.ok(persistedBothFields, 'migrated dual-field session should persist');
  assert.equal(
    Object.prototype.hasOwnProperty.call(persistedLegacyOnly, 'pendingPlanningQueue'),
    false,
    'persisted legacy-only session should no longer carry pendingPlanningQueue',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(persistedBothFields, 'pendingPlanningQueue'),
    false,
    'persisted dual-field session should no longer carry pendingPlanningQueue',
  );
  assert.deepEqual(
    persistedLegacyOnly.pendingContinuationQueue,
    legacyOnly.pendingContinuationQueue,
    'persisted migrated legacy-only session should keep the migrated queue content',
  );
  assert.deepEqual(
    persistedBothFields.pendingContinuationQueue,
    bothFields.pendingContinuationQueue,
    'persisted dual-field session should keep the new queue content',
  );

  console.log('test-session-meta-store-pending-continuation-migration: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}

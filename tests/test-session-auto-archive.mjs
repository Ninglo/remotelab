#!/usr/bin/env node
import assert from 'assert/strict';
import {
  AUTO_ARCHIVE_RETENTION_HOURS,
  normalizeSessionAutoArchiveSettings,
  shouldAutoArchiveSession,
} from '../chat/session-auto-archive.mjs';

assert.deepEqual(AUTO_ARCHIVE_RETENTION_HOURS, [12, 24, 72, 168]);
assert.deepEqual(normalizeSessionAutoArchiveSettings(), {
  enabled: false,
  inactiveAfterHours: 24,
});
assert.deepEqual(normalizeSessionAutoArchiveSettings({ enabled: true, inactiveAfterHours: 72 }), {
  enabled: true,
  inactiveAfterHours: 72,
});
assert.deepEqual(normalizeSessionAutoArchiveSettings({ enabled: 'yes', inactiveAfterHours: 10 }), {
  enabled: false,
  inactiveAfterHours: 24,
});

const now = Date.parse('2026-09-14T12:00:00.000Z');
const old = { id: 'old', created: '2026-09-10T00:00:00.000Z', lastUserMessageAt: '2026-09-12T00:00:00.000Z' };
assert.equal(shouldAutoArchiveSession(old, { enabled: false, inactiveAfterHours: 12 }, { now }), false);
assert.equal(shouldAutoArchiveSession(old, { enabled: true, inactiveAfterHours: 72 }, { now }), false);
assert.equal(shouldAutoArchiveSession(old, { enabled: true, inactiveAfterHours: 12 }, { now }), true);
assert.equal(shouldAutoArchiveSession({ ...old, pinned: true }, { enabled: true, inactiveAfterHours: 12 }, { now }), false);
assert.equal(shouldAutoArchiveSession({ ...old, archived: true }, { enabled: true, inactiveAfterHours: 12 }, { now }), false);
assert.equal(shouldAutoArchiveSession({ ...old, activeRunId: 'run-1' }, { enabled: true, inactiveAfterHours: 12 }, { now }), false);
assert.equal(shouldAutoArchiveSession({ ...old, followUpQueue: [{ id: 'q' }] }, { enabled: true, inactiveAfterHours: 12 }, { now }), false);
assert.equal(shouldAutoArchiveSession({ id: 'empty', created: '2026-09-10T00:00:00.000Z' }, { enabled: true, inactiveAfterHours: 12 }, { now }), true);
assert.equal(shouldAutoArchiveSession({ id: 'invalid', created: 'not-a-date' }, { enabled: true, inactiveAfterHours: 12 }, { now }), false);

console.log('session auto-archive tests passed');

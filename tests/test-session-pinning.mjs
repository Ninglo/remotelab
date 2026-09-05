#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-pinning-'));

setIsolatedTestHome(tempHome);

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  listSessions,
  setSessionArchived,
  setSessionPinned,
  killAll,
} = sessionManager;

const baseFolder = join(tempHome, 'workspace');

const older = await createSession(baseFolder, 'codex', 'Older session');
await new Promise((resolve) => setTimeout(resolve, 25));
const newer = await createSession(baseFolder, 'codex', 'Newer session');

let listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [newer.id, older.id],
  'newer sessions should sort first before pinning',
);

const pinned = await setSessionPinned(older.id, true);
assert.equal(pinned?.pinned, true, 'pinning should persist the pinned flag');

listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [older.id, newer.id],
  'pinned sessions should sort ahead of newer unpinned sessions',
);

const unpinned = await setSessionPinned(older.id, false);
assert.equal(unpinned?.pinned, undefined, 'unpinning should clear the pinned flag');

listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [newer.id, older.id],
  'unpinned sessions should return to normal recency ordering',
);

const repinned = await setSessionPinned(older.id, true);
assert.equal(repinned?.pinned, true, 'unpinned sessions can be pinned again');

const archived = await setSessionArchived(older.id, true);
assert.equal(archived?.archived, true, 'archiving should still work for pinned sessions');
assert.equal(archived?.pinned, undefined, 'archiving should clear the pinned flag');

const restored = await setSessionArchived(older.id, false);
assert.equal(restored?.archived, undefined, 'restoring should clear the archived flag');
assert.equal(restored?.pinned, undefined, 'restoring should not silently re-pin the session');

listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [newer.id, older.id],
  'restoring should preserve the prior recency order instead of bumping the session to the top',
);

const repinnedAfterRestore = await setSessionPinned(older.id, true);
assert.equal(repinnedAfterRestore?.pinned, true, 'restored sessions can be pinned again');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-pinning: ok');

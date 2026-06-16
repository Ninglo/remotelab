#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-grouping-'));

process.env.HOME = tempHome;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getSession,
  listSessions,
  renameSession,
  updateSessionGrouping,
  killAll,
} = sessionManager;

const baseFolder = join(tempHome, 'workspace');

const unnamed = await createSession(baseFolder, 'codex', '');
assert.equal(unnamed.autoRenamePending, true, 'unnamed sessions should still await auto-rename');
assert.equal(unnamed.group, undefined, 'new unnamed sessions should not invent a group yet');
assert.equal(unnamed.description, undefined, 'new unnamed sessions should not invent a description yet');

const seeded = await createSession(baseFolder, 'codex', 'Initial title', {
  group: '  RemoteLab  ',
  description: '  Build sidebar grouping for AI sessions.  ',
});

let loaded = await getSession(seeded.id);
assert.equal(loaded.group, 'RemoteLab', 'session group should be trimmed and persisted');
assert.equal(
  loaded.description,
  'Build sidebar grouping for AI sessions.',
  'session description should be trimmed and persisted',
);

let renamed = await renameSession(seeded.id, 'Better title');
assert.equal(renamed.name, 'Better title', 'manual rename should update the title');
assert.equal(renamed.group, 'RemoteLab', 'manual rename should preserve group metadata');
assert.equal(renamed.titleLocked, true, 'manual rename should lock later automatic title refresh');
assert.equal(
  renamed.description,
  'Build sidebar grouping for AI sessions.',
  'manual rename should preserve description metadata',
);

let regrouped = await updateSessionGrouping(seeded.id, {
  group: 'Frontend',
  description: 'Track the display group and hidden session description.',
});
assert.equal(regrouped.group, 'Frontend', 'group updates should persist');
assert.equal(
  regrouped.description,
  'Track the display group and hidden session description.',
  'description updates should persist',
);

loaded = (await listSessions()).find((session) => session.id === seeded.id);
assert.equal(loaded?.group, 'Frontend', 'listSessions should expose updated group metadata');
assert.equal(
  loaded?.description,
  'Track the display group and hidden session description.',
  'listSessions should expose updated description metadata',
);

const cleared = await updateSessionGrouping(seeded.id, { group: '', description: '' });
assert.equal(cleared?.group, undefined, 'blank group updates should clear stored grouping');
assert.equal(cleared?.description, undefined, 'blank description updates should clear stored description');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-grouping: ok');

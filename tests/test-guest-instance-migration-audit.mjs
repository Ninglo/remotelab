#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  auditGuestInstanceMigration,
  formatGuestInstanceMigrationAuditResult,
  parseArgs,
} from '../lib/guest-instance-command.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-guest-audit-'));
const sourceRoot = join(tempRoot, 'source-instance');
const targetRoot = join(tempRoot, 'target-instance');
const archivePath = join(tempRoot, 'source-instance.tgz');
const legacyInstanceRoot = '/Users/legacy/.remotelab/instances/trial24';
const legacyExternalToolPath = '/Users/legacy/code/custom-tool';

mkdirSync(join(sourceRoot, 'workspace', 'project-a'), { recursive: true });
mkdirSync(join(sourceRoot, 'workspace', 'tools'), { recursive: true });
mkdirSync(join(sourceRoot, 'memory', 'tasks'), { recursive: true });
mkdirSync(join(sourceRoot, 'config'), { recursive: true });

writeFileSync(join(sourceRoot, 'workspace', 'project-a', 'app.mjs'), 'export const value = 1;\n', 'utf8');
writeFileSync(join(sourceRoot, 'workspace', 'tools', 'keep.sh'), '#!/usr/bin/env bash\necho keep\n', 'utf8');
writeFileSync(
  join(sourceRoot, 'memory', 'tasks', 'logic.md'),
  [
    `Inside root helper: ${legacyInstanceRoot}/workspace/tools/keep.sh`,
    `External helper: ${legacyExternalToolPath}`,
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(sourceRoot, 'config', 'chat-sessions.json'),
  JSON.stringify([
    {
      id: 'sess_keep',
      name: 'Keep project',
      folder: `${legacyInstanceRoot}/workspace/project-a`,
    },
    {
      id: 'sess_outside',
      name: 'Outside tool',
      folder: legacyExternalToolPath,
    },
  ], null, 2),
  'utf8',
);
writeFileSync(
  join(sourceRoot, 'config', 'tools.json'),
  JSON.stringify([{ id: 'codex', command: 'codex' }], null, 2),
  'utf8',
);

mkdirSync(join(targetRoot, 'workspace', 'project-a'), { recursive: true });
mkdirSync(join(targetRoot, 'memory', 'tasks'), { recursive: true });
mkdirSync(join(targetRoot, 'config'), { recursive: true });

writeFileSync(join(targetRoot, 'workspace', 'project-a', 'app.mjs'), 'export const value = 1;\n', 'utf8');
writeFileSync(
  join(targetRoot, 'memory', 'tasks', 'logic.md'),
  [
    `Inside root helper: ${legacyInstanceRoot}/workspace/tools/keep.sh`,
    `External helper: ${legacyExternalToolPath}`,
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(targetRoot, 'config', 'chat-sessions.json'),
  JSON.stringify([
    {
      id: 'sess_keep',
      name: 'Keep project',
      folder: `${targetRoot}/workspace/project-a`,
    },
  ], null, 2),
  'utf8',
);
writeFileSync(
  join(targetRoot, 'config', 'tools.json'),
  JSON.stringify([{ id: 'codex', command: 'codex' }], null, 2),
  'utf8',
);

const tarResult = spawnSync('tar', ['-czf', archivePath, '-C', tempRoot, 'source-instance'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(tarResult.status, 0, tarResult.stderr || tarResult.stdout || 'tar should create the source archive');

const parsed = parseArgs(['audit-migration', 'trial24', '--source', archivePath, '--json']);
assert.equal(parsed.command, 'audit-migration');
assert.equal(parsed.name, 'trial24');
assert.equal(parsed.source, archivePath);
assert.equal(parsed.json, true);

try {
  const result = await auditGuestInstanceMigration({
    name: 'trial24',
    source: archivePath,
    instanceRoot: targetRoot,
  });

  assert.equal(result.summary.safeToRetireSource, false, 'audit should block source retirement when code and dependencies are missing');
  assert.equal(result.summary.missingPortableFileCount, 1, 'audit should report missing portable files');
  assert.equal(result.summary.missingSessionCount, 1, 'audit should report missing session records');
  assert.equal(result.summary.externalMissingSessionFolderCount, 1, 'audit should report external session folders still pointing outside the migrated root');
  assert.equal(result.summary.externalMissingPathReferenceCount, 1, 'audit should report unresolved external path references');
  assert.equal(result.summary.mappedMissingPathReferenceCount, 1, 'audit should report unresolved mapped path references inside the migrated root');
  assert.equal(result.summary.missingLikelyCodeFileCount, 1, 'audit should highlight missing code/script files');

  assert.deepEqual(
    result.missingPortableFiles.map((entry) => entry.path),
    ['workspace/tools/keep.sh'],
    'audit should identify missing workspace code',
  );
  assert.deepEqual(
    result.missingLikelyCodeFiles.map((entry) => entry.path),
    ['workspace/tools/keep.sh'],
    'missing code helper should surface in the likely-code subset',
  );
  assert.deepEqual(
    result.missingSessions.map((entry) => entry.id),
    ['sess_outside'],
    'source session ids missing on target should be reported',
  );

  const outsideSession = result.sessionFolders.find((entry) => entry.folder === legacyExternalToolPath);
  assert.equal(outsideSession?.status, 'external_missing', 'external session folders should be flagged');

  const mappedReference = result.pathReferences.find((entry) => entry.path.endsWith('/workspace/tools/keep.sh'));
  assert.equal(mappedReference?.status, 'mapped_missing', 'inside-root path references should map into the target root and fail if missing');
  assert.equal(mappedReference?.mappedTargetPath, join(targetRoot, 'workspace', 'tools', 'keep.sh'));

  const externalReference = result.pathReferences.find((entry) => entry.path === legacyExternalToolPath);
  assert.equal(externalReference?.status, 'external_missing', 'external path references should remain visible as unresolved dependencies');

  const formatted = formatGuestInstanceMigrationAuditResult(result);
  assert.match(formatted, /status: needs-review/);
  assert.match(formatted, /missingFile: workspace\/tools\/keep\.sh/);
  assert.match(formatted, /externalSessionFolder: \/Users\/legacy\/code\/custom-tool/);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const tempRoot2 = mkdtempSync(join(tmpdir(), 'remotelab-guest-audit-advisory-'));
const sourceRoot2 = join(tempRoot2, 'source-instance');
const targetRoot2 = join(tempRoot2, 'target-instance');
const legacyRepoRoot = '/Users/legacy/code/remotelab';
const legacyRepoToolPath = `${legacyRepoRoot}/scripts/micro-agent-router.mjs`;
const ephemeralSessionFolder = '/var/folders/s6/demo123/T/remotelab-session-source-context-AbCdEf';
const ephemeralPathReference = '/tmp/report-build.XXXXXX';

mkdirSync(join(sourceRoot2, 'memory', 'tasks'), { recursive: true });
mkdirSync(join(sourceRoot2, 'config'), { recursive: true });
mkdirSync(join(targetRoot2, 'memory', 'tasks'), { recursive: true });
mkdirSync(join(targetRoot2, 'config'), { recursive: true });

writeFileSync(
  join(sourceRoot2, 'memory', 'tasks', 'logic.md'),
  [
    `Repo helper: ${legacyRepoToolPath}`,
    `Scratch output: ${ephemeralPathReference}`,
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(targetRoot2, 'memory', 'tasks', 'logic.md'),
  [
    `Repo helper: ${legacyRepoToolPath}`,
    `Scratch output: ${ephemeralPathReference}`,
    '',
  ].join('\n'),
  'utf8',
);
writeFileSync(
  join(sourceRoot2, 'config', 'chat-sessions.json'),
  JSON.stringify([
    {
      id: 'sess_repo',
      name: 'Repo session',
      folder: legacyRepoRoot,
    },
    {
      id: 'sess_tmp',
      name: 'Ephemeral session',
      folder: ephemeralSessionFolder,
    },
  ], null, 2),
  'utf8',
);
writeFileSync(
  join(targetRoot2, 'config', 'chat-sessions.json'),
  JSON.stringify([
    {
      id: 'sess_repo',
      name: 'Repo session',
      folder: repoRoot,
    },
    {
      id: 'sess_tmp',
      name: 'Ephemeral session',
      folder: repoRoot,
    },
  ], null, 2),
  'utf8',
);
writeFileSync(
  join(sourceRoot2, 'config', 'ui-runtime-selection.json'),
  JSON.stringify({ defaultToolId: 'claude' }, null, 2),
  'utf8',
);
writeFileSync(
  join(targetRoot2, 'config', 'ui-runtime-selection.json'),
  JSON.stringify({ defaultToolId: 'codex' }, null, 2),
  'utf8',
);
writeFileSync(
  join(sourceRoot2, 'config', 'tools.json'),
  JSON.stringify([{ id: 'micro-agent', command: legacyRepoToolPath }], null, 2),
  'utf8',
);
writeFileSync(
  join(targetRoot2, 'config', 'tools.json'),
  JSON.stringify([{ id: 'micro-agent', command: legacyRepoToolPath }], null, 2),
  'utf8',
);

try {
  const result = await auditGuestInstanceMigration({
    name: 'trial24',
    source: sourceRoot2,
    instanceRoot: targetRoot2,
  });

  assert.equal(result.summary.contentMismatchCount, 1, 'advisory drift should still be visible in the audit');
  assert.equal(result.summary.blockingContentMismatchCount, 0, 'known mutable drift should not count as a blocking mismatch');
  assert.equal(result.summary.externalMissingSessionFolderCount, 0, 'ephemeral session folders should not count as unresolved external blockers');
  assert.equal(result.summary.externalMissingPathReferenceCount, 0, 'ephemeral or mapped path references should not count as unresolved external blockers');
  assert.equal(result.summary.safeToRetireSource, true, 'legacy repo paths and ephemeral temp paths should not block source retirement');

  const repoSession = result.sessionFolders.find((entry) => entry.folder === legacyRepoRoot);
  assert.equal(repoSession?.status, 'mapped_present', 'legacy repo session folders should map onto the current project root');
  assert.equal(repoSession?.mappedTargetPath, repoRoot);

  const tempSession = result.sessionFolders.find((entry) => entry.folder === ephemeralSessionFolder);
  assert.equal(tempSession?.status, 'ephemeral_missing', 'ephemeral temp session folders should be classified separately');

  const repoReference = result.pathReferences.find((entry) => entry.path === legacyRepoToolPath);
  assert.equal(repoReference?.status, 'mapped_present', 'legacy repo path references should map onto the current project root');
  assert.equal(repoReference?.mappedTargetPath, join(repoRoot, 'scripts', 'micro-agent-router.mjs'));

  const tempReference = result.pathReferences.find((entry) => entry.path === ephemeralPathReference);
  assert.equal(tempReference?.status, 'ephemeral_missing', 'ephemeral temp path references should be classified separately');

  const formatted = formatGuestInstanceMigrationAuditResult(result);
  assert.match(formatted, /status: ready-to-retire-source/);
  assert.match(formatted, /blockingContentMismatches: 0/);
} finally {
  rmSync(tempRoot2, { recursive: true, force: true });
}

console.log('test-guest-instance-migration-audit: ok');

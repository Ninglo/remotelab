import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkMemoryWorkspace, prepareMemoryWorkspace, validateWorkspace } from '../scripts/memory-governance-preflight.mjs';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'remotelab-governance-preflight-'));
const production = join(root, 'production'), workspace = join(root, 'prepared');
try {
  await mkdir(production);
  const source = join(production, 'projects.md'), missing = join(production, 'project-registry.json');
  await writeFile(source, 'Accepted original project state.\n');
  const before = await readFile(source);
  const args = { workspace, protectedRoots: [production], sources: [{ label: 'projects', path: source }, { label: 'registry', path: missing }] };
  const report = await prepareMemoryWorkspace(args);
  assert.equal(report.ok, true);
  assert.equal(report.readyForCollection, false);
  assert.equal(report.snapshotCount, 1);
  assert.deepEqual(report.missingSources, ['registry']);
  assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  assert.equal((await stat(join(workspace, 'policy.json'))).mode & 0o777, 0o600);
  await assert.rejects(prepareMemoryWorkspace(args), /empty/);
  for (const path of [production, join(production, 'shadow'), root]) {
    await assert.rejects(validateWorkspace(path, [production]), /overlap/);
  }
  await assert.rejects(validateWorkspace('relative-path', [production]), /absolute/);
  await assert.rejects(validateWorkspace(join(root, 'other'), []), /Protected/);
  const alias = join(root, 'prod-alias');
  await symlink(production, alias, 'dir');
  await assert.rejects(validateWorkspace(join(alias, 'new'), [production]), /overlap/);

  const policyFile = join(workspace, 'policy.json'), originalPolicy = await readFile(policyFile, 'utf8');
  const mutations = [
    p => { p.stage = 'shadow'; },
    ...['collection','foregroundRetrieval','formalWrites','delivery','skillPromotion','businessActions'].map(k => p => { p.permissions[k] = true; }),
    p => { delete p.permissions.formalWrites; },
    p => { p.resources.modelCalls = 1; },
    p => { p.resources.dailyTokens = 1000; },
    p => { p.foreground.extraRequiredModelCalls = 1; },
    p => { p.scope.allRegisteredProjectsRequired = false; },
    p => { p.scope.coverage = 'complete'; },
    p => { p.executeCommand = 'anything'; },
  ];
  for (const mutate of mutations) {
    const policy = JSON.parse(originalPolicy); mutate(policy);
    await writeFile(policyFile, JSON.stringify(policy));
    await assert.rejects(checkMemoryWorkspace(args));
  }
  await writeFile(policyFile, originalPolicy);
  await writeFile(source, 'A newer real project update must survive.\n');
  const drift = await checkMemoryWorkspace(args);
  assert.equal(drift.ok, false); assert.deepEqual(drift.changedSources, ['projects']);
  assert.equal(await readFile(source, 'utf8'), 'A newer real project update must survive.\n');
  await writeFile(source, before);
  await writeFile(missing, '{}');
  assert.deepEqual((await checkMemoryWorkspace(args)).changedSources, ['registry']);
  await unlink(missing);

  const baseline = JSON.parse(await readFile(join(workspace, 'baseline.json'), 'utf8'));
  const entry = baseline.entries.find(e => !e.missing);
  const blob = join(workspace, 'baseline', entry.label + '-' + entry.sha256 + '.blob');
  await writeFile(blob, 'corrupted snapshot');
  await assert.rejects(checkMemoryWorkspace(args), /integrity/);
  await writeFile(blob, before);
  const otherLink = join(root, 'linked-snapshot');
  await link(blob, otherLink); await assert.rejects(checkMemoryWorkspace(args), /independent/); await unlink(otherLink);
  const moved = join(root, 'original-snapshot');
  await writeFile(moved, before); await unlink(blob); await symlink(moved, blob);
  await assert.rejects(checkMemoryWorkspace(args), /regular/); await unlink(blob); await writeFile(blob, before, { mode: 0o600 });
  await chmod(blob, 0o600);
  const modulePath = fileURLToPath(new URL('../scripts/memory-governance-preflight.mjs', import.meta.url));
  const env = { ...process.env, REMOTELAB_MEMORY_DIR: production };
  const cli = await run(process.execPath, [modulePath, 'check', '--workspace', workspace], { env });
  assert.equal(JSON.parse(cli.stdout).readyForCollection, false);
  await assert.rejects(run(process.execPath, [modulePath, 'start', '--workspace', workspace], { env }), e => e.code === 2);
  await assert.rejects(run(process.execPath, [modulePath, 'check', '--workspace', workspace, '--activate', 'true'], { env }), e => e.code === 2);
  assert.deepEqual(await readFile(source), before);
  assert.equal((await checkMemoryWorkspace(args)).ok, true);
  console.log('test-memory-governance-preflight: ok; 14 policy mutations, production/ancestor/symlink paths, tampered and linked snapshots, source drift and unsupported activation rejected; production untouched');
} finally { await rm(root, { recursive: true, force: true }); }

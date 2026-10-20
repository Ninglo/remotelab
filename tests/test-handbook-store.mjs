import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'handbook-store-'));
setIsolatedTestHome(home);
const memoryDir = join(home, 'memory');
process.env.REMOTELAB_MEMORY_DIR = memoryDir;
const m = await import('../chat/memory-learning.mjs');
const authDocument = { people: [{ id: 'person_alpha',
  identities: [{ id: 'identity_alpha', kind: 'web', subjectId: 'alpha' }] }] };
const actor = { personId: 'person_alpha', identityId: 'identity_alpha', authDocument, memoryDir };
const paths = m.learningPaths(memoryDir, actor.personId);
const sources = n => [{ type: 'user', sessionId: `s${n}`, runId: `run_${n}`, seq: 1, output: '这个方法已验证，继续保留证据' },
  { type: 'tool', sessionId: `s${n}`, runId: `run_${n}`, seq: 2, output: '{"code":0}', exitCode: 0 }];
const method = { key: 'method-0', kind: 'method', scope: 'instance', content: '执行前核对资源与身份。',
  conditions: '测试条件', exceptions: '保留例外', cues: ['权限', '飞书'], tested: true,
  evidence: [{ seq: 2, quote: '"code":0' }] };
const apply = (updates, n = 1, extra = {}) => m.applyLearningUpdates({ ...actor, updates, sources: sources(n), ...extra });
const inspect = extra => m.inspectLearning({ ...actor, ...extra });
const maintain = (action, extra = {}) => m.maintainHandbook({ ...actor, action, ...extra });
const legacy = entries => 'MANUAL PREFIX\n<!-- remotelab-learning:start -->\n<!-- remotelab-learning-data:'
  + Buffer.from(JSON.stringify({ version: 1, entries })).toString('base64')
  + ' -->\n<!-- remotelab-learning:end -->\nMANUAL SUFFIX\n';
const byId = entries => [...entries].sort((a, b) => a.id.localeCompare(b.id));

try {
  await mkdir(join(memoryDir, 'reference', 'people'), { recursive: true });
  await writeFile(join(memoryDir, 'learning-policy.json'), JSON.stringify({
    version: 1, enabled: true, profiles: true, handbook: true, context: true, personIds: ['person_alpha'],
  }));
  await writeFile(paths.profile, 'PERSON ORIGINAL');
  assert.equal((await apply([method])).promotedCount, 1);
  const seed = (await inspect()).handbook.entries[0];
  // 1,200 methods: both legacy and the current-record set exceed 2 MiB.
  const entries = Array.from({ length: 1200 }, (_, i) => ({
    ...structuredClone(seed), id: i ? `mem_fixture_${i}` : seed.id, key: `method-${i}`,
    content: i ? `方法 ${i}：${'执行检查。'.repeat(100)}` : seed.content,
    cues: i ? ['权限'] : ['权限', '飞书'], updatedAt: i ? '2026-12-01' : '2026-01-01',
    history: [{ version: 0, content: '旧版'.repeat(400), supportingEvidence: [{ quote: `original ${i}` }] }],
    evidence: Array.from({ length: 6 }, (_, n) => ({ type: 'tool', seq: n + 2,
      sessionId: `s${n}`, runId: `run_${n}`, quote: '证据'.repeat(160) })),
    outcomes: [{ memoryVersion: 1, quote: '已应用', reason: '具体结果' }],
  }));
  const original = legacy(entries);
  assert.ok(Buffer.byteLength(original) > 2 * 1024 * 1024);
  await writeFile(paths.handbook, original);
  assert.equal((await inspect()).unavailable[0].kind, 'handbook');
  const migration = await maintain('migrate');
  assert.equal(migration.entries, entries.length);
  assert.equal(await readFile(migration.backup, 'utf8'), original);
  assert.equal((await maintain('migrate')).changed, false, 'conversion is idempotent');
  assert.equal(await readFile(paths.profile, 'utf8'), 'PERSON ORIGINAL');
  const pointer = await readFile(paths.handbook, 'utf8');
  assert.match(pointer, /MANUAL PREFIX/);
  assert.match(pointer, /MANUAL SUFFIX/);
  assert.ok(Buffer.byteLength(pointer) < 2500);
  assert.throws(() => m.parseLearningDocument(pointer), /Missing managed memory data/,
    'old writer cannot reinterpret v2 as an empty legacy document');
  assert.deepEqual(byId((await inspect()).handbook.entries), byId(entries));
  const compact = (await inspect({ summary: true })).handbook;
  assert.ok(compact.storage.currentBytes > 2 * 1024 * 1024, 'current set has no aggregate size ceiling');
  assert.equal(compact.entries[0].history.length, 0);
  assert.equal(compact.storage.archiveCounts.history, 1200);
  assert.equal(compact.storage.archiveCounts.outcomes, 1200);
  const keySnapshot = await inspect({ key: method.key });
  assert.equal(keySnapshot.handbook.entries.length, 1);
  assert.deepEqual(keySnapshot.handbook.entries[0], entries[0]);
  const context = await m.buildLearningContext({ ...actor, query: '飞书权限' });
  assert.ok(context.length <= 6000);
  assert.ok(context.indexOf(seed.id) >= 0, 'older specific match outranks recent generic matches');
  assert.doesNotMatch(context, /original 0|旧版|remotelab-learning-data/);
  await writeFile(paths.profile, legacy(Array.from({ length: 20 }, (_, i) => ({
    ...structuredClone(seed), id: `mem_person_${i}`, kind: 'preference', status: 'withdrawn',
    content: `PERSON_WITHDRAWAL_${i}`, updatedAt: '2030-01-01',
  }))));
  assert.doesNotMatch(await m.buildLearningContext({ ...actor, query: '飞书权限' }), new RegExp(seed.id),
    'default mixed-source budget behavior is unchanged');
  const methodsOnly = await m.buildLearningContext({ ...actor, query: '飞书权限', handbookOnly: true });
  assert.match(methodsOnly, new RegExp(seed.id));
  assert.doesNotMatch(methodsOnly, /PERSON_WITHDRAWAL/);
  await writeFile(paths.profile, '<!-- remotelab-learning:start -->broken');
  assert.equal((await inspect({ handbookOnly: true, summary: true })).unavailable.length, 0);
  await writeFile(paths.profile, 'PERSON ORIGINAL');
  const root = join(`${paths.handbook}.store`, migration.generation);
  const currentPath = join(root, 'current', `${seed.id}.json`);
  const firstRecord = JSON.parse(await readFile(currentPath, 'utf8'));
  const firstObjectPath = join(root, 'objects', `${firstRecord.head}.json`);
  const firstObject = await readFile(firstObjectPath, 'utf8');
  await writeFile(firstObjectPath, 'corrupt archive');
  assert.match(await m.buildLearningContext({ ...actor, query: '飞书权限' }), /执行前核对资源/,
    'routine retrieval reads current records, not history archives');
  assert.equal((await inspect({ key: method.key })).unavailable[0].kind, 'handbook');
  assert.equal((await apply([{ ...method, expectedVersion: seed.version }], 50)).promotedCount, 0);
  assert.equal(JSON.parse(await readFile(currentPath, 'utf8')).head, firstRecord.head);
  await writeFile(firstObjectPath, firstObject);
  let reviewCalls = 0;
  await m.reviewMemoryLearning({ ...actor, sessionId: 'review', session: {}, run: { id: 'run_review' },
    userMessage: '飞书权限', sourceEventSeq: 1, assistantTurnText: '已检查', turnEvents: [],
    runPrompt: async prompt => {
      reviewCalls++;
      assert.match(prompt, /method-0/);
      assert.doesNotMatch(prompt, /original 0|旧版/);
      return '{"updates":[]}';
    } });
  assert.equal(reviewCalls, 1, 'post-turn reviewer reads v2 current records');

  // A real update uses the existing validators; counterexample, revision,
  // outcomes and withdrawal remain reconstructable across archive deltas.
  let current = entries[0];
  let result = await apply([{ ...method, action: 'counterexample', expectedVersion: current.version,
    evidence: [{ seq: 1, quote: '这个方法已验证' }] }], 20);
  assert.equal(result.results[0].status, 'observed');
  assert.doesNotMatch(await m.buildLearningContext({ ...actor, query: '飞书权限' }), new RegExp(seed.id));
  current = (await inspect({ key: method.key })).handbook.entries[0];
  result = await apply([{ ...method, action: 'revise', expectedVersion: current.version,
    content: `${method.content} 修订条件。` }], 21);
  assert.equal(result.results[0].status, 'verified');
  current = (await inspect({ key: method.key })).handbook.entries[0];
  assert.equal(current.history.at(-1).supportingEvidence.length, 6);
  assert.equal(current.counterexamples[0].resolvedInVersion, current.version);
  const outcome = { ...method, action: 'outcome', expectedVersion: current.version, reason: '具体执行结果' };
  assert.equal((await apply([outcome], 22)).promotedCount, 0, 'retrieval receipt still required');
  assert.equal((await apply([outcome], 22, { delivered: [{ id: current.id, version: current.version }] })).promotedCount, 1);
  current = (await inspect({ key: method.key })).handbook.entries[0];
  const beforeGrowth = (await stat(currentPath)).size;
  for (let i = 0; i < 40; i++) {
    result = await apply([{ ...method, content: current.content, expectedVersion: current.version }], 100 + i);
    assert.equal(result.promotedCount, 1);
    current = (await inspect({ key: method.key })).handbook.entries[0];
  }
  assert.ok((await stat(currentPath)).size < beforeGrowth + 1000, 'history growth does not inflate the current record');
  const last = JSON.parse(await readFile(currentPath, 'utf8'));
  const delta = JSON.parse(await readFile(join(root, 'objects', `${last.head}.json`), 'utf8'));
  assert.equal(delta.arrays.history.append.length, 1);
  assert.equal(delta.arrays.evidence.append.length, 1);
  assert.ok(!delta.value, 'updates append a delta, not another whole history');

  // Concurrent independent processes share the same lock and version contract.
  const update = { ...method, content: current.content, expectedVersion: current.version };
  const program = `const m = await import(${JSON.stringify(resolve('chat/memory-learning.mjs'))});
    const p=JSON.parse(process.argv[1]); console.log(JSON.stringify(await m.applyLearningUpdates(p)));`;
  const children = await Promise.all([201, 202].map(n => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', program, JSON.stringify({ ...actor, updates: [update], sources: sources(n) })])));
  assert.equal(children.map(c => JSON.parse(c.stdout).promotedCount).reduce((a, b) => a + b), 1);
  current = (await inspect({ key: method.key })).handbook.entries[0];
  assert.equal(current.version, update.expectedVersion + 1);
  result = await apply([{ ...method, action: 'withdraw', expectedVersion: current.version }], 203);
  assert.equal(result.results[0].status, 'withdrawn');
  assert.match(await m.buildLearningContext({ ...actor, query: '飞书权限' }), /withdrawn/);
  const restoredVersion = result.results[0].version;
  assert.equal((await apply([{ ...method, expectedVersion: restoredVersion }], 204)).promotedCount, 0);
  assert.equal((await apply([{ ...method, action: 'restore', explicit: true, expectedVersion: restoredVersion,
    evidence: [{ seq: 1, quote: '这个方法已验证' }, { seq: 2, quote: '"code":0' }] }], 205)).promotedCount, 1);
  const newEntry = { ...method, key: 'brand-new-method' };
  assert.equal((await apply([newEntry], 206)).promotedCount, 1);
  const latest = (await inspect()).handbook.entries;
  assert.equal(latest.length, 1201);
  const output = join(home, 'complete.md');
  await maintain('export', { file: output });
  assert.deepEqual(byId(m.parseLearningDocument(await readFile(output, 'utf8')).entries), byId(latest));
  await assert.rejects(maintain('export', { file: output }), /EEXIST/);
  await maintain('rollback');
  assert.deepEqual(byId(m.parseLearningDocument(await readFile(paths.handbook, 'utf8')).entries), byId(latest),
    'rollback includes all post-migration changes');
  assert.equal(await readFile(migration.backup, 'utf8'), original);
  await maintain('migrate');
  assert.deepEqual(byId((await inspect()).handbook.entries), byId(latest));

  // Malformed migration and pre-existing locks leave the original intact.
  await mkdir(`${paths.handbook}.learning-lock`);
  await assert.rejects(maintain('rollback'), /EEXIST/);
  await rm(`${paths.handbook}.learning-lock`, { recursive: true });
  const activePointer = await readFile(paths.handbook, 'utf8');
  await writeFile(paths.handbook, '<!-- remotelab-learning:start -->broken');
  await assert.rejects(maintain('migrate'), /Malformed managed/);
  assert.equal(await readFile(paths.handbook, 'utf8'), '<!-- remotelab-learning:start -->broken');
  const partialMigration = legacy([seed, { ...seed, id: '../invalid' }]);
  await writeFile(paths.handbook, partialMigration);
  await assert.rejects(maintain('migrate'), /Invalid handbook entry ID/);
  assert.equal(await readFile(paths.handbook, 'utf8'), partialMigration,
    'failure after writing staged entries never publishes an incomplete store');
  const oversizedManual = 'm'.repeat(2 * 1024 * 1024) + legacy([seed]);
  await writeFile(paths.handbook, oversizedManual);
  await assert.rejects(maintain('migrate'), /manual text exceeds/);
  assert.equal(await readFile(paths.handbook, 'utf8'), oversizedManual);
  await writeFile(paths.handbook, activePointer);
  const active = (await inspect({ summary: true })).handbook.generation;
  const activeRoot = join(`${paths.handbook}.store`, active);
  const target = join(activeRoot, 'current', `${seed.id}.json`);
  const saved = await readFile(target, 'utf8');
  const outside = join(home, 'outside');
  await writeFile(outside, saved);
  await rm(target);
  await symlink(outside, target);
  assert.equal((await inspect()).unavailable[0].kind, 'handbook');
  const unrelated = latest.find(e => e.id !== seed.id);
  const direct = await inspect({ key: unrelated.id });
  assert.equal(direct.unavailable.length, 0, 'known ID lookup does not scan unrelated current files');
  assert.deepEqual(direct.handbook.entries, [unrelated]);
  assert.equal(await readFile(outside, 'utf8'), saved);
  console.log(JSON.stringify({ verified: true, migratedEntries: 1200,
    legacyBytes: Buffer.byteLength(original), currentBytes: compact.storage.currentBytes,
    revisionsAdded: 40, latestEntries: latest.length, archiveObjects: (await readdir(join(root, 'objects'))).length,
    checks: 'exact round-trip, >2MiB current set, bounded retrieval, archive independence/corruption, relevance, incremental growth, two-process concurrency, versions/counterexamples/outcomes/withdraw/restore, export/latest rollback/remigration, lock/malformed/symlink preservation' }));
} finally { await rm(home, { recursive: true, force: true }); }

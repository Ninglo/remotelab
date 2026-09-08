import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-file-diff-'));
setIsolatedTestHome(root);
try {
  const { createCodexFileChangeCapture, nativeFileDiff } = await import('../chat/codex-file-changes.mjs');
  const { createCodexAdapter } = await import('../chat/adapters/codex.mjs');
  const history = await import('../chat/history.mjs');
  const { buildEventBlockEvents } = await import('../chat/session-display-events.mjs');
  const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
  const log = join(root, 'provider.jsonl');
  const stamp = '2026-09-08T10:00:01Z';
  const diff = '@@ -1,2 +1,2 @@\n-old\n+new <private>literal code</private>\n context\n';
  const record = (id, path, patch = diff, status = 'completed') => ({
    timestamp: stamp, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread',
      item: { type: 'FileChange', id, status, changes: { [path]: { type: 'update', unified_diff: patch } } } },
  });
  const stdout = (id, path, status = 'completed') => ({ type: 'item.completed', item: {
    id, type: 'file_change', status, changes: [{ path, kind: 'update' }],
  } });
  assert.equal(nativeFileDiff({ type: 'add', content: 'hello\n' }), '@@ -0,0 +1,1 @@\n+hello\n');
  assert.equal(nativeFileDiff({ type: 'delete', content: 'bye' }), '@@ -1,1 +0,0 @@\n-bye\n\\ No newline at end of file\n');
  assert.equal(nativeFileDiff({ type: 'add', content: '' }), '');
  assert.equal(nativeFileDiff({ type: 'add', content: '\0binary' }), null);
  await writeFile(log, JSON.stringify({ ...record('old', '/a'), timestamp: '2026-09-07T10:00:00Z' }) + '\n');
  await appendFile(log, JSON.stringify(record('native-1', '/a')) + '\n');
  const capture = createCodexFileChangeCapture({ startedAt: '2026-09-08T10:00:00Z', locateLog: async () => log });
  const captured = await capture.enrich(stdout('item_1', '/a'), 'thread');
  assert.equal(captured.item.changes[0].diff, diff);
  assert.equal(captured.item.changes[0].diffSource, 'codex_session');
  await appendFile(log, JSON.stringify(record('native-2', '/a', diff.replace('new', 'next'), 'failed')) + '\n');
  const second = await capture.enrich(stdout('item_2', '/a', 'failed'), 'thread');
  assert.equal(second.item.changes[0].diff, diff.replace('new', 'next'), 'repeated edits preserve their own patch and failure status');
  assert.deepEqual(await capture.enrich(stdout('item_2', '/a', 'failed'), 'thread'), second, 'immediate completion replay is idempotent');
  const resumed = createCodexFileChangeCapture({ startedAt: stamp, locateLog: async () => log });
  await resumed.prepare('thread');
  const partial = JSON.stringify(record('native-3', '/a', diff.replace('new', '第三次')));
  await appendFile(log, partial.slice(0, -8));
  const appendRemainder = new Promise(resolve => setTimeout(async () => {
    await appendFile(log, partial.slice(-8) + '\n'); resolve();
  }, 10));
  assert.equal((await resumed.enrich(stdout('item_3', '/a'), 'thread')).item.changes[0].diff, diff.replace('new', '第三次'), 'resume skips prior bytes; partial records wait for completion');
  await appendRemainder;
  await appendFile(log, JSON.stringify(record('native-4', '/different')) + '\n');
  assert.equal((await resumed.enrich(stdout('item_4', '/a'), 'thread')).item.changes[0].diff, undefined, 'mismatched operation must not borrow a later patch');
  await appendFile(log, JSON.stringify(record('native-5', '/a')) + '\n');
  assert.equal((await resumed.enrich(stdout('item_5', '/a'), 'thread')).item.changes[0].diff, undefined, 'ambiguous completion order stays fail-closed');
  const runs = await import('../chat/runs.mjs');
  const largeDiff = '@@ -1,1 +1,12000 @@\n-old\n' + '+new line\n'.repeat(12000);
  const largeEvent = stdout('large', '/large');
  largeEvent.item.changes[0].diff = largeDiff;
  await runs.appendRunSpoolRecord('run_diff_test', { stream: 'stdout', json: largeEvent });
  const spool = await runs.readRunSpoolRecords('run_diff_test');
  assert.ok(spool[0].json.item.changes[0].diffArtifact, 'large patches externalize in the raw spool too');
  const restored = JSON.parse(await runs.materializeRunSpoolLine('run_diff_test', spool[0]));
  assert.equal(restored.item.changes[0].diff, largeDiff, 'spool projection gets full patch, never its clipped preview');
  // Exercise the actual detached sidecar with a deterministic local runtime. It
  // really changes a temp file; the native-log/stdout contract mirrors Codex.
  const { CONFIG_DIR } = await import('../lib/config.mjs');
  const bin = join(root, 'bin');
  const provider = join(root, 'codex');
  await mkdir(bin);
  await mkdir(join(provider, 'sessions'), { recursive: true });
  await mkdir(CONFIG_DIR, { recursive: true });
  const command = join(bin, 'diff-runtime');
  const target = join(root, 'actual-file.txt');
  const nativeLog = join(provider, 'sessions', 'rollout-diff-thread.jsonl');
  await writeFile(target, 'old\n');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const emit = value => console.log(JSON.stringify(value));
emit({type:'thread.started',thread_id:'diff-thread'});
emit({type:'turn.started'});
fs.writeFileSync(${JSON.stringify(target)}, 'new\\n');
fs.writeFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({timestamp:new Date().toISOString(),type:'event_msg',payload:{type:'item_completed',thread_id:'diff-thread',item:{type:'FileChange',id:'native-real',status:'completed',changes:{[${JSON.stringify(target)}]:{type:'update',unified_diff:'@@ -1 +1 @@\\n-old\\n+new\\n'}}}}})+'\\n');
emit({type:'item.completed',item:{id:'item_0',type:'file_change',status:'completed',changes:[{path:${JSON.stringify(target)},kind:'update'}]}});
emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
`, { mode: 0o755 });
  await writeFile(join(CONFIG_DIR, 'tools.json'), JSON.stringify([{ id: 'diff-runtime', name: 'Diff fixture', command, runtimeFamily: 'codex-json' }]));
  const realRun = await runs.createRun({
    status: { sessionId: 'real-diff', requestId: 'diff-fixture', state: 'accepted', tool: 'diff-runtime' },
    manifest: { sessionId: 'real-diff', requestId: 'diff-fixture', tool: 'diff-runtime', folder: root, prompt: 'fixture', options: {} },
  });
  await promisify(execFile)(process.execPath, ['chat/runner-sidecar.mjs', realRun.id], {
    timeout: 15000,
    env: { ...process.env, REMOTELAB_MACHINE_CODEX_HOME: provider,
      REMOTELAB_USER_SHELL_ENV_B64: Buffer.from(JSON.stringify({ shell: '/bin/sh', mode: 'test', env: {} })).toString('base64') },
  });
  assert.equal((await runs.getRun(realRun.id)).state, 'completed');
  const realSpool = await runs.readRunSpoolRecords(realRun.id);
  const realChange = realSpool.find(row => row.json?.item?.type === 'file_change');
  assert.equal(realChange?.json.item.changes[0].diff, '@@ -1 +1 @@\n-old\n+new\n', 'sidecar captures native diff before durable spool write');
  await history.appendEvents('real-diff', createCodexAdapter().parseLine(await runs.materializeRunSpoolLine(realRun.id, realChange)));
  await rm(provider, { recursive: true });
  await rm(runs.runDir(realRun.id), { recursive: true });
  await writeFile(target, 'changed again\n');
  assert.equal((await history.readEventBody('real-diff', 1)).value, '@@ -1 +1 @@\n-old\n+new\n', 'history owns the patch after native log/spool deletion and later workspace edits');
  const events = [captured, second].flatMap(x => createCodexAdapter().parseLine(JSON.stringify(x)));
  await history.appendEvents('fixture', events);
  const index = await history.readEventsAfter('fixture');
  assert.equal(index[0].diff, '');
  assert.equal(index[0].bodyAvailable, true);
  assert.equal(index[0].diffStats.additions, 1);
  assert.equal(index[0].diffStats.deletions, 1);
  assert.equal(index[0].toolCallId, 'item_1');
  const stored = JSON.parse(await readFile(join(CHAT_HISTORY_DIR, 'fixture/events/000000001.json'), 'utf8'));
  assert.equal(stored.diff, '', 'full patch is not duplicated in the event index');
  assert.equal(await readFile(join(CHAT_HISTORY_DIR, 'fixture/bodies', stored.bodyRef + '.txt'), 'utf8'), diff);
  const blocks = buildEventBlockEvents(await history.loadHistory('fixture', { deferFileDiffs: true }), 1, 2);
  assert.equal(blocks[0].diff, '');
  assert.equal(blocks[0].bodyAvailable, true, 'hidden-block projection retains lazy diff metadata');
  await rm(log);
  await history.setContextHead('fixture', { activeFromSeq: 2, compactedThroughSeq: 1 });
  const restarted = await import('../chat/history.mjs?restart=diff-test');
  assert.equal((await restarted.readEventBody('fixture', 1)).value, diff, 'provider log removal and compaction do not expire the patch');
  assert.equal((await restarted.readEventBody('fixture', 2)).value, diff.replace('new', 'next'));
  await history.appendEvents('fork', await history.loadHistory('fixture'));
  await rm(join(CHAT_HISTORY_DIR, 'fixture'), { recursive: true });
  assert.equal((await restarted.readEventBody('fork', 1)).value, diff, 'fork owns its own patch body');
  const forkStored = JSON.parse(await readFile(join(CHAT_HISTORY_DIR, 'fork/events/000000001.json'), 'utf8'));
  await rm(join(CHAT_HISTORY_DIR, 'fork/bodies', forkStored.bodyRef + '.txt'));
  assert.equal(await restarted.readEventBody('fork', 1), null, 'missing body is not silently served from an unbounded patch cache');
  console.log('file diff: native capture, repeated edits, durable lazy storage, compaction, reload, fork and missing body passed');
} finally {
  await rm(root, { recursive: true, force: true });
}

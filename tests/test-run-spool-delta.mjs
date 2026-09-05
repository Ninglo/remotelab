#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = mkdtempSync(join(tmpdir(), 'remotelab-spool-delta-'));
const previousHome = process.env.HOME;
setIsolatedTestHome(home);

try {
  const {
    appendRunSpoolRecord,
    createRun,
    materializeRunSpoolLine,
    readRunSpoolDelta,
    updateRun,
  } = await import('./chat/runs.mjs');

  const run = await createRun({
    status: {
      sessionId: 'session_spool_delta',
      requestId: 'req_spool_delta',
      state: 'accepted',
      tool: 'fake-codex',
    },
    manifest: {
      sessionId: 'session_spool_delta',
      requestId: 'req_spool_delta',
      folder: '~',
      tool: 'fake-codex',
      prompt: 'hi',
      options: {},
    },
  });

  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'x'.repeat(4 * 1024 * 1024) });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-1' });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-2' });

  const recovered = await readRunSpoolDelta(run.id, { skipLines: 2 });
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.records[0].line, 'small-2');
  assert.equal(recovered.skippedLineCount, 2);
  assert.equal(recovered.processedLineCount, 1);
  assert.equal(recovered.nextOffset > 0, true);

  await updateRun(run.id, {
    normalizedLineCount: recovered.skippedLineCount + recovered.processedLineCount,
    normalizedByteOffset: recovered.nextOffset,
  });

  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-3' });

  const delta = await readRunSpoolDelta(run.id, { startOffset: recovered.nextOffset });
  assert.equal(delta.records.length, 1);
  assert.equal(delta.records[0].line, 'small-3');
  assert.equal(delta.processedLineCount, 1);
  assert.equal(delta.nextOffset > recovered.nextOffset, true);

  const safeOffset = delta.nextOffset;
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'y'.repeat(3 * 1024 * 1024) });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'small-4' });

  const oversizedDelta = await readRunSpoolDelta(run.id, { startOffset: safeOffset });
  assert.equal(oversizedDelta.processedLineCount, 2);
  assert.equal(oversizedDelta.records.length, 2);
  assert.equal(typeof oversizedDelta.records[0].lineArtifact, 'string');
  assert.equal((await materializeRunSpoolLine(run.id, oversizedDelta.records[0])).startsWith('y'), true);
  assert.equal(oversizedDelta.records[1].line, 'small-4');

  console.log('test-run-spool-delta: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}

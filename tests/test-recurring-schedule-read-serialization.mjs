import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await fs.mkdtemp(join(tmpdir(), 'schedule-reader-race-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;
const { createRecurringSchedule, getRecurringSchedule, listRecurringSchedules, updateRecurringSchedule } =
  await import('../chat/recurring-schedules.mjs');
const file = join(configDir, 'chat-recurring-schedules.json');
const originalRead = fs.readFile, originalStat = fs.stat;
let releaseRead, readEntered, holdRead = false, readerBlocked = false, competingStat = false;
const entered = new Promise(resolve => { readEntered = resolve; });
const blocked = new Promise(resolve => { releaseRead = resolve; });
let reader, writer;
try {
  const schedule = await createRecurringSchedule({ sourceSessionId: 'fixture',
    sessionTemplate: { folder: tmpdir(), tool: 'codex' }, text: 'fixture', everySeconds: 3600,
    gate: { mode: 'script', runtime: 'bash', source: 'echo no' } });
  // Invalidate the cache as an external atomic state update would. Delaying the
  // next read models slow filesystem I/O, without sleeps or live instance state.
  const future = new Date(Date.now() + 1000); await fs.utimes(file, future, future);
  fs.readFile = async (path, ...args) => {
    const value = await originalRead(path, ...args);
    if (path === file && holdRead) { holdRead = false; readerBlocked = true; readEntered(); await blocked; readerBlocked = false; }
    return value;
  };
  fs.stat = async (path, ...args) => {
    if (path === file && readerBlocked) competingStat = true;
    return originalStat(path, ...args);
  };
  syncBuiltinESMExports(); holdRead = true;
  reader = listRecurringSchedules(); await entered;
  writer = updateRecurringSchedule(schedule.id, { wakeOn: ['foreground_idle'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(competingStat, false, 'a registry read must share the mutation queue; an older read cannot race a newer save');
  releaseRead(); await Promise.all([reader, writer]);
  assert.deepEqual((await getRecurringSchedule(schedule.id)).wakeOn, ['foreground_idle']);
  await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2
    ? listRecurringSchedules() : updateRecurringSchedule(schedule.id, { title: `fixture ${index}` })));
  assert.deepEqual((await getRecurringSchedule(schedule.id)).wakeOn, ['foreground_idle']);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8'))[0].wakeOn, ['foreground_idle']);
} finally {
  releaseRead(); await Promise.allSettled([reader, writer].filter(Boolean));
  fs.readFile = originalRead; fs.stat = originalStat; syncBuiltinESMExports();
  await fs.rm(configDir, { recursive: true, force: true });
}
console.log('schedule registry: slow reads, concurrent edits and event field persistence passed');

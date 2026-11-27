import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRecentErrorMonitor, describeRecentError } from '../lib/recent-errors.mjs';
import { startRecentErrorServiceSource } from '../chat/recent-error-service-source.mjs';

const root = await mkdtemp(join(tmpdir(),'recent-errors-test-'));
const file = join(root, 'monitor');
let now = 1_790_000_000_000;
const stats = createRecentErrorMonitor({ file, now: () => now });
const error = i => new Error(`ETIMEDOUT request run_${i.toString(16).padStart(16, '0')}`);
const record = (operation, attempt = 1, at = now) => stats.record('source-delivery', { operation, attempt, error: error(attempt), at, sessionId:'fixture_session' });
const worker = await Promise.all([record('a', 1), record('a', 1), record('a', 2), record('a', 3)]);
assert.equal(worker.filter(x => x.inserted).length,3);
const [row] = (await stats.list()).rows;
assert.equal(row.recentRecords,3);
assert.equal(row.recentOccurrences,1);
assert.equal(row.status,'observed');
assert.equal((await record('b')).opened,false);
assert.equal((await record('c')).opened,true);
assert.equal((await stats.list()).pending,1);
const pending = (await stats.detail(row.id)).cluster;
await record('d');
assert.equal((await stats.fix(row.id,{version:pending.version,commit:'a'.repeat(40),verification:'verified',personId:'p1'})).status,409);
now += 1000;
const valid = (await stats.detail(row.id)).cluster;
assert.equal((await stats.fix(row.id,{version:valid.version,commit:'b'.repeat(40),verification:'local replay confirmed',personId:'p1'})).status,200);
assert.equal((await stats.detail(row.id)).cluster.status,'fixed');
assert.equal((await stats.detail(row.id)).repair.verification,'local replay confirmed');
now += 1000;
assert.equal((await record('after-1')).opened,false);
assert.equal((await record('after-2')).opened,false);
assert.equal((await record('after-3')).opened,true);
assert.equal((await stats.detail(row.id)).cluster.occurrences24h,3);
now += 8*86400_000;
assert.equal((await stats.list()).pending,1,'quiet never closes repair');
assert.equal((await stats.list()).rows[0].recentRecords,0);
await record('old-delivery',1,now-2*86400_000);
assert.equal((await stats.detail(row.id)).cluster.occurrences24h,0);
const secret = 'NeverStoreThisSecret';
for (const _ of [1,2,3]) await stats.record('feishu-inbox',{operation:`unsupported-${_}`,error:'Unknown error'});
assert.equal((await stats.list()).pending,1,'no evidence cannot trigger repair');
await stats.record('feishu-inbox',{operation:'secret',error:new Error(`unstructured: ${secret}`)});
await stats.record('feishu-inbox',{operation:'secret-2',error:new Error(`unstructured: ${secret}`)});
assert.equal((await stats.list()).rows.find(r=>r.recentOccurrences===2).label,'未分类报错');
assert(!JSON.stringify(await stats.list()).includes(secret));
const diagnosis = describeRecentError('source-delivery', error(1), 'a');
assert.equal(diagnosis.cluster, describeRecentError('source-delivery', error(2), 'b').cluster);
assert.notEqual(diagnosis.cluster, describeRecentError('run-result', error(1), 'a').cluster);
// A separate process reads and writes the same durable store.
const child = spawn(process.execPath, ['--input-type=module','-e',`import {createRecentErrorMonitor} from './lib/recent-errors.mjs'; const m=createRecentErrorMonitor({file:${JSON.stringify(file)},now:()=>${now}}); const a=await m.list(); if(a.pending!==1)process.exit(2); const r=await m.record('run-result',{operation:'cross-process',error:'ENOSPC'}); if(!r.inserted)process.exit(3);`], {stdio:'inherit'});
assert.equal((await once(child,'exit'))[0],0);
assert((await stats.list()).rows.some(r=>r.source==='run-result'));
for (let i=0;i<35;i++) await record('fresh', i+1);
const page = await stats.detail(row.id);
assert.equal(page.events.length,25);
const later = await stats.detail(row.id,{before:page.next});
assert(later.events.length && later.events.every(e=>e.seq < page.next));
const crashFile = join(root, 'crash.json');
await writeFile(crashFile,JSON.stringify({events:[
  {id:'1'.repeat(64),unit:'approved.service',reason:'os_oom',at:new Date(now).toISOString()},
  {id:'2'.repeat(64),unit:'out-of-scope.service',reason:'fatal_error',at:new Date(now).toISOString()},
]}));
const bridgeOptions={file:crashFile,intervalMs:15,config:async()=>({enabled:true,serviceUnits:['approved.service']}),monitor:stats};
for (let run=0;run<2;run++) {
  const stop = startRecentErrorServiceSource(bridgeOptions);
  try { for(let i=0;i<40 && !(await stats.list()).rows.some(r=>r.source==='service-exit');i++) await sleep(15); }
  finally { stop(); }
}
const exits=(await stats.list()).rows.filter(r=>r.source==='service-exit');
assert.equal(exits.length,1); assert.equal(exits[0].recentRecords,1);
for (const suffix of ['.sqlite','.sqlite-wal']) {
  const bytes=await readFile(file+suffix).catch(error=>error.code==='ENOENT'?Buffer.alloc(0):Promise.reject(error));
  assert(!bytes.includes(secret));
}
await rm(root,{force:true,recursive:true});
console.log('recent errors: threshold, dedup, reopened repairs, separate processes, privacy, pagination and allowlisted service incidents passed');

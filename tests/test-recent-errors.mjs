import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRecentErrorMonitor, describeRecentError, recentErrorExcerpt } from '../lib/recent-errors.mjs';
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
assert.equal((await record('b')).inserted,true);
assert.equal((await record('c')).inserted,true);
assert.equal((await stats.detail(row.id)).cluster.occurrences24h,3);
assert.equal((await stats.detail(row.id)).cluster.status,'observed','three observations no longer create a repair work item');
assert.equal((await stats.list({samples:true})).rows[0].events.length,5);
now += 8*86400_000;
assert.equal((await stats.list()).rows.length,0);
await record('old-delivery',1,now-2*86400_000);
assert.equal((await stats.detail(row.id)).cluster.occurrences24h,0);
const secret = 'NeverStoreThisSecret';
for (const _ of [1,2,3]) await stats.record('feishu-inbox',{operation:`unsupported-${_}`,error:'Unknown error'});
assert.equal((await stats.list()).rows.filter(r=>r.source==='feishu-inbox' && !r.identifiable).length,3);
await stats.record('feishu-inbox',{operation:'secret',error:new Error(`unstructured password: ${secret}`)});
await stats.record('feishu-inbox',{operation:'secret-2',error:new Error(`unstructured password: ${secret}`)});
const redacted=(await stats.list()).rows.find(r=>r.recentOccurrences===2);
assert.equal(redacted.label,'未分类报错');
assert(!(JSON.stringify(await stats.list()).includes(secret)));
assert.equal((await stats.detail(redacted.id)).events[0].excerpt,'unstructured password: [已脱敏]');
assert.equal(recentErrorExcerpt(`Detached runner disappeared before writing a result\nstack ${secret}`),'Detached runner disappeared before writing a result');
for (const sample of [`Authorization: Bearer ${secret}`,`fetch https://name:${secret}@example.test/path?foo=${secret}`,`Command failed: curl -H '${secret}'`,`{\"password\":\"before ${secret}\"}`,`初始密码：${secret}`]) {
  assert(!recentErrorExcerpt(sample).includes(secret), sample);
}
const diagnosis = describeRecentError('source-delivery', error(1), 'a');
assert.equal(diagnosis.cluster, describeRecentError('source-delivery', error(2), 'b').cluster);
assert.notEqual(diagnosis.cluster, describeRecentError('run-result', error(1), 'a').cluster);
// A separate process reads and writes the same durable store.
const child = spawn(process.execPath, ['--input-type=module','-e',`import {createRecentErrorMonitor} from './lib/recent-errors.mjs'; const m=createRecentErrorMonitor({file:${JSON.stringify(file)},now:()=>${now}}); const a=await m.list(); if(!a.rows.length)process.exit(2); const r=await m.record('run-result',{operation:'cross-process',error:'ENOSPC'}); if(!r.inserted)process.exit(3);`], {stdio:'inherit'});
assert.equal((await once(child,'exit'))[0],0);
assert((await stats.list()).rows.some(r=>r.source==='run-result'));
for (let i=0;i<35;i++) await record('fresh', i+1);
const page = await stats.detail(row.id);
assert.equal(page.events.length,25);
const later = await stats.detail(row.id,{before:page.next});
assert(later.events.length && later.events.every(e=>e.seq < page.next));
const crashFile = join(root, 'crash.json');
const oldIncident = { operation:'1'.repeat(64), component:'approved.service', error:'os_oom', diagnostic:null, at:now };
await stats.record('service-exit', oldIncident);
const crashBefore = (await stats.list()).rows.find(r=>r.source==='service-exit');
assert.equal((await stats.detail(crashBefore.id)).events[0].excerpt,null);
const diagnostic = "approved.service: Failed with result 'oom-kill'.";
await writeFile(crashFile,JSON.stringify({events:[
  {id:'1'.repeat(64),unit:'approved.service',reason:'os_oom',at:new Date(now).toISOString(),evidence:[{message:diagnostic}]},
  {id:'2'.repeat(64),unit:'out-of-scope.service',reason:'fatal_error',at:new Date(now).toISOString()},
]}));
const bridgeOptions={file:crashFile,intervalMs:15,config:async()=>({enabled:true,serviceUnits:['approved.service']}),monitor:stats};
for (let run=0;run<2;run++) {
  const stop = startRecentErrorServiceSource(bridgeOptions);
  try { for(let i=0;i<40 && !(await stats.detail(crashBefore.id)).events[0].excerpt;i++) await sleep(15); }
  finally { stop(); }
}
const exits=(await stats.list()).rows.filter(r=>r.source==='service-exit');
assert.equal(exits.length,1); assert.equal(exits[0].recentRecords,1);
assert.equal(exits[0].version,crashBefore.version);
assert.equal((await stats.detail(crashBefore.id)).events[0].excerpt,diagnostic);
for (const suffix of ['.sqlite','.sqlite-wal']) {
  const bytes=await readFile(file+suffix).catch(error=>error.code==='ENOENT'?Buffer.alloc(0):Promise.reject(error));
  assert(!bytes.includes(secret));
}
await rm(root,{force:true,recursive:true});
console.log('recent errors: direct samples, dedup, separate processes, redaction, pagination and allowlisted service incidents passed');

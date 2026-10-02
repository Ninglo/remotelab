import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'codex-background-usage-'));
setIsolatedTestHome(root);
const home = join(root, 'codex'), config = join(root, 'config');
await mkdir(home); await mkdir(config);
process.env.REMOTELAB_CONFIG_DIR = config;
process.env.REMOTELAB_MACHINE_CODEX_HOME = home;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const command = join(root, 'codex-quota-fixture');
await copyFile(join(repo, 'tests/fixtures/native-codex-quota.cjs'), command);
await chmod(command, 0o700);
await writeFile(join(config, 'tools.json'), JSON.stringify([
  {id:'quota-observer-fixture',name:'Quota observer fixture',command,runtimeFamily:'codex-json'},
]));
await writeFile(join(home, 'auth.json'), '{"tokens":{}}');
const { codexAccounts: pool, CodexAccounts } = await import('../lib/codex-accounts.mjs');
const { createCodexUsageUpdates } = await import('../lib/codex-usage-updates.mjs');
const { createRunProjectionService } = await import('../chat/run-projection.mjs');
const { createToolInvocation } = await import('../chat/process-runner.mjs');
const { acquireProviderRuntimeLease } = await import('../chat/provider-runtime-queue.mjs');
const { runNativeHost } = await import('../chat/native-host.mjs');
const { submitNativeInput } = await import('../chat/native-input-transport.mjs');
const runs = await import('../chat/runs.mjs');
const quota = (remaining, checkedAt = new Date().toISOString()) => ({status:'ready',checkedAt,
  buckets:[{id:'codex',primary:{remainingPercent:remaining,resetsAt:new Date(Date.now()+86400000).toISOString()}}]});
const query = async () => ({account:{type:'chatgpt',planType:'pro'},usage:quota(100),
  checkedAt:new Date().toISOString(),accountRevision:'synthetic'});
pool.query = query;
const deferred = () => {
  let resolve;
  return {promise:new Promise(done => {resolve=done;}), resolve:value => resolve(value)};
};
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject) => {
    timer=setTimeout(() => reject(new Error('Background usage test exceeded 5 seconds')),5000);
  })]); } finally {clearTimeout(timer);}
};
const makeProjection = usageUpdates => createRunProjectionService({
  createToolInvocation,usageUpdates,readRunSpoolRecords:runs.readRunSpoolRecords,
  materializeRunSpoolLine:async (_,record) => record.line,normalizeRunEvents:(_,events) => events,
  clipPreview:text => text,readLatestCodexSessionMetrics:async () => null,buildCodexContextMetricsPayload:() => null,
});
async function runNative() {
  const record = await runs.createRun({status:{sessionId:'quota-audit',requestId:'quota-audit',tool:'quota-observer-fixture'},
    manifest:{sessionId:'quota-audit',tool:'quota-observer-fixture',folder:root,inputMode:'native',prompt:'synthetic',
      options:{model:'fixture',skipSessionStartPreflight:true}}});
  const child = spawn(process.execPath,['chat/runner-sidecar.mjs',record.id],{cwd:repo,env:process.env,
    stdio:['ignore','ignore','pipe']});
  let stderr='';
  child.stderr.on('data',chunk => {stderr+=chunk;});
  try {
    const code = await bounded(new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);}));
    assert.equal(code,0,stderr);
    const finished = await runs.getRun(record.id);
    assert.equal(finished.state,'completed',stderr);
    return finished;
  } finally {if(child.exitCode===null) child.kill('SIGKILL');}
}
try {
  await pool.refresh('default','synthetic');
  const backup = await pool.add('backup');
  await writeFile(join(backup.home,'auth.json'),'{"tokens":{}}');
  await pool.refresh(backup.id,'synthetic'); await pool.policy(true);

  // Real detached execution completes while the account metadata lock is held.
  const lock = await acquireProviderRuntimeLease({queueKey:'metadata',rootDir:join(pool.root,'locks')});
  const updates = createCodexUsageUpdates({pool,onError:() => assert.fail('Unexpected cache failure')});
  const projection = makeProjection(updates);
  let flush;
  try {
    const finished = await runNative();
    const observed = await projection.collectNormalizedRunEvents(finished,await runs.getRunManifest(finished.id));
    assert.ok(observed.normalizedEvents.some(event => event.content==='QUOTA_INDEPENDENT'));
    assert.ok((await runs.readRunSpoolRecords(finished.id)).some(record => record.json?.type==='remotelab.codex_usage'),
      'quota notification remains durable after the runner exits');
    flush = updates.flush();
    assert.equal((await pool.read()).activeId,'default','quota persistence is still waiting');
  } finally {await lock.release();}
  await bounded(flush);
  assert.equal((await pool.read()).activeId,backup.id,'controller applies the reserve crossing after the runner exits');

  // Cache failure cannot change the already completed conversation or projection.
  let errors=0;
  const broken = createCodexUsageUpdates({pool,onError:() => {errors++;}});
  const mutate = pool.mutate;
  pool.mutate = async () => {throw new Error('Synthetic cache write failure');};
  try {
    const finished = await runNative();
    const observed = await makeProjection(broken).collectNormalizedRunEvents(finished,await runs.getRunManifest(finished.id));
    await broken.flush();
    assert.ok(observed.normalizedEvents.some(event => event.content==='QUOTA_INDEPENDENT'));
    assert.equal((await runs.getRun(finished.id)).state,'completed');
    assert.equal(errors,1);
    // Even an enqueue/decoding failure is outside the conversation result.
    const failedSink = makeProjection({enqueue:() => {throw new Error('Synthetic decoder failure');}});
    assert.ok((await failedSink.collectNormalizedRunEvents(finished,await runs.getRunManifest(finished.id)))
      .normalizedEvents.some(event => event.content==='QUOTA_INDEPENDENT'));
  } finally {pool.mutate=mutate;}

  // Twelve notifications commit once, retaining a low sample followed by a
  // higher response in the same batch.
  await pool.select('default'); await pool.observeUsage('default',quota(100));
  let writes=0;
  pool.mutate = update => {writes++;return mutate.call(pool,update);};
  const batched = createCodexUsageUpdates({pool});
  try {
    const stamp=Date.now();
    for(let i=0;i<12;i++) batched.enqueue('default',{type:'remotelab.codex_usage',usage:quota(i===0?5:80)},
      new Date(stamp+i).toISOString());
    await batched.flush();
    assert.equal(writes,1,'one durable cache commit for twelve notifications');
    assert.equal((await pool.read()).activeId,backup.id,'batching cannot hide a reserve crossing');
    assert.equal((await pool.account('default')).usage.buckets[0].primary.remainingPercent,80);
  } finally {pool.mutate=mutate;}
  const newer=(await pool.account('default')).usage.checkedAt;
  await pool.observeUsage('default',quota(0),{checkedAt:new Date(Date.now()-120000).toISOString()});
  assert.equal((await pool.account('default')).usage.checkedAt,newer,'replayed spool never makes old quota look fresh');
  const chosen=(await pool.read()).activeId;
  batched.enqueue(backup.id,{type:'remotelab.codex_quota_exhausted'},new Date(Date.now()-120000).toISOString());
  await batched.flush();
  assert.equal((await pool.read()).activeId,chosen,'old exhaustion records cannot rotate accounts');

  // Two independent collectors and multiple model jobs share one active native
  // observer. A pending read does not gate foreground registrations.
  await pool.select('default');
  await pool.mutate(data => {data.accounts.find(a => a.id==='default').usage=quota(80,new Date(Date.now()-31000).toISOString());});
  const jobs=await Promise.all(Array.from({length:3},() => pool.acquireForRun({runId:'run_'+randomBytes(12).toString('hex')})));
  const started=deferred(),finish=deferred();
  let nativeReads=0;
  const liveQuery=async () => {nativeReads++;started.resolve();return finish.promise;};
  pool.queryLiveUsage=liveQuery;
  pool.query=async () => {throw new Error('Active account must reuse its App Server');};
  const observer = new CodexAccounts({root:pool.root,defaultHome:home,query:pool.query,queryLiveUsage:liveQuery});
  const refreshes=Promise.all([pool.refresh('default','synthetic',{maxAgeMs:30000}),
    observer.refresh('default','synthetic',{maxAgeMs:30000})]);
  await bounded(started.promise);
  let foreground;
  try {
    foreground=await bounded(pool.acquireForRun());
    assert.equal(foreground.id,'default');
    assert.equal(nativeReads,1,'one quota RPC per account despite multiple collectors and parallel jobs');
  } finally {
    finish.resolve(quota(9));await bounded(refreshes);
    await foreground?.lease.release();await Promise.all(jobs.map(job => job.lease.release()));
  }
  assert.equal((await pool.read()).activeId,backup.id);
  await pool.refresh('default','synthetic',{maxAgeMs:30000});
  assert.equal(nativeReads,1,'recent observations suppress another background query');

  // Exercise the actual native host/socket/driver path used by the sampler.
  await pool.select('default');
  await pool.mutate(data => {data.accounts.find(a => a.id==='default').usage=quota(80,new Date(Date.now()-31000).toISOString());});
  const activePool = new CodexAccounts({root:pool.root,defaultHome:home,query:pool.query});
  const runId='run_'+randomBytes(12).toString('hex');
  const slot=await activePool.acquireForRun({runId});
  const ready=deferred();
  let child,settled=false;
  const host=runNativeHost({directory:join(config,'chat-runs',runId),command,runtimeFamily:'codex-json',
    options:{observeCodexUsage:true},prompt:'synthetic',cwd:root,
    env:{...process.env,CODEX_HOME:slot.home,QUOTA_FIXTURE_HOLD:'1'},
    onProcess:async proc => {child=proc;},
    onStdout:async line => {if(JSON.parse(line).type==='remotelab.codex_usage') ready.resolve();},
    onStderr:async () => {},
  }).finally(() => {settled=true;});
  try {
    await bounded(ready.promise);
    const sampled=await bounded(activePool.refresh('default','synthetic',{maxAgeMs:30000}));
    assert.equal(sampled.usage.buckets[0].primary.remainingPercent,5);
    assert.equal(settled,false,'background sampling leaves the ongoing model turn active');
    assert.equal((await activePool.read()).activeId,backup.id);
    const next=await activePool.acquireForRun();
    assert.equal(next.id,backup.id);
    assert.equal(slot.home,home,'current native job retains its original authorization');
    await next.lease.release();
    const receipt=await submitNativeInput(join(config,'chat-runs',runId),{id:'finish',text:'finish'});
    assert.equal(receipt.mode,'steer');
    assert.equal((await bounded(host)).code,0);
  } finally {child?.kill('SIGKILL');await slot.lease.release();await host.catch(() => {});}
  console.log('Background quota: detached reply/completion independence, cache-failure isolation, batched persistence, source timestamps, and per-account live sampling passed');
} finally {await rm(root,{recursive:true,force:true});}

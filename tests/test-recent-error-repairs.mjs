import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecentErrorMonitor, describeRecentError } from '../lib/recent-errors.mjs';
import { validateRepairReceipts, observationMs } from '../lib/recent-error-repairs.mjs';
import { renderRecentErrorDigest } from '../lib/recent-error-digest.mjs';
const H=3600_000, D=24*H;
const dir=await mkdtemp(join(tmpdir(),'recent-error-repairs-'));
try {
  let now=Date.parse('2026-11-28T01:00:00Z');
  const start=now, startedAt=new Date(now).toISOString();
  const monitor=createRecentErrorMonitor({file:join(dir,'fixture'),now:()=>now});
  const error='Gate timed out after 5s';
  const signature=describeRecentError('schedule-gate',error).cluster;
  const commit='a'.repeat(40), deployment={commit:'b'.repeat(40),startedAt,verifiedAt:startedAt,evidence:'build receipt'};
  const r={signature,commit,deployment,verification:'bounded fixture passes',recordedBy:'observer'};
  const git=async (cmd,...args)=>{
    if(cmd==='show') return String((start-H)/1000);
    if(args.at(-1)===deployment.commit) return '';
    throw Error('unrelated deployment');
  };
  const checked=entries=>validateRepairReceipts(entries,{now,checkGit:git});
  const {valid}=await checked([r]); assert.equal(valid.length,1);
  for(const receipt of [{...r,commit:'abc'}, {...r,deployment:{...deployment,commit:'c'.repeat(40)}},
    {...r,deployment:{...deployment,startedAt:new Date(start-H*2).toISOString()}},
    {...r,deployment:{...deployment,verifiedAt:new Date(start+H).toISOString()}}]) {
    assert.equal((await checked([receipt])).invalid.length,1);
    assert.equal((await checked([receipt])).valid.length,0);
  }
  assert.equal((await checked([r,r])).invalid.length,2);
  assert.equal(observationMs([0,H,2*H,3*H,4*H]),D);
  assert.equal(observationMs([0,3*D,6*D,9*D,12*D]),7*D);
  for(const i of [1,2,3,4,5]) await monitor.record('schedule-gate',{operation:`op${i}`,error,at:now-i*H});
  await monitor.trackRepairs(valid);
  const state=async()=>(await monitor.repairReports(valid))[0].state;
  assert.equal(await state(),'observing');
  assert.match(await renderRecentErrorDigest({groups:[],since:now-1,until:now+1,repairs:await monitor.repairReports(valid)}),/修复观察中/);
  now+=D; assert.equal(await state(),'closed');
  assert.match(await renderRecentErrorDigest({groups:[],since:start,until:now,repairs:await monitor.repairReports(valid)}),/本期验证关闭/);
  await monitor.record('schedule-gate',{operation:'recur',error,at:start+H});
  assert.equal(await state(),'recurring');
  assert.equal((await monitor.repairReports(valid,start))[0].state,'observing');
  const report=await renderRecentErrorDigest({groups:await monitor.digestWindow({since:start,until:now}),since:start,until:now,repairs:await monitor.repairReports(valid)});
  assert.match(report.split('\n')[1],/1 次.*复发/);
  now+=40*D;
  await monitor.record('run-result',{operation:'prune',error:'unrelated'});
  assert.equal(await state(),'recurring','retention must not turn a recurrence into a closed repair');
  console.log('recent error repairs: invalid receipts, median window, observing, verified, recurrence priority and retention passed');
} finally { await rm(dir,{recursive:true,force:true}); }

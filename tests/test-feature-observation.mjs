import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feature-observation-'));
setIsolatedTestHome(home);
try {
  const { CONFIG_DIR } = await import('../lib/config.mjs');
  const root = join(CONFIG_DIR, 'feature-observations');
  const { captureFeatureObservation, observeFeatureAdmission, recordFeatureExecution, readFeatureObservations,
    featureUsageDelta, readFeatureMeter, validateFeatureTrials } = await import('../chat/feature-observation.mjs');
  const { appendEvent } = await import('../chat/history.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { appendRunSpoolRecord } = await import('../chat/runs.mjs');
  const { handleFeatureObservation } = await import('../chat/router-feature-observation.mjs');
  const { runFeatureObservationCommand } = await import('../lib/feature-observation-command.mjs');
  const policy = { scope:'person', personId:'person_a', selfReview:true, deliverySelfReview:{sha256:'rule'} };
  const options = {viewPersonId:'person_a',initiatedByIdentityId:'identity_a',messageReplyPolicy:policy};
  assert.equal(await captureFeatureObservation(options), null);
  const config = {version:1,trials:[{id:'review-week',projectId:'claude-tag',featureId:'delivery-self-review',name:'交付自检一周观察',
    enabled:true,durationDays:7,personIds:['person_a'],metrics:[{id:'found',label:'发现问题'},{id:'fixed',label:'已修复问题'}]}]};
  await mkdir(root,{recursive:true}); await writeFile(join(root,'config.json'),JSON.stringify(config));
  assert.equal(await captureFeatureObservation({...options,messageReplyPolicy:{...policy,selfReview:false}}),null);
  assert.equal(await captureFeatureObservation({...options,viewPersonId:'person_b'}),null);
  assert.throws(()=>validateFeatureTrials({...config,trials:[{...config.trials[0],durationDays:0}]}));
  assert.throws(()=>validateFeatureTrials({...config,trials:[config.trials[0],config.trials[0]]}));
  const t = Date.parse('2026-10-22T03:00:00Z');
  const featureObservation = await captureFeatureObservation(options, root, t);
  const record = (await requests.accept({sessionId:'feature-test',requestId:'r1',text:'交付汇总',options:{...options,featureObservation}})).record;
  await observeFeatureAdmission(record, root, t); await observeFeatureAdmission(record,root,t+1);
  const window = JSON.parse(await readFile(join(root,'review-week/window.json')));
  assert.equal(window.startsAt,t); assert.equal(window.endsAt,t+7*86400000);
  const totals=(i,o,c=0)=>({threadId:'native-a',inputTokens:i,outputTokens:o,cachedInputTokens:c});
  await appendRunSpoolRecord(record.runId,{ts:'2026-10-22T03:00:01Z',stream:'stdout',json:{type:'remotelab.context_metrics',featureUsage:totals(1000,30,500)}});
  assert.equal((await readFeatureMeter(record.runId)).inputTokens,1000);
  assert.equal(featureUsageDelta({...totals(100,10),at:'a'},{...totals(10,5),at:'b'}),null,'counter reset is unknown');
  assert.equal(featureUsageDelta(null,totals(10,5)),null);
  const attachment = await appendEvent(record.sessionId,{type:'message',role:'assistant',content:'',attachments:[{assetId:'real-fixture'}]});
  const first = await recordFeatureExecution(record,{action:'begin'},{root,now:t+1000});
  assert.deepEqual(await recordFeatureExecution(record,{action:'begin'},{root,now:t+2000}),first,'begin replay does not shift cost baseline');
  await assert.rejects(recordFeatureExecution(record,{action:'finish',outcome:'passed',checks:[]},{root,now:t+3000}),/缺少/);
  const words = await appendEvent(record.sessionId,{type:'message',role:'assistant',content:'我完成了'});
  await assert.rejects(recordFeatureExecution(record,{action:'finish',outcome:'passed',checks:[{criterion:'交付',verdict:'pass',evidenceSeqs:[words.seq]}]},{root,now:t+3000}),/真实/);
  const tool = await appendEvent(record.sessionId,{type:'tool_result',runId:record.runId,toolName:'shell',output:'actual,30',exitCode:0});
  await appendRunSpoolRecord(record.runId,{ts:'2026-10-22T03:00:05Z',stream:'stdout',json:{type:'remotelab.context_metrics',featureUsage:totals(1500,55,700)}});
  const input={action:'finish',outcome:'repaired',metrics:{found:1,fixed:1},checks:[{criterion:'真实CSV内容',verdict:'pass',evidenceSeqs:[tool.seq]},
    {criterion:'已有附件交付',verdict:'pass',evidenceSeqs:[attachment.seq]}]};
  const ended=await recordFeatureExecution(record,input,{root,now:t+5000});
  assert.equal(ended.usage,null,'finish does not guess the provider sample before its tool return');
  assert.equal(ended.durationMs,4000);
  assert.deepEqual(await recordFeatureExecution(record,{...input,metrics:{found:9}},{root,now:t+6000}),ended,'finish replay cannot rewrite outcome');
  const lookup=async()=>({...record,nativeReceipt:{accepted:true}});
  const report=(await readFeatureObservations({root,now:t+6000,lookup})).trials[0];
  assert.equal(report.admittedInputs,1); assert.equal(report.deliveredInputs,1);
  assert.equal(report.finished,1); assert.equal(report.usage.totalTokens,525); assert.equal(report.metrics[0].value,1);
  assert.equal(report.daily[0].totalTokens,525);
  assert.equal((await readFeatureObservations({root,now:window.endsAt,lookup})).trials[0].state,'completed');
  assert.equal(await captureFeatureObservation(options,root,window.endsAt),null,'expiry stops enrollment, not the feature itself');
  const missing=(await readFeatureObservations({root,now:t+6000,lookup:async()=>null})).trials[0];
  assert.equal(missing.missingRequests,1); assert.equal(missing.partial,true);
  const second=(await requests.accept({sessionId:'feature-test',requestId:'r2',text:'短问答',options:{...options,featureObservation}})).record;
  await observeFeatureAdmission(second,root,t+6000);
  await recordFeatureExecution(second,{action:'begin'},{root,now:t+6000,meter:async()=>null});
  await recordFeatureExecution(second,{action:'finish',outcome:'not_applicable',checks:[],metrics:{}},{root,now:t+7000,meter:async()=>null});
  const unknown=(await readFeatureObservations({root,now:t+8000,lookup})).trials[0];
  assert.equal(unknown.usage.unknown,1); assert.equal(unknown.usage.measured,1);
  assert.equal(unknown.usage.totalTokens,525,'missing usage cannot become zero or whole-run cost');
  const delayed=(await requests.accept({sessionId:'feature-test',requestId:'r3',text:'计数器在工具后到达',options:{...options,featureObservation}})).record;
  await observeFeatureAdmission(delayed,root,t+8000);
  await recordFeatureExecution(delayed,{action:'begin'},{root,now:t+8000});
  await appendRunSpoolRecord(delayed.runId,{ts:'2026-10-22T03:00:08.010Z',stream:'stdout',json:{type:'remotelab.context_metrics',featureUsage:totals(10000,100)}});
  await recordFeatureExecution(delayed,{action:'finish',outcome:'not_applicable',checks:[]},{root,now:t+9000});
  assert.equal((await readFeatureObservations({root,now:t+9000,lookup})).trials[0].usage.unknown,2);
  await appendRunSpoolRecord(delayed.runId,{ts:'2026-10-22T03:00:09.010Z',stream:'stdout',json:{type:'remotelab.context_metrics',featureUsage:totals(11000,120)}});
  const delayedReport=(await readFeatureObservations({root,now:t+10000,lookup})).trials[0];
  assert.equal(delayedReport.usage.totalTokens,1545,'later provider samples resolve to phase delta, excluding pre-begin 10100 tokens');
  assert.equal(delayedReport.usage.unknown,1);
  async function call(body,authSession={authKind:'service'}){
    const req=Readable.from([JSON.stringify(body)]);req.method='POST';let result;
    await handleFeatureObservation({req,res:{},pathname:'/api/monitoring/feature-observations',authSession,
      writeJson:(_,status,json)=>{result={status,json}}});return result;
  }
  assert.equal((await call({runId:record.runId,requestId:'r1',action:'begin'},{personId:'person_b'})).status,403);
  assert.equal((await call({runId:record.runId,requestId:'not-present',action:'begin'})).status,403);
  let output='';
  await runFeatureObservationCommand(['begin','--request-id','r1'],{runId:record.runId,stdout:{write:t=>{output+=t}},
    client:{request:async(_,opts)=>{const r=await call(opts.body);return {response:{ok:r.status===200},json:r.json}}}});
  assert.equal(JSON.parse(output).observation.id,ended.id);
  console.log('PASS feature observation: scoped opt-in, first-exposure week, expiry, immutable receipts, real event evidence, attachment-only acceptance, provider stage deltas, unknowns, API identity and CLI');
} finally {await rm(home,{recursive:true,force:true});}

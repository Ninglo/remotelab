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
    featureUsageDelta, readFeatureMeter, validateFeatureTrials, readFeatureReviewStatus, appendFeatureReviewStatus, featureObservationPrompt } = await import('../chat/feature-observation.mjs');
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
  const input={action:'finish',outcome:'repaired',metrics:{found:1,fixed:1},
    explanation:{note:'修正订单总数',reason:'本轮需要交付准确的订单统计',actions:['从原CSV复算总数并修正报告','确认已有附件'],nextStep:'修复已完成，没有后续待办',userAction:'无需操作'},
    checks:[{criterion:'真实CSV内容',verdict:'pass',evidenceSeqs:[tool.seq]},
    {criterion:'已有附件交付',verdict:'pass',evidenceSeqs:[attachment.seq]}]};
  const ended=await recordFeatureExecution(record,input,{root,now:t+5000});
  assert.equal(ended.usage,null,'finish does not guess the provider sample before its tool return');
  assert.equal(ended.durationMs,4000);
  const repairedText=(await appendFeatureReviewStatus({text:'统计结果'},record)).text;
  assert.equal(repairedText,'统计结果\n\n自检补做：修正订单总数');
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
  // The visible receipt remains usable when no observation was captured.
  const ordinary = (await requests.accept({sessionId:'feature-test',requestId:'no-cohort',text:'当前真实任务',options})).record;
  assert.match(featureObservationPrompt(null,ordinary.requestId,true),/执行回执/);
  assert.equal(featureObservationPrompt(null,ordinary.requestId,false),'');
  assert.equal((await readFeatureReviewStatus(ordinary)).state,'no_record');
  const absent=await appendFeatureReviewStatus({text:'结果',attachments:[]},ordinary);
  assert.equal(absent.text,'结果');assert.equal(absent.featureReview.state,'no_record');assert.equal(absent.featureReview.footer,'');
  assert.equal((await appendFeatureReviewStatus({text:'',attachments:[]},ordinary)).text,'','silent decisions stay silent');
  assert.equal((await appendFeatureReviewStatus({text:'普通答复'}, {...ordinary,options:{}})).text,'普通答复');
  await recordFeatureExecution(ordinary,{action:'begin'});
  assert.equal((await readFeatureReviewStatus(ordinary)).state,'started');
  await recordFeatureExecution(ordinary,{action:'finish',outcome:'passed',checks:[{criterion:'实际文件',verdict:'pass',evidenceSeqs:[tool.seq]}]});
  const shown=await appendFeatureReviewStatus({text:'结果',attachments:[]},ordinary);
  assert.equal(shown.text,'结果');assert.equal(shown.featureReview.outcome,'passed');assert.equal(shown.featureReview.footer,'');
  assert.deepEqual(await appendFeatureReviewStatus(shown,ordinary),shown,'no duplicate footer');
  assert.equal((await appendFeatureReviewStatus({text:'结果'},ordinary,{frozenStatus:absent.featureReview})).text,'结果','an initially hidden receipt stays hidden even after the review finishes');
  assert.equal((await appendFeatureReviewStatus({text:'结果'},ordinary,{frozenStatus:{state:'finished',outcome:'passed',footer:''}})).text,'结果','a frozen empty footer is not regenerated');
  const oldFooter='自检：仍有未解决项 · 4 项。';
  assert.equal((await appendFeatureReviewStatus({text:'旧结果'},ordinary,{frozenStatus:{state:'finished',outcome:'blocked',checks:4,metrics:{},footer:oldFooter}})).text,
    '旧结果\n\n'+oldFooter,'an already frozen delivery retains its old formatter on retry');
  // A count beside "unresolved" used to mean ALL checks. Exercise a mixed real
  // receipt through the CLI/API, with distinct next actions for agent and user.
  const detailed=(await requests.accept({sessionId:'feature-test',requestId:'detailed',text:'交付报告',options})).record;
  await recordFeatureExecution(detailed,{action:'begin'});
  const explanation={note:'待提供目录权限',reason:'本轮交付报告与可访问的下载入口',actions:['读取报告并复算总数','检查下载入口，发现权限缺失'],
    nextStep:'我需要在获得访问权限后重验下载入口；尚未安排自动重试',userAction:'请提供可访问的目标目录'};
  const detailInput={outcome:'blocked',metrics:{found:2,fixed:0,unresolved:2},explanation,
    checks:[{criterion:'报告非空',verdict:'pass',evidenceSeqs:[tool.seq]},
      {criterion:'总数正确',verdict:'pass',evidenceSeqs:[tool.seq]},
      {criterion:'入口可访问',verdict:'fail',evidenceSeqs:[tool.seq]},
      {criterion:'下载权限确认',verdict:'unknown',evidenceSeqs:[]}]};
  await assert.rejects(recordFeatureExecution(detailed,{action:'finish',...detailInput,explanation:{...explanation,userAction:''}}),/用户所需动作/);
  await assert.rejects(recordFeatureExecution(detailed,{action:'finish',...detailInput,explanation:{...explanation,actions:[]}}),/实际操作/);
  await assert.rejects(recordFeatureExecution(detailed,{action:'finish',...detailInput,explanation:{...explanation,note:'一二三四五六七八九'}}),/限8字/);
  await assert.rejects(recordFeatureExecution(detailed,{action:'finish',...detailInput,explanation:{...explanation,note:'暂停\n'}}),/不能换行/);
  await assert.rejects(recordFeatureExecution(detailed,{action:'finish',...detailInput,outcome:'passed'}),/不能报告全部通过/);
  const resultFile=join(home,'review-result.json');
  await writeFile(resultFile,JSON.stringify(detailInput));
  await runFeatureObservationCommand(['finish','--request-id','detailed','--file',resultFile],{
    runId:detailed.runId,stdout:{write(){}},client:{request:async(_,opts)=>{
      const r=await call(opts.body);return {response:{ok:r.status===200},json:r.json};}}});
  const detailStatus=await readFeatureReviewStatus(detailed);
  assert.deepEqual(detailStatus.explanation,explanation);
  assert.equal(detailStatus.checkDetails.length,4);
  const detailText=(await appendFeatureReviewStatus({text:'报告'},detailed)).text;
  assert.equal(detailText,'报告\n\n推进受阻：待提供目录权限');
  assert.doesNotMatch(detailText,/原因：|已做：|后续：|你需要：/);
  // Inapplicable stays in the record, including its reason, without a visible badge.
  const short=(await requests.accept({sessionId:'feature-test',requestId:'explained-short',text:'解释设置',options})).record;
  await recordFeatureExecution(short,{action:'begin'});
  await assert.rejects(recordFeatureExecution(short,{action:'finish',outcome:'not_applicable',checks:detailInput.checks}),/不适用不能/);
  await recordFeatureExecution(short,{action:'finish',outcome:'not_applicable',checks:[],
    explanation:{note:'仅问答',reason:'本轮仅解释设置，没有文件或系统变更需要验收',actions:[],nextStep:'本轮问答已结束，没有后续验收',userAction:'无需操作'}});
  const skipped=await appendFeatureReviewStatus({text:'解释'},short);
  assert.equal(skipped.text,'解释');assert.equal(skipped.featureReview.outcome,'not_applicable');
  assert.equal(skipped.featureReview.explanation.note,'仅问答');assert.equal(skipped.featureReview.footer,'');
  // Missing receipts never become "not triggered" or a promise to auto-run.
  for(const state of ['started','no_record','unavailable']) {
    const text=(await appendFeatureReviewStatus({text:'结果'},short,{frozenStatus:{state,enabledBy:'group'}})).text;
    assert.equal(text,'结果','receipt bookkeeping alone does not announce progress or failure');
    assert.doesNotMatch(text,/不适用|自动启动|本群已开启/);
  }
  for(const outcome of ['passed','repaired','blocked','not_applicable']) {
    for(const note of [undefined,'一二三四五六七八','按要求暂停']) {
      const text=(await appendFeatureReviewStatus({text:'正文'},short,{frozenStatus:{state:'finished',outcome,explanation:{note}}})).featureReview.footer;
      assert.ok([...text].length<=15, text);assert.ok(!text.includes('\n'));
      if(['not_applicable','passed'].includes(outcome)) assert.equal(text,'');
      else assert.ok(text.length>0,'extra work and blocked progress remain visible');
    }
  }
  const prompt=featureObservationPrompt(null,'test',true);
  assert.match(prompt,/explanation/);assert.match(prompt,/不能只写“不适用”/);assert.match(prompt,/不把我能完成的工作推给用户/);
  assert.match(prompt,/15字以内/);assert.match(prompt,/正文讲清一次/);
  assert.match(prompt,/正常检查通过、不适用、无记录及回执状态异常均不显示尾注/);assert.match(prompt,/不要把任务成果或回执格式调整写成自检发现/);
  // Receiving a root turn is real provider evidence, independent of a steer receipt.
  const unreviewed=(await requests.accept({sessionId:'feature-test',requestId:'no-review',text:'未自检',options:{...options,featureObservation}})).record;
  await observeFeatureAdmission(unreviewed,root,t+11000);
  await appendRunSpoolRecord(unreviewed.runId,{ts:new Date().toISOString(),json:{type:'turn.started'}});
  await requests.mutate(unreviewed.key,r=>({...r,result:{state:'completed'}}));
  const gaps=(await readFeatureObservations({root,now:t+12000})).trials[0];
  assert.equal(gaps.noExecutionReceipt,1);
  assert.equal(gaps.deliveredInputs,1);
  assert.equal(gaps.inputRecords.find(r=>r.requestId==='no-review').state,'no_record');
  assert.equal(gaps.finished,3,'non-cohort review does not pollute observation counts');
  console.log('PASS feature observation: scoped opt-in, first-exposure week, expiry, immutable receipts, real event evidence, attachment-only acceptance, provider stage deltas, unknowns, API identity and CLI');
} finally {await rm(home,{recursive:true,force:true});}

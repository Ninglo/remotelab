import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {processSessionDiagnostics,sessionDiagnosisCard} from '../chat/session-diagnostics.mjs';
import {trustCandidates} from '../chat/monitoring-trust.mjs';
import {privateDiagnosisDecision} from '../lib/session-diagnosis.mjs';
import {readRecord,writeDurableJson} from '../lib/durable-records.mjs';

const start=Date.parse('2026-10-14T16:00:00Z'),minute=60000;
const usage=(left,now)=>({status:'ready',checkedAt:new Date(now).toISOString(),buckets:[{id:'codex',primary:{remainingPercent:left}}]});
const account=(id,left,now)=>({id,account:{type:'chatgpt'},usage:usage(left,now)});
const row=(sessionId,now)=>({sessionId,runId:sessionId,accountId:'a',state:'failed',responseAt:now,metrics:{}});
const runtime=now=>({autoSwitch:true,activeId:'a',accounts:[account('a',0,now)]});
const root=await mkdtemp(join(tmpdir(),'diagnosis-noise-'));
const config={enabled:true,reportActions:true,metricPolicy:{enabled:true},notification:{enabled:true,profile:'bot',openId:'ou_person',feishuAppId:'cli_app',noisePolicy:{mode:'risk_only'}}};
try {
 let sent=[],rows=[row('one',start)],rt=runtime(start);
 const args={config,stateFile:join(root,'state.json'),readSessions:async()=>({sessions:[],coverage:{}}),
  readMetrics:async()=>({samples:rows,coverage:{}}),readAccounts:async()=>({runtime:rt,bindings:rows.map(r=>({sessionId:r.sessionId,accountId:'a'}))}),
  deliver:async item=>{sent.push(structuredClone(item));return {messageId:'om_original',chatId:'oc_private',recipientKey:item.delivery.recipientKey};}};
 const run=async(n,refresh=true)=>{const now=start+n*6*minute;if(refresh)rt.accounts.forEach(a=>a.usage=usage(a.id==='a'?0:90,now));return processSessionDiagnostics({...args,now});};
 await run(0);await run(1);assert.equal(sent.length,0,'two confirmations cannot notify');
 await run(2);assert.equal(sent.length,1,'three distinct fresh observations notify one current problem');
 const card=sessionDiagnosisCard(sent[0],config.notification);
 assert.match(card.elements[0].text.content,/上次预警/);
 assert(!card.elements[0].text.content.includes('个会话'),'compact cards avoid counts that do not trigger updates');
 rows.push(row('two',start+12*minute));await run(3);
 assert.equal(sent.length,1,'affected count changes do not edit the card');
 rt.accounts.push(account('b',90,start+24*minute));await run(4);
 assert.equal(sent.length,2,'verified available fallback updates original risk once');
 assert.equal(sent[1].delivery.messageId,'om_original');await run(5);assert.equal(sent.length,2);

 const pausedFile=join(root,'paused.json');
 rt=runtime(start);rows=[row('one',start)];
 await processSessionDiagnostics({...args,stateFile:pausedFile,now:start,config:{...config,notification:{...config.notification,enabled:false}}});
 for(let n=1;n<=3;n++){rt=runtime(start+n*6*minute);await processSessionDiagnostics({...args,stateFile:pausedFile,now:start+n*6*minute});}
 assert.equal(sent.length,2,'resuming does not replay known paused problems');

 const legacyFile=join(root,'legacy.json');
 const old=await readRecord(args.stateFile);
 for(const item of Object.values(old.incidents))delete item.notification;
 delete old.privateNotificationPolicy;delete old.checkedAt;
 const beforeReceipt=structuredClone(Object.values(old.incidents)[0].delivery);
 await writeDurableJson(legacyFile,old);
 rt=runtime(start);rows=[row('one',start)];
 for(let n=0;n<3;n++){rt=runtime(start+n*6*minute);await processSessionDiagnostics({...args,stateFile:legacyFile,now:start+n*6*minute});}
 assert.equal(sent.length,2,'policy migration does not replay old incidents');
 assert.deepEqual(Object.values((await readRecord(legacyFile)).incidents)[0].delivery,beforeReceipt);

 const repeatedFile=join(root,'repeated.json');rt=runtime(start);rows=[row('one',start)];
 rt.accounts[0].blockedUntil=start+60*minute;
 for(let n=0;n<3;n++)await processSessionDiagnostics({...args,stateFile:repeatedFile,now:start+n*6*minute});
 assert.equal(sent.length,2,'repeated or stale quota samples cannot confirm risk');
 const local=trustCandidates({runtime:runtime(start),bindings:[{sessionId:'idle',accountId:'a'}]}, {},[],start,{riskOnly:true});
 assert.equal(privateDiagnosisDecision(local[0]).eligible,false,'idle bindings are not human tasks');
 const retried=trustCandidates({runtime:runtime(start),bindings:[{sessionId:'one',accountId:'a'}]}, {},
  [{...row('one',start-1000),at:start-1000},{...row('one',start-1000),runId:'retry',at:start,state:'completed'}],start,{riskOnly:true});
 assert.equal(privateDiagnosisDecision(retried[0]).eligible,false,'a successful retry supersedes the failed run of the same request');
 const newerFailure=trustCandidates({runtime:runtime(start),bindings:[{sessionId:'one',accountId:'a'}]}, {},
  [{...row('one',start-2000),at:start,state:'completed'},row('one',start-1000)],start,{riskOnly:true});
 assert.equal(privateDiagnosisDecision(newerFailure[0]).eligible,true,'late completion of an older request does not hide a newer failure');
 const unknown=runtime(start);unknown.accounts.push({...account('b',90,start),usage:null});
 assert.equal(privateDiagnosisDecision(trustCandidates({runtime:unknown,bindings:[{sessionId:'one',accountId:'a'}]}, {},[row('one',start)],start,{riskOnly:true})[0]).reason,'backup_unknown');
 const switched={...runtime(start),activeId:'b',accounts:[account('a',0,start),account('b',90,start)],switchEvents:[0,1,2].map(i=>({from:'a',to:'b',at:new Date(start-i*1000).toISOString()}))};
 const actions=trustCandidates({runtime:switched,bindings:[]},{},[],start,{riskOnly:true});
 assert.equal(actions.length,1);assert.equal(actions[0].actionRefs.length,3);assert.equal(privateDiagnosisDecision(actions[0]).eligible,false);
 assert.equal(privateDiagnosisDecision({kind:'metric',status:'review_required'}).eligible,false);
 assert.equal(privateDiagnosisDecision({kind:'lifecycle',metric:'recovery',status:'review_required'}).reason,'resource_route');

 const incomplete=await processSessionDiagnostics({...args,now:start,dryRun:true,
  readMetrics:async()=>({samples:rows,coverage:{truncated:true}})});
 assert.equal(incomplete.extraCandidates.find(i=>i.riskType==='exhausted_bindings').notificationReason,'collection_incomplete');
 let attempts=0;rt=runtime(start);rows=[row('one',start)];
 const uncertain={...args,stateFile:join(root,'uncertain.json'),deliver:async()=>{attempts++;throw Error('lost receipt');}};
 for(let n=0;n<5;n++){rt=runtime(start+n*6*minute);await processSessionDiagnostics({...uncertain,now:start+n*6*minute});}
 assert.equal(attempts,1,'uncertain private sends never retry automatically');

 let recoveredSends=[];
 const recovery={...args,stateFile:join(root,'recovery.json'),deliver:async item=>{recoveredSends.push(structuredClone(item));return {messageId:'om_recovery',chatId:'oc_dm',recipientKey:item.delivery.recipientKey};}};
 rows=[row('one',start)];
 for(let n=0;n<3;n++){rt=runtime(start+n*6*minute);await processSessionDiagnostics({...recovery,now:start+n*6*minute});}
 rt={...runtime(start+18*minute),accounts:[account('a',90,start+18*minute)]};
 await processSessionDiagnostics({...recovery,now:start+18*minute});
 assert.equal(recoveredSends.length,2);assert.equal(recoveredSends[1].status,'resolved');
 assert.equal(recoveredSends[1].delivery.messageId,'om_recovery');
 rows=[row('one',start+24*minute)];
 for(let n=4;n<7;n++){rt=runtime(start+n*6*minute);await processSessionDiagnostics({...recovery,now:start+n*6*minute});}
 assert.equal(recoveredSends.length,3,'verified recovery rearms a later independent recurrence');
 assert.notEqual(recoveredSends[2].id,recoveredSends[0].id);

 // Explicit metric notifications coexist with risk-only account policy.
 const metricRows=Array.from({length:90},(_,i)=>({runId:'base'+i,sessionId:'m'+i%6,responseAt:start-(2+i%10)*86400000,state:'completed',model:'m',tool:'codex',metrics:{injectionChars:10000}}));
 metricRows.push(...Array.from({length:12},(_,i)=>({runId:'new'+i,sessionId:'m'+i%6,responseAt:start-i*1000,state:'completed',model:'m',tool:'codex',metrics:{injectionChars:16000}})));
 const metricSent=[];
 const metricArgs={...args,stateFile:join(root,'metric.json'),config:{...config,reportActions:false,metricPolicy:{enabled:true,notifyOnRegression:true}},
  readMetrics:async()=>({samples:metricRows,coverage:{}}),deliver:async item=>{metricSent.push(structuredClone(item));return {messageId:'om_metric',chatId:'oc_private',recipientKey:item.delivery.recipientKey};}};
 await processSessionDiagnostics({...metricArgs,now:start,dryRun:true});assert.equal(metricSent.length,0);
 await processSessionDiagnostics({...metricArgs,now:start});assert.equal(metricSent.length,1,'cross-session metric evidence not suppressed by risk_only');
 await processSessionDiagnostics({...metricArgs,now:start+6*minute});assert.equal(metricSent.length,1,'same samples do not repeat');
 for(const s of metricRows.slice(-12))s.metrics.injectionChars=17000;
 await processSessionDiagnostics({...metricArgs,now:start+31*minute});assert.equal(metricSent.length,1,'small drift does not edit notification');
 for(const s of metricRows.slice(-12))s.metrics.injectionChars=20000;
 await processSessionDiagnostics({...metricArgs,now:start+62*minute});assert.equal(metricSent.length,2,'another thirty percentage points updates original card');
 assert.equal(metricSent[1].delivery.messageId,'om_metric');
 const good=Array.from({length:12},(_,i)=>({...metricRows.at(-1),runId:'good'+i,sessionId:'m'+i%6,responseAt:start+63*minute+i,metrics:{injectionChars:10500}}));
 await processSessionDiagnostics({...metricArgs,now:start+68*minute,readMetrics:async()=>({samples:good,coverage:{}})});
 assert.equal(metricSent.length,3);assert.equal(metricSent[2].status,'resolved');
 await processSessionDiagnostics({...metricArgs,now:start+74*minute,readMetrics:async()=>({samples:good,coverage:{}})});assert.equal(metricSent.length,3);
 const before=metricSent.length;
 await processSessionDiagnostics({...metricArgs,stateFile:join(root,'metric-partial.json'),now:start,readMetrics:async()=>({samples:metricRows,coverage:{truncated:true}})});
 await processSessionDiagnostics({...metricArgs,stateFile:join(root,'metric-disabled.json'),now:start,config:{...metricArgs.config,notification:{...config.notification,enabled:false}}});
 await processSessionDiagnostics({...metricArgs,stateFile:join(root,'metric-optout.json'),now:start,config:{...metricArgs.config,metricPolicy:{enabled:true}}});
 assert.equal(metricSent.length,before,'coverage, pause and opt-out remain respected');
 const pausedMetric=join(root,'metric-disabled.json');
 await processSessionDiagnostics({...metricArgs,stateFile:pausedMetric,now:start+6*minute});assert.equal(metricSent.length,before,'paused metric is not replayed on resume');
 const migrationFile=join(root,'metric-migration.json');
 await processSessionDiagnostics({...metricArgs,stateFile:migrationFile,now:start,config:{...metricArgs.config,metricPolicy:{enabled:true}}});
 await processSessionDiagnostics({...metricArgs,stateFile:migrationFile,now:start+6*minute});assert.equal(metricSent.length,before+1,'explicit metric opt-in reports a currently qualifying formerly suppressed incident');

 // Several comparisons and metrics share one private card for three hours.
 const bundleSent=[];
 let extra=[];
 const bundleArgs={...metricArgs,stateFile:join(root,'bundles.json'),readMetrics:async()=>({samples:[...metricRows,...extra],coverage:{}}),
  deliver:async item=>{bundleSent.push(structuredClone(item));return {messageId:item.delivery.messageId || 'om_bundle'+bundleSent.length,chatId:'oc_private',recipientKey:item.delivery.recipientKey};}};
 const other=(model)=>metricRows.map(r=>({...r,metrics:{...r.metrics},model,runId:model+r.runId}));
 extra=other('second');
 await processSessionDiagnostics({...bundleArgs,now:start});
 assert.equal(bundleSent.length,1);assert.equal(bundleSent[0].items.length,2);
 extra.push(...other('third'));
 await processSessionDiagnostics({...bundleArgs,now:start+120*minute});
 assert.equal(bundleSent.length,2);assert.equal(bundleSent[1].delivery.messageId,'om_bundle1');assert.equal(bundleSent[1].items.length,3);
 extra.push(...other('fourth'));
 await processSessionDiagnostics({...bundleArgs,now:start+181*minute});
 assert.equal(bundleSent.length,3);assert(!bundleSent[2].delivery.messageId,'new incident after three hours opens a new card');
 await processSessionDiagnostics({...bundleArgs,now:start+187*minute});assert.equal(bundleSent.length,3,'elapsed time does not repeat existing incidents');
 for(const r of metricRows.slice(-12))r.metrics.injectionChars=26000;
 await processSessionDiagnostics({...bundleArgs,now:start+220*minute});
 assert.equal(bundleSent.at(-1).delivery.messageId,'om_bundle1','old incident still edits its own original card after the window');
 const migration=await readRecord(bundleArgs.stateFile);
 delete migration.metricNotifications;
 for(const i of Object.values(migration.incidents))i.delivery={status:'delivered',messageId:'om_legacy',chatId:'oc_private',recipientKey:bundleSent[0].delivery.recipientKey};
 await writeDurableJson(join(root,'legacy-bundle.json'),migration);
 await processSessionDiagnostics({...bundleArgs,stateFile:join(root,'legacy-bundle.json'),now:start+226*minute});
 assert.equal(bundleSent.at(-1).delivery.messageId,'om_legacy','adopt an existing receipt when upgrading');
 let bundleAttempts=0;
 const uncertainBundle={...bundleArgs,stateFile:join(root,'bundle-uncertain.json'),deliver:async()=>{bundleAttempts++;throw Error('lost receipt');}};
 await processSessionDiagnostics({...uncertainBundle,now:start});
 extra.push(...other('fifth'));
 await processSessionDiagnostics({...uncertainBundle,now:start+6*minute});
 assert.equal(bundleAttempts,1,'a new member cannot bypass an uncertain bundle receipt');

 let calls=0;
 const disabled=await processSessionDiagnostics({...args,config:{...config,enabled:false},readSessions:async()=>{calls++;}});
 assert.equal(disabled.skipped,'disabled');assert.equal(calls,0);
 console.log('Private diagnosis noise: sustained current risk, semantic updates, original card, paused/legacy baseline, stale samples, idle bindings, unknown backups, aggregated actions and disabled processing passed');
} finally {await rm(root,{recursive:true,force:true});}

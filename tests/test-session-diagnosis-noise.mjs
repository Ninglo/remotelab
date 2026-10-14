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
 assert.equal(card.elements[0].text.content.split('\n').length,3);
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

 let calls=0;
 const disabled=await processSessionDiagnostics({...args,config:{...config,enabled:false},readSessions:async()=>{calls++;}});
 assert.equal(disabled.skipped,'disabled');assert.equal(calls,0);
 console.log('Private diagnosis noise: sustained current risk, semantic updates, original card, paused/legacy baseline, stale samples, idle bindings, unknown backups, aggregated actions and disabled processing passed');
} finally {await rm(root,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setIsolatedTestHome} from './isolate-test-environment.mjs';
const root=await mkdtemp(join(tmpdir(),'native-scorecard-'));setIsolatedTestHome(root);
try {
 const policy={schema:1,version:'fixture',roles:{interviewer:{'candidate.read':'assigned','feedback.write':'participated'}},subjects:[{id:'interviewer',active:true,roles:['interviewer'],bindings:[{kind:'feishu',route:'muka-hr',appId:'app',tenant:'tenant',openId:'ou_fixture'}]}]};
 const policyPath=join(root,'policy.json'),guard=join(root,'guard.json');
 await writeFile(policyPath,JSON.stringify(policy));await writeFile(guard,JSON.stringify({hrPolicyPath:policyPath,hrInstance:'hr'}));process.env.REMOTELAB_REQUEST_ACCESS_GUARD=guard;
 const {scorecardSummary,acceptInterviewScorecard,processInterviewScorecard}=await import('../connectors/feishu/interview-scorecard.mjs');
 const {refreshRuntimeHrPolicy}=await import('../lib/hr-policy.mjs');
 const {requireFullFeishuAccess}=await import('../connectors/feishu/restricted-access.mjs');
 const runtime={config:{appId:'app',accessPolicy:{mode:'roles',roles:{appId:'app',tenantKey:'tenant',hrPolicy:true,scorecardWorkflowCommand:[process.execPath,'-e','process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({handled:true})))']}}}};
 const raw={header:{app_id:'app',tenant_key:'tenant',event_id:'fixture-event'},event:{operator:{open_id:'ou_fixture',tenant_key:'tenant'},context:{open_message_id:'om_fixture',open_chat_id:'oc_fixture'},action:{tag:'button',name:'pretrain_rate_fundamentals_3',form_value:{intendedWork:'fixture task'}}}};
 const summary=scorecardSummary(runtime.config,raw);assert.equal(summary.sender.openId,'ou_fixture');
 assert.throws(()=>requireFullFeishuAccess(runtime.config.accessPolicy,summary),'special lane never enables general agent');
 let accepted=0;const inbox={accept:async()=>{accepted++;}};
 assert.equal((await acceptInterviewScorecard(runtime,raw,inbox)).toast.type,'info');assert.equal(accepted,1);
 assert.equal((await processInterviewScorecard(runtime,summary)).handled,true);
 for(const altered of [r=>r.header.app_id='other',r=>r.event.operator.tenant_key='other',r=>r.event.action.form_value='bad',r=>r.event.context.open_message_id='invalid']){
   const bad=structuredClone(raw);altered(bad);assert.equal((await acceptInterviewScorecard(runtime,bad,inbox)).toast.type,'error');
 }
 assert.equal(accepted,1);
 assert.equal(await acceptInterviewScorecard(runtime,{event:{action:{name:'unrelated'}}},inbox),null);
 policy.subjects[0].active=false;await writeFile(policyPath,JSON.stringify(policy));
 assert.deepEqual(await processInterviewScorecard(runtime,summary),{blocked:true},'revocation after admission blocks execution');
 await refreshRuntimeHrPolicy();assert.equal((await acceptInterviewScorecard(runtime,raw,inbox)).toast.type,'error');
 console.log('PASS native scorecards: authenticated callback, fixed executor, general-access isolation and revocation');
} finally {await rm(root,{recursive:true,force:true});}

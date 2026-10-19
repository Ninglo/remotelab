import {setIsolatedTestHome} from './isolate-test-environment.mjs';
import{mkdtemp,mkdir,writeFile,rm,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{Readable}from'node:stream';import assert from'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'case-feedback-'));setIsolatedTestHome(root);
const{createProjectFeedbackStore}=await import('../chat/project-feedback.mjs');const{createProjectFeedbackHandler}=await import('../chat/router-project-feedback-routes.mjs');
try{
 const reviewFile=join(root,'review.json'),legacyFile=join(root,'legacy.json'),qianyanFile=join(root,'qianyan.json'),configFile=join(root,'config.json');
 await writeFile(reviewFile,JSON.stringify({subprojects:[],classifications:[]}));await writeFile(legacyFile,'{}');await writeFile(qianyanFile,'{}');await writeFile(configFile,JSON.stringify({reviewFile,legacyFile,qianyanFile,writeDir:join(root,'records')}));
 const store=createProjectFeedbackStore({configFile}),personLookup=async id=>({id,name:'Verified '+id});
 const handler=createProjectFeedbackHandler({store,personLookup,usageStore:{record:async()=>{}}});
 async function call(method,body,actor='a',extra={}){const req=Readable.from(method==='POST'?[JSON.stringify(body)]:[]);Object.assign(req,{method,url:'/api/project-feedback?caseProject=embodied-evaluation&caseSpace=workbench-v2',headers:{origin:'https://example.test',host:'example.test','x-forwarded-proto':'https','content-type':'application/json',...extra.headers}});let result;await handler({req,res:{setHeader(){}},pathname:'/api/project-feedback',authSession:actor?{personId:actor,identityId:'identity_'+actor,...extra.auth}:null,writeJson:(_,status,json)=>result={status,json}});return result;}
 const payload={client_id:'123e4567-e89b-42d3-a456-426614174000',comment:'A concrete review',reviewer:'FORGED',actor:{name:'FORGED'},target_title:'Case',target_url:'https://example.test/case-review/#C19',case_review:{projectId:'embodied-evaluation',space:'workbench-v2',caseId:'C19',category:'平台工程',scores:{quality_0:85},weights:{understanding:25,timeliness:25,intervention:25,quality:25},next:'Fix',observation:'Check outcome'}};
 const batch=await Promise.all(Array.from({length:5},()=>call('POST',payload)));
 assert.equal(batch.filter(x=>x.status===201).length,1);assert.equal(new Set(batch.map(x=>x.json.record.id)).size,1);assert.equal(batch[0].json.record.author,'Verified a');assert(!JSON.stringify(batch).includes('FORGED'));
 assert.equal((await call('POST',{...payload,comment:'B review'},'b')).status,201);
 const shared=(await call('GET')).json.records;assert.equal(shared.length,2);assert.deepEqual(new Set(shared.map(r=>r.author)),new Set(['Verified a','Verified b']));assert.equal(shared.find(r=>r.person_id==='a').case_review.scores.quality_0,85);assert.equal(shared[0].case_review.scores.timeliness_0,null);
 assert.equal((await call('POST',{...payload,comment:'Changed same id'})).status,409);
 assert.equal((await call('POST',payload,null)).status,403);assert.equal((await call('POST',payload,'a',{auth:{authKind:'service'}})).status,403);assert.equal((await call('POST',payload,'a',{headers:{origin:'https://evil.test'}})).status,403);
 assert.equal((await call('POST',{...payload,case_review:{...payload.case_review,scores:{quality_0:101}}})).status,400);
 assert.equal((await createProjectFeedbackStore({configFile}).readCases('embodied-evaluation','workbench-v2')).records.length,2);assert.equal((await store.readCases('embodied-evaluation','workbench-selected-v1')).records.length,0);assert.equal((await store.readCases('claude-tag','workbench-v2')).records.length,0);
 assert.equal((await call('POST',{...payload,client_id:'123e4567-e89b-42d3-a456-426614174001',comment:'Revised review'})).status,201);assert.equal((await call('GET')).json.records.length,3);
 console.log('PASS: authenticated author, shared persistence, retry deduplication, append-only revisions, project/material isolation, score validation, anonymous/service/cross-origin rejection');
}finally{await rm(root,{recursive:true,force:true})}

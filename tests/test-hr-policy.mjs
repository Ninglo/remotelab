import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setIsolatedTestHome} from './isolate-test-environment.mjs';
const root=await mkdtemp(join(tmpdir(),'hr-policy-'));
setIsolatedTestHome(root);
const {validateHrPolicy,resolveHrActor,authorizeHr,hrScopes,loadConfiguredHrPolicy,refreshRuntimeHrPolicy,runtimeHrPolicy}=await import('../lib/hr-policy.mjs');
const {hrManagementActor}=await import('../chat/router-hr-access.mjs');
const {canReadSession,hrBrowserRestricted}=await import('../chat/session-access.mjs');
const policy={schema:1,version:'fixture-v1',roles:{
  hr1:{'hr.read':'all','candidate.write':'all','policy.roles':'all','policy.scope':'all'},
  hr2:{'hr.read':'all','candidate.write':'all'}, recruiting:{'jobs.read':'shared','candidate.read':'owned','candidate.write':'owned'},
  interviewer:{'candidate.read':'assigned','feedback.write':'participated'},boss:{'hr.read':'all','candidate.read':'all','feedback.write':'participated'}},
  sharedWeb:[{instance:'hr',personId:'shared',identityId:'shared-web'}],
  subjects:['owner','hr1','hr2','recruiting','interviewer','boss'].map((id,index)=>({id,active:true,owner:id==='owner',roles:[id==='owner'?'hr1':id],
    openId:`ou_${id}`,userId:`user${index}`,bindings:[{kind:'web',instance:'hr',personId:id,identityId:id+'-web'},
      {kind:'feishu',route:'hr-route',appId:'app',tenant:'tenant',openId:`ou_${id}`}]}))};
const actor=id=>policy.subjects.find(s=>s.id===id);
try {
  validateHrPolicy(policy);
  for(const id of ['owner','hr1','hr2','boss'])assert.equal(authorizeHr(policy,actor(id),'hr.read'),true);
  for(const id of ['hr2','recruiting','interviewer','boss'])assert.equal(authorizeHr(policy,actor(id),'policy.roles'),false);
  for(const id of ['hr1','hr2','boss'])assert.equal(authorizeHr(policy,actor(id),'users.add'),false);
  assert.equal(authorizeHr(policy,actor('owner'),'users.add'),true);
  assert.equal(authorizeHr(policy,actor('boss'),'candidate.write'),false);
  actor('hr2').deniedActions=['candidate.read'];assert.deepEqual(hrScopes(policy,actor('hr2'),'candidate.write'),[]);delete actor('hr2').deniedActions;
  actor('hr2').scopeOverrides={'candidate.read':'owned','candidate.write':'none'};assert.deepEqual(hrScopes(policy,actor('hr2'),'candidate.write'),[]);delete actor('hr2').scopeOverrides;
  const scope={assignmentVerified:true,interviewerOpenIds:['ou_boss'],participated:true};
  assert.equal(authorizeHr(policy,actor('boss'),'feedback.write',scope),true);
  assert.equal(authorizeHr(policy,actor('boss'),'feedback.write',{...scope,participated:false}),false);
  assert.equal(authorizeHr(policy,actor('boss'),'feedback.write',{...scope,cancelled:true}),false);
  assert.equal(authorizeHr(policy,actor('recruiting'),'candidate.read',{ownerUserId:actor('recruiting').userId}),true);
  assert.equal(authorizeHr(policy,actor('recruiting'),'candidate.read',{ownerUserId:'someone-else'}),false);
  const web={viewPersonId:'owner',initiatedByIdentityId:'owner-web'};
  assert.equal(resolveHrActor(policy,web,'hr').id,'owner');
  assert.equal(resolveHrActor(policy,web,'other'),null);
  const source={feishuConnectorAuthenticated:true,sourceContext:{connector:'feishu',sourceRouteId:'hr-route',appId:'app',tenantKey:'tenant',sender:{senderType:'user',openId:'ou_owner'}}};
  assert.equal(resolveHrActor(policy,source,'hr').id,'owner');
  assert.equal(resolveHrActor(policy,{...source,feishuConnectorAuthenticated:false},'hr'),null);
  assert.equal(resolveHrActor(policy,{...source,sourceContext:{...source.sourceContext,appId:'forged'}},'hr'),null);
  assert.equal(resolveHrActor(policy,{...source,sourceContext:{...source.sourceContext,sourceRouteId:'other'}},'hr'),null);
  const shared=resolveHrActor(policy,{viewPersonId:'shared',initiatedByIdentityId:'shared-web'},'hr');
  assert.equal(authorizeHr(policy,shared,'jobs.read',{shared:true}),true);
  assert.equal(authorizeHr(policy,shared,'candidate.read',{ownerUserId:'shared'}),false);
  actor('hr2').scopeOverrides={'hr.read':'none'};assert.deepEqual(hrScopes(policy,actor('hr2'),'hr.read'),[]);
  actor('hr2').active=false;assert.equal(resolveHrActor(policy,{viewPersonId:'hr2',initiatedByIdentityId:'hr2-web'},'hr'),null);
  const current={policy,instance:'hr'};
  assert.equal(hrManagementActor({authKind:'service'},null,current),null);
  assert.equal(hrManagementActor({authKind:'service'},{options:web,result:null},current).id,'owner');
  assert.equal(hrManagementActor({authKind:'service'},{options:web,result:{}},current),null);
  assert.equal(hrManagementActor({authKind:'password',personId:'hr2',identityId:'hr2-web'},{options:web},current),null);
  const file=join(root,'policy.json'),guard=join(root,'guard.json');
  await writeFile(file,JSON.stringify(policy));
  await writeFile(guard,JSON.stringify({hrPolicyPath:file,hrInstance:'hr',hrRestrictedRuntime:true,hrEnforceAfter:'2026-01-01T00:00:00Z'}));
  process.env.REMOTELAB_REQUEST_ACCESS_GUARD=guard;await refreshRuntimeHrPolicy();
  const browser={authKind:'password',personId:'shared',identityId:'shared-web'};
  const admin={administratorPersonIds:['shared']};
  assert.equal(hrBrowserRestricted(browser),true);
  assert.equal(canReadSession(browser,{created:'2025-12-01',creatorIdentityId:'shared-web'},admin),false);
  assert.equal(canReadSession(browser,{created:'2026-02-01',creatorIdentityId:'owner-web'},admin),false);
  assert.equal(canReadSession(browser,{created:'2026-02-01',creatorIdentityId:'shared-web'},admin),true);
  const creds=join(root,'credentials.json');await writeFile(creds,JSON.stringify({apiKey:'fixture',signingKey:'fixture-signing'}));
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async (_url,{body})=>{const request=JSON.parse(body);assert.equal(request.senderOpenId,'policy-service');assert.equal(request.subjectId,undefined);
      return {ok:true,text:async()=>JSON.stringify({policyVersion:1,policy})};};
    const config={hrPolicyRegistry:{endpoint:'https://fixture.invalid/query',credentialsPath:creds,appId:'app',tenant:'tenant'}};
    assert.equal((await loadConfiguredHrPolicy(config)).version,'fixture-v1');
    await writeFile(guard,JSON.stringify({...config,hrRestrictedRuntime:true,hrInstance:'hr'}));
    await refreshRuntimeHrPolicy();
    globalThis.fetch=async()=>{throw new Error('network failed');};
    await assert.rejects(refreshRuntimeHrPolicy());assert.equal(runtimeHrPolicy().policy,null);
    assert.equal(hrBrowserRestricted({authKind:'password',personId:'owner',identityId:'owner-web'}),true);
  } finally {globalThis.fetch=originalFetch;}
  console.log('PASS: identity, owner separation, role scopes, assignment, shared history, management attribution, registry failure and revocation');
} finally {delete process.env.REMOTELAB_REQUEST_ACCESS_GUARD;await refreshRuntimeHrPolicy();await rm(root,{recursive:true,force:true});}

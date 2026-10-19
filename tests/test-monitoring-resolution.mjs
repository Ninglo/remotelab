import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';

const root = await mkdtemp(join(tmpdir(), 'monitoring-resolution-'));
setIsolatedTestHome(root);
const configDir=join(root,'.config/remotelab');
await mkdir(configDir,{recursive:true});
const fakeTool=join(root,'fake-monitoring-provider');
await writeFile(fakeTool, '#!/usr/bin/env node\n'+[
  {type:'thread.started',thread_id:'monitoring-fixture'},
  {type:'item.completed',item:{type:'agent_message',text:'Fixture handled the issue'}},
  {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}},
].map(event=>'console.log('+JSON.stringify(JSON.stringify(event))+');').join('\n'));
await chmod(fakeTool,0o755);
await writeFile(join(configDir,'tools.json'),JSON.stringify([{id:'monitoring-fixture',name:'Fixture',command:fakeTool,runtimeFamily:'codex-json',models:[{id:'fixture-model',label:'Fixture'}]}]));
const { createMonitoringResolutionHandler, loadResolutionContext } = await import('../chat/monitoring-resolution.mjs');
const { createSession, killAll, getHistory } = await import('../chat/session-manager.mjs');
const { loadSessionsMeta } = await import('../chat/session-meta-store.mjs');
const { MANAGED_WORK_ROOT_DIR } = await import('../lib/config.mjs');
await mkdir(MANAGED_WORK_ROOT_DIR,{recursive:true});
const report = '2026-10-19T11-00-16-201Z', item = 'broken-report';
const directory = join(root, 'runs', report);
const config = { analysisRoot:root, portalUrl:'https://app.example/monitoring-preview/', publicOrigin:'https://observe.example', runtime:{tool:'codex'} };
const person = { personId:'person_test', identityId:'identity_test', authKind:'password' };
const input = { capturedAt:'2026-10-19T11:00:00Z', evidence:[{id:'service', data:{errors:7}, url:'https://evidence.example/'}, {id:'unrelated', data:'other issue'}] };
const original = { id:report, inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'), capturedAt:input.capturedAt,
  prompt:'Frozen analysis prompt', output:{ summary:'Summary', items:[{ id:item, title:'修复报表', finding:'Seven failures', nextStep:'Read the logs', successSignal:'New report delivered', whyNow:'Still happening', evidenceRefs:['service'] }] } };
await mkdir(directory, {recursive:true});
await writeFile(join(directory, 'input.json'), JSON.stringify(input));
await writeFile(join(directory, 'report.json'), JSON.stringify(original));
const submissions = new Map(); let attempts = 0, rejectNext = false;
const runtime = async () => ({ create:createSession, accepted:async(id,key)=>submissions.has(key),
  find:async key => (await loadSessionsMeta()).find(s => s.externalTriggerId === key),
  submit:async (sessionId, text, attachments, options) => {
    attempts++;
    if (rejectNext) { rejectNext = false; throw Error('Transient submit failure'); }
    if (submissions.has(options.requestId)) {
      assert.equal(submissions.get(options.requestId).text, text);
      return {duplicate:true};
    }
    submissions.set(options.requestId, {sessionId, text, options, attachments}); return {duplicate:false};
  } });
const handler = createMonitoringResolutionHandler({configReader:async()=>config, runtime});
async function call(method = 'POST', payload = {report,item}, options = {}) {
  const pathname = options.pathname || '/api/monitoring-resolution';
  const req = Readable.from(method === 'POST' ? [JSON.stringify(payload)] : []);
  req.method = method; req.url = pathname + '?' + new URLSearchParams(payload);
  req.headers = {origin:config.portalUrl.split('/monitoring')[0], 'content-type':'application/json', ...options.headers};
  const response = {};
  const res = {writeHead(status,headers){response.status=status;response.headers=headers}, end(body){response.body=body}};
  await (options.handler || handler)({req,res,pathname,authSession:options.auth === undefined ? person : options.auth,
    writeJson(_res,status,body){response.status=status;response.json=body}});
  return response;
}
try {
  assert.equal((await call('GET')).json.session, null); assert.equal(attempts, 0);
  const page = await call('GET', {report,item}, {pathname:'/monitoring-resolve'});
  assert.equal(page.status, 200); assert.match(page.body, /data-origin="https:\/\/observe.example"/); assert.equal(attempts, 0);
  for (const auth of [null, {...person,authKind:'service'}, {personId:'only-person'}]) assert.equal((await call('POST',undefined,{auth})).status,403);
  for (const origin of ['https://evil.example', '', 'null']) assert.equal((await call('POST',undefined,{headers:{origin}})).status,403);
  assert.equal((await call('POST',{report:'../../etc',item})).status,400);
  assert.equal((await call('POST',{report,item:'missing'})).status,404);
  assert.equal(attempts,0);
  const results = await Promise.all(Array.from({length:6},()=>call()));
  assert(results.every(r=>r.status===200 && r.json.accepted));
  assert.equal(new Set(results.map(r=>r.json.session.sessionId)).size,1);
  assert.equal(attempts,1); assert.equal(submissions.size,1);
  const session = (await loadSessionsMeta()).find(s=>s.id===results[0].json.session.sessionId);
  assert.equal(session.initiatedByIdentityId,person.identityId);
  assert(!session.conversation);
  const submission = [...submissions.values()][0];
  for (const value of ['Seven failures','Read the logs','New report delivered','可能已经过期',directory,'input.json','report.json','service']) assert(submission.text.includes(value));
  for (const value of ['Frozen analysis prompt','"errors": 7','other issue']) assert(!submission.text.includes(value));
  assert(submission.text.length<1500);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'input.json'),'utf8')),input);
  assert.equal(submission.options.initiatedByIdentityId,person.identityId);
  assert.equal(submission.options.usagePersonId,person.personId);
  assert.equal(submission.options.suppressSourceDelivery,true);
  assert.equal((await call('GET')).json.session.sessionId,session.id);
  assert.equal((await call()).json.duplicate,true); assert.equal(submissions.size,1);
  assert.equal(attempts,1);
  // Old verbose requests must remain untouched after a formatter deployment.
  submission.text='A previously admitted verbose input';
  assert.equal((await call()).json.accepted,true); assert.equal(attempts,1);
  assert.equal(submission.text,'A previously admitted verbose input');
  // A created Session survives failed submission; retry submits to the same one.
  const other = { ...person,personId:'person_other',identityId:'identity_other' };
  rejectNext = true;
  assert.equal((await call('POST',undefined,{auth:other})).status,500);
  const pendingResult = (await call('GET',undefined,{auth:other})).json;
  assert.equal(pendingResult.accepted,false);
  const pending = pendingResult.session;
  assert(pending);
  const retried = await call('POST',undefined,{auth:other});
  assert.equal(retried.json.session.sessionId,pending.sessionId); assert.equal(submissions.size,2);
  const before = attempts;
  await writeFile(join(directory,'input.json'),JSON.stringify({...input,changed:true}));
  assert.equal((await call()).status,409);assert.equal(attempts,before);
  await assert.rejects(loadResolutionContext(config,'../../etc','passwd'));
  await writeFile(join(directory,'input.json'),JSON.stringify(input));
  // Actual native admission, durable request, runner and stored user context,
  // using an isolated deterministic provider (no model or network invocation).
  const nativeHandler=createMonitoringResolutionHandler({configReader:async()=>({...config,runtime:{tool:'monitoring-fixture',model:'fixture-model'}})});
  const nativeOptions={auth:{...person,personId:'person_native',identityId:'identity_native'},handler:nativeHandler};
  const native=await call('POST',undefined,nativeOptions);
  assert.equal(native.status,200);assert.equal(native.json.accepted,true);
  const { requests }=await import('../chat/requests.mjs');
  const deadline=Date.now()+15000;let request,delay=250;
  while(Date.now()<deadline){
    request=await requests.byRequest(native.json.session.sessionId,native.json.requestId);
    if(request?.result)break;
    await new Promise(resolve=>setTimeout(resolve,delay));delay=Math.min(delay*2,2000);
  }
  assert.equal(request?.result?.state,'completed',JSON.stringify(request?.result));
  assert.equal(request.text.includes('Seven failures'),true);
  const history=await getHistory(native.json.session.sessionId);
  assert(history.some(event=>event.role==='user'&&event.content.includes('input.json')&&!event.content.includes('"errors": 7')));
  assert.equal((await call('POST',undefined,nativeOptions)).json.duplicate,true);
  assert.equal((await call('GET',undefined,nativeOptions)).json.accepted,true);

  // Relay requires the exact opener, trusted origin and selected issue.
  const source = await readFile(new URL('../static/chat/monitoring-resolve.js',import.meta.url),'utf8');
  const listeners={},posts=[],fetches=[],locations=[];const opener={postMessage:(...a)=>posts.push(a)};
  const button={dataset:{origin:config.publicOrigin,report,item},addEventListener:(k,f)=>listeners.click=f};
  runInNewContext(source,{document:{getElementById:id=>id==='resolve'?button:{}},window:{opener,addEventListener:(k,f)=>listeners[k]=f},location:{replace:url=>locations.push(url)},fetch:async(url,options)=>{fetches.push({url,options});return {ok:true,json:async()=>({accepted:true,session:{url:'/?session=test'}})}}});
  assert.equal(fetches.length,0);assert.equal(posts.length,1);
  const message={type:'monitoring-resolve-click',report,item};
  for(const event of [{source:{},origin:config.publicOrigin,data:message},{source:opener,origin:'https://evil.example',data:message},{source:opener,origin:config.publicOrigin,data:{...message,item:'other'}}])listeners.message(event);
  assert.equal(fetches.length,0);
  listeners.message({source:opener,origin:config.publicOrigin,data:message});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fetches.length,1);assert.equal(locations[0],'/?session=test');
  console.log('PASS: frozen evidence, real Session ownership, concurrent/retry deduplication, no GET launch, origin/identity checks, relay gesture');
} finally { await killAll(); await rm(root,{recursive:true,force:true}); }

// Uses the installed Codex against a loopback fixture: no model credentials or group delivery.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const binary = process.env.REMOTELAB_NATIVE_CODEX_BIN;
const originalPath = process.env.PATH;
test('installed Codex restores current scoped RemoteLab rules before inference after native compaction', { skip: !binary, timeout: 45000 }, async () => {
 const home = await mkdtemp(join(tmpdir(), 'native-rules-')); setIsolatedTestHome(home);
 const { createCodexDriver } = await import('../chat/native/codex.mjs');
 const { projectRuleContext } = await import('../chat/rule-context.mjs');
 const { renderModelContextSlots } = await import('../chat/model-context-slots.mjs');
 const projection = await projectRuleContext('fixture-session', [{id:'strict_start_check', title:'Personal', content:'MUST_KEEP_FINAL_CAVEAT_791'}], {enabled:true,recovery:'codex-session-start',requestId:'one',personId:'alice'});
 const bodies=[], paths=[], stderr=[];
 let emitTool = false;
  const server = createServer(async (request, response) => {
    paths.push(`${request.method} ${request.url}`);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.method !== 'POST' || !request.url.startsWith('/v1/responses')) {
      response.writeHead(404); response.end(); return;
    }
    const body = JSON.parse(raw || '{}');
    bodies.push(body);
    const number = bodies.length;

    const text = `SUMMARY_WITHOUT_REMOTELAB_RULES_${number}`;
    let item = { id: `msg_${number}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const toolTurn = emitTool; emitTool = false;
    if (toolTurn) item = { type: 'function_call', id: `fc_${number}`, call_id: `call_${number}`, name: 'exec_command', arguments: JSON.stringify({cmd:'true', max_output_tokens:10}) };
    const result = { id: `resp_${number}`, object: 'response', created_at: 1, status: 'completed', output: [item], model: body.model,
      usage: { input_tokens: toolTurn ? 50000 : 10, output_tokens: 5, total_tokens: toolTurn ? 50005 : 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emitted = [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content?.[0] },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ];
    if (toolTurn) emitted.splice(1, emitted.length - 2, {type:'response.output_item.done', output_index:0, item});
    for (const event of emitted) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const codexHome = join(home, '.codex'), directory = join(home, 'run');
  await mkdir(codexHome, { recursive: true }); await mkdir(directory, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\nmodel_auto_compact_token_limit = 20000\nmodel_context_window = 100000\ncheck_for_update_on_startup = false\nweb_search = "disabled"\nchatgpt_base_url = "${baseUrl}"\n\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "${baseUrl}/v1"\nenv_key = "CODEX_FIXTURE_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n`);
  const env = { PATH: originalPath, HOME: home, CODEX_HOME: codexHome, SHELL: '/bin/sh', CODEX_FIXTURE_API_KEY: 'dummy-local-fixture',
    OTEL_SDK_DISABLED: 'true', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' };

 const { CONFIG_DIR } = await import('../lib/config.mjs'); env.REMOTELAB_CONFIG_DIR = CONFIG_DIR;
 let child, activeTurn, settledResolve; const pending=new Map(); let rpcId=1000000;
 const nextSettled=()=>new Promise(resolve=>{settledResolve=resolve;});
 const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});send({id,method,params});});
 const observed=[];
 const driver=createCodexDriver({send,options:{model:'gpt-5.4',disableApps:true,ruleRecoverySessionId:'fixture-session'},cwd:home,
  onEvent:event=>observed.push(event),onSettled:result=>{settledResolve?.(result);settledResolve=null;},onError:error=>{stderr.push(error.message);}});
 child=spawn(binary,driver.args,{cwd:home,env});child.stderr.on('data',x=>stderr.push(String(x)));
 createInterface({input:child.stdout}).on('line',line=>{let msg;try{msg=JSON.parse(line)}catch{return;}
  const own=pending.get(msg.id);if(own){pending.delete(msg.id);msg.error?own.reject(new Error(JSON.stringify(msg.error))):own.resolve(msg.result);return;}
  driver.handle(msg);
 });
 try {
  let settled=nextSettled(); const first=await driver.start('<private>\n'+renderModelContextSlots(projection.slots)+'\n</private>\nCurrent user message: Say ready.');
  assert.equal((await settled).status,'completed',stderr.join('\n'));
  settled=nextSettled();await request('thread/compact/start',{threadId:first.threadId}); await settled;
  settled=nextSettled();await driver.submit({id:'two',text:'Continue after compaction.'});await settled;
  const last=JSON.stringify(bodies.at(-1).input);
  assert.match(last,/MUST_KEEP_FINAL_CAVEAT_791/,stderr.join('\n'));
  assert.ok(last.includes('RemoteLab context restored after native compaction'), 'missing hook body; '+stderr.join('\n'));
  assert.equal(bodies.length,3,'the recovery hook itself adds no model call');
  const delta = await projectRuleContext('fixture-session', [
    {id:'strict_start_check', title:'Personal', content:'MUST_KEEP_FINAL_CAVEAT_791'},
    {id:'project_memory', title:'Project background', content:'PROJECT_BRIEF_COMPLETE_TAIL_914'},
  ], {enabled:true,recovery:'codex-session-start',requestId:'project-update',personId:'alice',
    identity:{field:'codexThreadId',id:first.threadId}}, {
    head:async()=>1, history:async()=>[{type:'message',role:'user',requestId:'one'}],
    request:async()=>({requestId:'one',runId:'fixture-run'}),
    run:async()=>({id:'fixture-run',sessionId:'fixture-session',codexThreadId:first.threadId}),
    accepted:async()=>({state:'accepted'}), manifest:async()=>({ruleContextDelivery:projection.receipt}),
  });
  assert.equal(delta.receipt.mode,'delta');
  assert.doesNotMatch(renderModelContextSlots(delta.slots),/MUST_KEEP_FINAL_CAVEAT_791/);
  settled=nextSettled(); await driver.submit({id:'project-update',text:'<private>\n'+renderModelContextSlots(delta.slots)+'\n</private>\nCurrent user message: Ready.'});await settled;
  settled=nextSettled(); await request('thread/compact/start',{threadId:first.threadId});await settled;
  settled=nextSettled(); await driver.submit({id:'project-restore',text:'Continue after project update and compaction.'});await settled;
  const afterDelta=JSON.stringify(bodies.at(-1).input);
  assert.match(afterDelta,/MUST_KEEP_FINAL_CAVEAT_791/);
  assert.match(afterDelta,/PROJECT_BRIEF_COMPLETE_TAIL_914/);
  const b = await projectRuleContext('fixture-session', [{id:'surface_messages', title:'Display',content:'BOB_CURRENT_NO_ALICE_802'}], {enabled:true,recovery:'codex-session-start',requestId:'b',personId:'bob'});
  settled=nextSettled(); await driver.submit({id:'b',text:'<private>\n'+renderModelContextSlots(b.slots)+'\n</private>\nCurrent user message: Ready.'}); await settled;
  settled=nextSettled(); await request('thread/compact/start',{threadId:first.threadId});await settled;
  settled=nextSettled();await driver.submit({id:'c',text:'Continue as Bob.'});await settled;
  const restoredBody=()=>bodies.at(-1).input.flatMap(item=>item.content||[]).map(part=>part.text||'').filter(text=>text.includes('RemoteLab context restored after native compaction')).at(-1)||'';
  const switched=restoredBody();
  assert.match(switched,/BOB_CURRENT_NO_ALICE_802/);assert.doesNotMatch(switched,/MUST_KEEP_FINAL_CAVEAT_791/);
  const beforeAuto=bodies.length;emitTool=true;
  settled=nextSettled();await driver.submit({id:'auto',text:'Run true and finish.'});await settled;
  assert.equal(bodies.length-beforeAuto,3,'tool inference, automatic compaction, continuation');
  assert.match(JSON.stringify(bodies.at(-1).input),/RemoteLab context restored after native compaction/);
  assert.match(JSON.stringify(bodies.at(-1).input),/BOB_CURRENT_NO_ALICE_802/);
  assert.doesNotMatch(restoredBody(),/MUST_KEEP_FINAL_CAVEAT_791/);
  settled=nextSettled();await request('thread/compact/start',{threadId:first.threadId});await settled;
  await rm(b.receipt.file);const beforeFailure=bodies.length;
  settled=nextSettled();await driver.submit({id:'missing',text:'Continue with a missing rule snapshot.'});const stopped=await settled;
  assert.equal(stopped.status,'failed','recovery failure must not look like successful task completion');
  assert.match(stopped.error,/RemoteLab rule recovery failed/);
  assert.equal(bodies.length,beforeFailure,'unreadable rules stop continuation before another inference');
  const { usageEvents } = await import('../chat/usage-events.mjs');
  const ledger = await usageEvents.query({ contextOnly: true, sessionId: 'fixture-session' });
  const events = ledger.events.filter(x => x.event === 'context_rule');
  assert(events.some(x => x.state === 'prepared' && x.fingerprint === b.receipt.fingerprint));
  assert(events.some(x => x.state === 'failed' && x.errorCode === 'ENOENT'));
  assert(observed.filter(x => x.type === 'remotelab.context_compacted').length >= 3, 'native compactions have explicit evidence');
  assert(!JSON.stringify(events).includes('BOB_CURRENT'), 'telemetry must not copy rule bodies');
  console.log('verified installed native compaction recovery across '+bodies.length+' loopback inference requests');
 } catch(error) { console.error(error.message.slice(0,700), stderr.slice(-3));throw error; } finally {driver.close();const closed=child.exitCode===null&&child.signalCode===null?once(child,'close'):Promise.resolve();child.kill('SIGKILL');await closed;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});}
});

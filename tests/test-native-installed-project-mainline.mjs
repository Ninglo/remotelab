// Installed Codex + synthetic local responses; no model service, group or device calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const binary = process.env.REMOTELAB_NATIVE_CODEX_BIN;
const originalPath = process.env.PATH;
test('installed Codex reinjects project state and publishes only the accepted final', {skip:!binary,timeout:45000}, async()=>{
 const home=await mkdtemp(join(tmpdir(),'native-mainline-'));setIsolatedTestHome(home);
 const {createCodexDriver}=await import('../chat/native/codex.mjs');
 const {initMainline,showMainline,checkpointMainline,setMainlineBinding}=await import('../lib/project-mainline.mjs');
 const sopPath=join(home,'SOP.md');await writeFile(sopPath,'# Native fixture SOP\nVerify the fixture evidence.');
 const artifact=join(home,'evidence.json');const content='{"fixture":true}';await writeFile(artifact,content);
 const evidence={path:artifact,sha256:createHash('sha256').update(content).digest('hex')};
 await initMainline({enabled: true, enableSourceRequestId: 'fixture-explicit-test',id:'fixture',title:'Native fixture',projectId:'real-device',sessionId:'fixture-session',request:{kind:'project',domain:'real_device',object:'fixture robot task',goal:'KEEP_MAIN_GOAL_791',needsTracking:true,sourceRequestId:'human-fixture',evidence:'isolated experiment'},sop:{document:{kind:'local',path:sopPath},goal:'KEEP_MAIN_GOAL_791',scope:'synthetic fixture',sourceRequestId:'human-fixture',nodes:[{id:'a',title:'Verify',method:'fixture evidence',source:'Native fixture SOP',dependsOn:[],acceptance:['fixture verified']}]}});
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
    if (bodies.length === 1) {
      const shown = await showMainline('fixture-session');
      assert.match(shown.sopDocument.content,/Native fixture SOP/);
      assert.equal(shown.sopDocument.writeback,'deferred');
      await checkpointMainline('fixture-session', { expectedRevision: shown.state.revision, inputToken: shown.inputToken, sourceRequestId: 'human-fixture', summary: 'fixture completed', decision: 'complete', nodes: [{id:'a',status:'done',note:'verified',checks:[{index:0,passed:true,evidence:[evidence]}]}] });
    }
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
 let child, resolveSettled;const observed=[];
 let settled=new Promise(resolve=>{resolveSettled=resolve});
 const driver=createCodexDriver({send:message=>child.stdin.write(JSON.stringify(message)+'\n'),
   options:{model:'gpt-5.4',disableApps:true,projectMainlineSessionId:'fixture-session',ruleRecoverySessionId:'fixture-session'},cwd:home,
   onEvent:event=>observed.push(event),onSettled:result=>resolveSettled(result),onError:error=>stderr.push(error.message)});
 child=spawn(binary,driver.args,{cwd:home,env});child.stderr.on('data',x=>stderr.push(String(x)));
 createInterface({input:child.stdout}).on('line',line=>{try{driver.handle(JSON.parse(line));}catch{}});
 try{
   await driver.start('Return final; fixture intentionally omits its checkpoint.');
   const result=await settled;
   assert.equal(result.status,'completed',JSON.stringify(result)+stderr.join('\n'));
   assert.equal(bodies.length,2,'native Stop reinjects once without a second reviewer');
   assert.match(JSON.stringify(bodies[1].input),/KEEP_MAIN_GOAL_791/);
   assert.match(JSON.stringify(bodies[1].input),/Update and read back/);
   const finals=observed.filter(x=>x.item?.type==='agent_message');
   assert.equal(finals.length,1,'rejected draft and streamed fragments stay out of publication');
   assert.match(finals[0].item.text,/_2/);
   settled=new Promise(resolve=>{resolveSettled=resolve});
   await driver.submit({id:'second',text:'Intentionally omit the next input checkpoint too.'});
   const failed=await settled;
   assert.equal(failed.status,'failed','repeated missing checkpoint cannot report success');
   assert.match(failed.error,/Project mainline check failed/);
   assert.equal(observed.filter(x=>x.item?.type==='agent_message').length,1,'failed turn cannot publish any draft');
   await setMainlineBinding('fixture-session',{enabled:false,sourceRequestId:'human-pause',reason:'explicit disable'});
   settled=new Promise(resolve=>{resolveSettled=resolve});
   await driver.submit({id:'disabled',text:'Return a final with the experiment disabled.'});
   assert.equal((await settled).status,'completed');
   assert.equal(observed.filter(x=>x.item?.type==='agent_message').length,2,'disabled experiment permits the next ordinary final');
   console.log('installed Codex: reinjection, evidence/readback, single final, and bounded failure verified');
 } finally {
   driver.close();const closed=child.exitCode===null&&child.signalCode===null?once(child,'close'):Promise.resolve();child.kill('SIGKILL');await closed;
   server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(home,{recursive:true,force:true});
 }
});

// Explicit opt-in: real model, disposable provider/state homes, loopback HTTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

if (process.env.REMOTELAB_LIVE_FEATURE_OBSERVATION !== '1') {
  console.log('SKIP: REMOTELAB_LIVE_FEATURE_OBSERVATION=1 spends real model budget.'); process.exit(0);
}
const providerSource = process.env.CODEX_HOME || join(process.env.HOME,'.codex');
const providerHome = await mkdtemp(join(tmpdir(),'feature-observation-provider-'));
for (const name of ['config.toml','auth.json']) {
  try {await copyFile(join(providerSource,name),join(providerHome,name));await chmod(join(providerHome,name),0o600);}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('REMOTELAB_')));
env.CODEX_HOME=providerHome;env.HOME=providerHome;
const output=process.env.REMOTELAB_FEATURE_OBSERVATION_EVIDENCE || await mkdtemp(join(tmpdir(),'feature-observation-live-'));
await mkdir(output,{recursive:true});await mkdir(join(output,'task'),{recursive:true});
setIsolatedTestHome(join(output,'state'));
const {CONFIG_DIR}=await import('../lib/config.mjs');
const {requests}=await import('../chat/requests.mjs');
const {appendRunSpoolRecord}=await import('../chat/runs.mjs');
const {appendEvent,loadHistory}=await import('../chat/history.mjs');
const {captureFeatureObservation,observeFeatureAdmission,readFeatureObservations,featureObservationPrompt}=await import('../chat/feature-observation.mjs');
const {handleFeatureObservation}=await import('../chat/router-feature-observation.mjs');
const {createCodexDriver}=await import('../chat/native/codex.mjs');
const {createCodexAdapter}=await import('../chat/adapters/codex.mjs');
const root=join(CONFIG_DIR,'feature-observations');await mkdir(root,{recursive:true});
await writeFile(join(root,'config.json'),JSON.stringify({version:1,trials:[{id:'live-review-week',projectId:'claude-tag',featureId:'delivery-self-review',
  name:'隔离真实自检',enabled:true,durationDays:7,personIds:['person_test'],metrics:[{id:'found',label:'发现的问题数'},{id:'fixed',label:'已修复的问题数'}]}]}));
const options={viewPersonId:'person_test',initiatedByIdentityId:'identity_test',messageReplyPolicy:{selfReview:true,scope:'person'}};
options.featureObservation=await captureFeatureObservation(options);
const record=(await requests.accept({sessionId:'feature-live-test',requestId:'live-input',text:'核对真实统计',options})).record;
await observeFeatureAdmission(record);
await writeFile(join(output,'task/source.csv'),'order,units\na,10\nb,20\n');
await writeFile(join(output,'task/report.json'),'{"rows":999,"total_units":999,"source":"mock"}\n');
let eventWrites=Promise.resolve(),child,driver;
const server=createServer(async(req,res)=>{
  try {
    await eventWrites;
    if(req.url==='/events') {res.setHeader('content-type','application/json');res.end(JSON.stringify(await loadHistory(record.sessionId)));return;}
    await handleFeatureObservation({req,res,pathname:'/api/monitoring/feature-observations',authSession:{authKind:'service'},
      writeJson:(r,status,json)=>{r.writeHead(status,{'content-type':'application/json'});r.end(JSON.stringify(json));}});
  } catch(error){res.writeHead(500);res.end(error.message);}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const helper=join(output,'task/observe.mjs');
await writeFile(helper,`import {runFeatureObservationCommand} from ${JSON.stringify(new URL('../lib/feature-observation-command.mjs',import.meta.url).href)};\nawait runFeatureObservationCommand(process.argv.slice(2),{runId:${JSON.stringify(record.runId)},client:{request:async(path,options)=>{const response=await fetch(${JSON.stringify(base)}+path,{method:options.method,headers:{'content-type':'application/json'},body:JSON.stringify(options.body)});return {response,json:await response.json()};}}});\n`);
const prompt=`这是隔离的交付验收。只操作当前task目录内文件，不访问外部服务或产品配置，不创建子Agent。原交办：用source.csv真实订单交付report.json，字段rows、total_units必须准确，不能使用占位或假数据。前阶段已声称完成，留下report.json。最终交付前核对并在已授权范围内修复。
${featureObservationPrompt(options.featureObservation,record.requestId).replaceAll('remotelab feature-observation',`node ${helper}`).replace('当前 Session 的 /events?filter=all',`${base}/events`)}
完成时用 Artifacts: 块附report.json绝对路径。不要重复发送。先begin，再核查真实文件，取events中的真实tool_result序号填finish；工具结果记录在调用返回后生成。`;
const events=[],adapter=createCodexAdapter();let stderr='';const start=Date.now();
try{
  const settled=new Promise((resolve,reject)=>{
    driver=createCodexDriver({cwd:join(output,'task'),options:{disableApps:true},
      send:message=>child.stdin.write(JSON.stringify(message)+'\n'),
      onEvent:event=>{events.push(event);eventWrites=eventWrites.then(async()=>{
        await appendRunSpoolRecord(record.runId,{ts:new Date().toISOString(),stream:'stdout',json:event});
        for(const normalized of adapter.parseLine(JSON.stringify(event)))await appendEvent(record.sessionId,{...normalized,runId:record.runId});
      });},onSettled:resolve,onError:reject});
    child=spawn('codex',driver.args,{cwd:join(output,'task'),env,stdio:['pipe','pipe','pipe']});
    child.on('error',reject);child.stderr.on('data',chunk=>{stderr+=chunk});
    createInterface({input:child.stdout}).on('line',line=>{try{driver.handle(JSON.parse(line));}catch(error){reject(error);}});
    child.on('exit',code=>reject(new Error('Codex exited before settlement '+code)));
    driver.start(prompt).catch(reject);
  });
  const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
  let outcome;try{outcome=await settled;}finally{clearTimeout(timer);}
  await eventWrites;
  const report=await readFeatureObservations();
  await writeFile(join(output,'evidence.json'),JSON.stringify({durationMs:Date.now()-start,outcome,report,events,stderr},null,2));
  const artifact=JSON.parse(await readFile(join(output,'task/report.json'),'utf8'));
  assert.equal(artifact.rows,2);assert.equal(artifact.total_units,30);
  const trial=report.trials[0];assert.equal(trial.started,1);assert.equal(trial.finished,1);
  assert.equal(trial.outcomes.repaired,1);assert.equal(trial.usage.measured,1);assert.ok(trial.usage.totalTokens>0);
  console.log(JSON.stringify({result:'PASS',durationMs:Date.now()-start,usage:trial.usage,outcomes:trial.outcomes,evidence:join(output,'evidence.json')}));
}catch(error){await eventWrites;await writeFile(join(output,'failure.json'),JSON.stringify({error:error.message,events,stderr},null,2));throw error;
}finally{driver?.close();if(child && child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  await new Promise(resolve=>server.close(resolve));await rm(providerHome,{recursive:true,force:true,maxRetries:3});}

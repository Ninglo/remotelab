import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const testHome = mkdtempSync(join(tmpdir(), 'remotelab-input-labels-'));
const bin = join(testHome, 'bin'), config = join(testHome, '.config/remotelab'), gates = join(testHome, 'gates');
for (const dir of [bin, config, gates]) mkdirSync(dir, { recursive: true });
const tool = join(bin, 'fake-label-tool');
writeFileSync(tool, `#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const prompt=require('fs').readFileSync(0,'utf8');
const labels=prompt.includes("input session-label generator"), final=prompt.includes("single post-turn session-state classifier");
const gateDir=process.env.REMOTELAB_TEST_LABEL_GATES;
function emit(text){
 console.log(JSON.stringify({type:'thread.started',thread_id:'fake-label-thread'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
}
function finish(){
 emit(labels ? JSON.stringify({title:'并行标题',description:'主任务执行期间生成的摘要。',workflowState:'done',workSummary:{summary:'must not apply'}})
 : final ? JSON.stringify({title:'最终标题',description:'已交付最终结果。',shouldSetWorkflowState:true,workflowState:'done',workSummary:{mode:'task',summary:'最终摘要'}})
 : 'The work is complete.');
 if(labels)fs.writeFileSync(path.join(gateDir,'labels-finished'),'yes');
}
function waitForGate(name){const check=()=>{if(fs.existsSync(path.join(gateDir,name))){watch.close();finish();}};const watch=fs.watch(gateDir,check);check();}
if(final)finish();
else if(labels){fs.writeFileSync(path.join(gateDir,'labels-started'),'yes');if(prompt.includes('DELAY_INPUT'))waitForGate('labels-release');else finish();}
else waitForGate('foreground-release');
`);
chmodSync(tool, 0o755);
writeFileSync(join(config, 'tools.json'), JSON.stringify([{ id:'fake-label-tool', name:'Fake labels', command:tool,
  runtimeFamily:'codex-json', models:[{id:'fake',label:'Fake'}], reasoning:{kind:'enum',levels:['low'],default:'low'} }]));
setIsolatedTestHome(testHome);
process.env.REMOTELAB_TEST_LABEL_GATES=gates;
process.env.REMOTELAB_MACHINE_CODEX_HOME=join(testHome,'.codex');
const { createSession, getSession, sendMessage, killAll }=await import('../chat/session-manager.mjs');
async function until(predicate, label) {
 const deadline=Date.now()+10000;
 let delay=25;
 while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,delay));delay=Math.min(500,delay*2);}
 throw Error('Timed out: '+label);
}
const exists=async name=>fs.access(join(gates,name)).then(()=>true,()=>false);
try {
 const session=await createSession(testHome,'fake-label-tool','',{group:'Original'});
 await sendMessage(session.id,'Generate labels while this long task executes.',[],{tool:'fake-label-tool',model:'fake',effort:'low'});
 await until(async()=> (await getSession(session.id)).description==='主任务执行期间生成的摘要。','early labels');
 const early=await getSession(session.id);
 assert.equal(early.name,'并行标题');
 assert.equal(early.activity.run.state,'running','labels arrive before the foreground completes');
 assert.equal(early.workflowState,undefined,'input labels cannot assert completion');
 assert.equal(early.workSummary,undefined,'input labels cannot replace continuity');
 assert.equal(early.group,'Original','input labels cannot reorganize the session');
 await fs.writeFile(join(gates,'foreground-release'),'yes');
 await until(async()=> (await getSession(session.id)).workflowState==='done','final classification');
 assert.equal((await getSession(session.id)).description,'已交付最终结果。');
 await fs.rm(join(gates,'foreground-release'));
 await fs.rm(join(gates,'labels-started'));
 await fs.rm(join(gates,'labels-finished'));
 await sendMessage(session.id,'DELAY_INPUT: a new request.',[],{tool:'fake-label-tool',model:'fake',effort:'low'});
 await until(()=>exists('labels-started'),'delayed classifier starts');
 await fs.writeFile(join(gates,'foreground-release'),'yes');
 await until(async()=> (await getSession(session.id)).workflowState==='done','second final classification');
 await fs.writeFile(join(gates,'labels-release'),'yes');
 await until(()=>exists('labels-finished'),'delayed input finishes');
 // Wait on the real provider process exit and its attempted application by
 // observing an independent final classification read rather than a fixed delay.
 await until(async()=> (await getSession(session.id)).activity.run.state==='idle','second execution finishes');
 const final=await getSession(session.id);
 assert.equal(final.description,'已交付最终结果。');
 assert.equal(final.workflowState,'done');
 assert.equal(final.workSummary.summary,'最终摘要');
 console.log('test-session-input-labels: ok');
} finally {
 await killAll();
 await fs.rm(testHome,{recursive:true,force:true});
}

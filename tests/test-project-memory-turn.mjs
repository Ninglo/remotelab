import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root=await mkdtemp(join(tmpdir(),'project-memory-turn-'));
process.env.REMOTELAB_MEMORY_DIR=join(root,'memory');
process.env.REMOTELAB_CONFIG_DIR=join(root,'config');
process.env.REMOTELAB_SESSION_ID='';
await mkdir(process.env.REMOTELAB_MEMORY_DIR,{recursive:true});
await mkdir(process.env.REMOTELAB_CONFIG_DIR,{recursive:true});
const file=join(process.env.REMOTELAB_MEMORY_DIR,'project-runtime.json');
const config={schemaVersion:1,enabled:true,contextEnabled:true,reviewEnabled:true,releaseId:'v1',indexPath:join(root,'index.md'),ledgerPath:join(root,'projects.md'),workflowPath:join(root,'workflow.md'),projects:[{id:'alpha'},{id:'beta'}],groups:[{sourceRouteId:'bot-a',chatId:'chat',projectIds:['alpha']}],sessionBindings:[]};
try {
  await writeFile(file,JSON.stringify(config));
  await writeFile(config.ledgerPath,'Do not inject this business body.');
  const {buildPrompt}=await import('../chat/session-manager.mjs');
  const session={id:'test-project-memory',name:'alpha',tool:'codex',activeAgreements:[],workboardPilot:false};
  const options={skipSessionContinuation:true,workboardEnabled:false,sourceContext:{connector:'feishu',sourceRouteId:'bot-a',chatId:'chat'}};
  const fresh=await buildPrompt(session.id,session,'begin','','codex',{userMessageCount:0},options);
  assert.match(fresh,/"release":"v1"/);assert.match(fresh,/"projectIds":\["alpha"\]/);assert.doesNotMatch(fresh,/Do not inject/);
  const resumed=await buildPrompt(session.id,{...session,resumeSessionId:'native-id'},'continue','codex','codex',{userMessageCount:2},options);
  assert.match(resumed,/"release":"v1"/);
  await writeFile(file,JSON.stringify({...config,enabled:false}));
  const old=await buildPrompt(session.id,session,'begin','','codex',{userMessageCount:0},options);
  assert.doesNotMatch(old,/Project memory pointers/);assert.match(old,/Memory|RemoteLab/);
  assert.equal(await readFile(config.ledgerPath,'utf8'),'Do not inject this business body.');
  console.log('PROJECT_MEMORY_TURN_VERIFIED: actual fresh/resumed buildPrompt path projects configured v1 pointers; bodies remain unloaded; disabling restores ordinary prompt; no model launch.');
} finally {await rm(root,{recursive:true,force:true});}

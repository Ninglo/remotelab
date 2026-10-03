import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectMemoryPromptBlock, validateProjectMemoryRuntime } from '../chat/project-memory-runtime.mjs';

const dir = await mkdtemp(join(tmpdir(),'project-memory-runtime-'));
const file = join(dir,'runtime.json');
const config = {schemaVersion:1,enabled:true,contextEnabled:true,reviewEnabled:true,releaseId:'v1',indexPath:'/private/index.md',ledgerPath:'/private/projects.md',workflowPath:'/private/workflow.md',projects:[{id:'alpha'},{id:'beta'}],groups:[{sourceRouteId:'bot-a',chatId:'same-chat',projectIds:['alpha']}],sessionBindings:[{sessionId:'declared',projectIds:['beta']}]};
const render = (session,source) => buildProjectMemoryPromptBlock(session,source,{configPath:file});
try {
  await writeFile(file,JSON.stringify(config));
  let text = await render({id:'x'},{sourceRouteId:'bot-a',chatId:'same-chat'});
  assert.match(text,/"projectIds":\["alpha"\]/);assert.doesNotMatch(text,/beta|project facts|user preferences/);
  text=await render({id:'declared'},undefined);assert.match(text,/beta/);assert.match(text,/explicit-session-binding/);
  text=await render({id:'x',name:'alpha',personViews:{p:{group:'alpha'}},conversation:{sourceRouteId:'bot-a',target:{chatId:'same-chat'}}},{sourceRouteId:'bot-b',chatId:'same-chat'});
  assert.equal(text,'');
  assert.match(await render({id:'x',conversation:{sourceRouteId:'bot-a',target:{chatId:'same-chat'}}}),/alpha/);
  await writeFile(file,JSON.stringify({...config,enabled:false}));assert.equal(await render({},undefined),'');
  await writeFile(file,JSON.stringify({...config,contextEnabled:false}));assert.equal(await render({},undefined),'');
  await writeFile(file,'{broken');assert.equal(await render({},undefined),'');
  await writeFile(file,'x'.repeat(65537));assert.equal(await render({},undefined),'');
  assert.throws(()=>validateProjectMemoryRuntime({...config,groups:[...config.groups,...config.groups]}),/Duplicate/);
  assert.throws(()=>validateProjectMemoryRuntime({...config,groups:[{...config.groups[0],projectIds:['invented']}]}),/association/);
  assert.throws(()=>validateProjectMemoryRuntime({...config,indexPath:'/path\nnew prompt'}),/Invalid/);
  console.log('PROJECT_MEMORY_RUNTIME_VERIFIED: exact connector/group and declared Session routing; no title/person inference; no body loading; disabled, missing, malformed and oversized config fall back; ambiguous routes rejected.');
} finally { await rm(dir,{recursive:true,force:true}); }

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'project-group-cards-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://example.test';
let worker, wss;
try {
  const { GROUP_ROUTING_PILOT_FILE } = await import('../lib/group-routing-pilot.mjs');
  const { AUTH_FILE } = await import('../lib/config.mjs');
  const { KNOWLEDGE_ROOT } = await import('../chat/knowledge-pilot.mjs');
  await mkdir(KNOWLEDGE_ROOT, {recursive:true});
  const knowledge = {version:1,id:'wiki',projectId:'p',name:'Wiki',enabled:true,personIds:[],corpusPath:home,
    groups:[{sourceRouteId:'bot',tenantKey:'tenant',chatId:'knowledge-only'}]};
  await writeFile(join(KNOWLEDGE_ROOT,'config.json'),JSON.stringify(knowledge));
  const { PROJECT_MEMORY_RUNTIME_FILE, buildProjectMemoryPromptBlock } = await import('../chat/project-memory-runtime.mjs');
  const brief = join(home, 'brief.md'); await writeFile(brief, '# Goal\nHuman correction takes priority.\n更新时间：today');
  const config = { schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: true, releaseId: 'v1',
    indexPath: join(home, 'index.md'), ledgerPath: join(home, 'ledger.md'), workflowPath: join(home, 'workflow.md'),
    projects: [{ id: 'p', name: 'Project', briefPath: brief, briefUrl: 'https://example.test/doc' }],
    groups: [{sourceRouteId:'bot',chatId:'chat',projectIds:['p'],tenantKey:'tenant'}],sessionBindings:[] };
  await mkdir(join(PROJECT_MEMORY_RUNTIME_FILE, '..'), {recursive:true});
  await writeFile(PROJECT_MEMORY_RUNTIME_FILE,JSON.stringify(config));
  const source={sourceRouteId:'bot',chatId:'chat'};
  let prompt=await buildProjectMemoryPromptBlock({id:'new'},source);
  assert.doesNotMatch(prompt,/Human correction takes priority/);assert.match(prompt,/"hash"/);
  assert(prompt.includes(brief));assert.match(prompt,/Before substantive project work/);
  await writeFile(brief,'Changed after feedback');
  const changedPrompt=await buildProjectMemoryPromptBlock({id:'new'},source);
  assert.notEqual(changedPrompt,prompt,'changed brief refreshes its hash');
  assert.doesNotMatch(changedPrompt,/Changed after feedback/);
  assert.equal(await buildProjectMemoryPromptBlock({}, {...source,sourceRouteId:'other'}),'');
  await writeFile(brief,'x'.repeat(50*1024));
  assert.match(await buildProjectMemoryPromptBlock({},source),/unavailable/);
  await writeFile(brief,'Current project brief');
  const { projectTopicRows, startProjectGroupCards } = await import('../connectors/feishu/project-group-cards.mjs');
  const { buildGroupConfigurationCard } = await import('../connectors/feishu/group-configuration-card.mjs');
  const target={chatId:'chat',tenantKey:'tenant',threadId:'thread',conversationKind:'thread'};
  let topic={id:'a'.repeat(32),name:'Work',conversation:{connector:'feishu',sourceRouteId:'bot',target},activity:{run:{state:'running'}}};
  const other={...topic,id:'b'.repeat(32),conversation:{...topic.conversation,sourceRouteId:'other'}};
  const rows=projectTopicRows(new Map([[topic.id,topic],[other.id,other]]),'chat','bot');
  assert.equal(rows.length,1);assert.equal(rows[0].state,'进行中');
  assert.equal(projectTopicRows(new Map([[topic.id,{...topic,activity:{run:{state:'idle'}}}]]),'chat','bot')[0].state,'未在运行');
  const card=buildGroupConfigurationCard({key:'k',mode:'active',source:{chatId:'chat'}},
    {participationControls:false,responseMode:'mention_only',project:config.projects[0],topics:rows,boardConnected:true});
  assert.match(JSON.stringify(card),/点名回应/);assert.match(JSON.stringify(card),/Project/);
  assert.doesNotMatch(JSON.stringify(card),/"namespace":"participation"/);
  wss=new WebSocketServer({port:0});await once(wss,'listening');
  let signalResolve, signalChat;
  const signal=(chatId='chat')=>new Promise((resolve,reject)=>{signalChat=chatId;signalResolve=resolve;setTimeout(()=>reject(Error('No card update within deadline')),5000).unref();});
  const seen=[], published=[];let overviewResolve;
  const overviewUpdated=new Promise(resolve=>{overviewResolve=resolve;});
  const runtime={config:{projectCards:true,sourceRouteId:'bot',chatBaseUrl:`http://127.0.0.1:${wss.address().port}`,groups:{chat:{responseMode:'mention_only'}}}};
  const record={key:'k',source:{chatId:'chat'},sessionId:'main'};
  const connected=once(wss,'connection');const initial=signal();
  let authAvailable=true, detailReads=0, reading=0, peakReading=0, holdRead, readStarted;
  worker=await startProjectGroupCards(runtime,{
    request:async path=>{
      if(path==='/api/sessions')return {response:{ok:true},json:{sessions:[topic,other]}};
      assert.match(path,/\?view=summary$/);
      detailReads++;reading++;peakReading=Math.max(peakReading,reading);
      const snapshot=topic;
      if(holdRead){const wait=holdRead;holdRead=null;readStarted?.();await wait;}
      reading--;return {response:{ok:true},json:{session:snapshot}};
    },
    ensureAuthCookie:async()=>{if(!authAvailable)throw Error('offline test');return 'test';},onboard:async(_s,opts)=>{assert.equal(opts.projectCard,true);assert.notEqual(_s.chatId,'overview');},
    participation:()=>({state:async summary=>({...record,source:{chatId:summary.chatId}}),publish:async(_record,opts)=>{assert.equal(opts.existingOnly,true);assert.equal(opts.background,true);published.push(_record.source.chatId);if(_record.source.chatId==='overview')overviewResolve();seen.push(projectTopicRows(runtime.projectCardSessions,'chat','bot'));if(_record.source.chatId===signalChat)signalResolve?.();}}),
  });
  const [socket]=await connected;await initial;
  assert.equal(seen.at(-1)[0].state,'进行中');
  topic={...topic,activity:{run:{state:'idle'}},workflowState:'done'};
  const changed=signal();socket.send(JSON.stringify({type:'session_invalidated',sessionId:topic.id}));await changed;
  assert.equal(seen.at(-1)[0].state,'已完成');
  // A burst shares the existing debounce, and hints arriving during a read
  // trigger one later read instead of racing or losing the final state.
  const beforeBurst=detailReads;
  let releaseRead;
  holdRead=new Promise(resolve=>{releaseRead=resolve;});
  const startedRead=new Promise(resolve=>{readStarted=resolve;});
  const hint=()=>socket.send(JSON.stringify({type:'session_invalidated',sessionId:topic.id}));
  for(let i=0;i<100;i++)hint();
  await startedRead;
  assert.equal(detailReads,beforeBurst+1,'100 queued hints require one summary read');
  topic={...topic,activity:{run:{state:'running'}},workflowState:'active'};
  for(let i=0;i<100;i++)hint();
  // WebSocket ping follows these frames, proving they arrived before release.
  const pong=once(socket,'pong');socket.ping('received');await pong;
  releaseRead();
  while(seen.at(-1)?.[0]?.state!=='进行中')await signal();
  assert.equal(detailReads,beforeBurst+2);
  assert.equal(peakReading,1,'same Session never has overlapping reads');
  await writeFile(GROUP_ROUTING_PILOT_FILE, JSON.stringify({version:2,enabled:true,personalOptIn:true,publicRoster:true,groups:[{sourceRouteId:'bot',chatId:'chat',tenantKey:'tenant'}]}));
  const rosterChanged=signal();await writeFile(AUTH_FILE, JSON.stringify({changed:true}));await rosterChanged;
  config.readingPolicy={autoDiscover:true,defaultLevel:'overview',sourceRouteId:'bot',tenantKey:'tenant'};
  config.groups.push({sourceRouteId:'bot',chatId:'overview',projectIds:[],readingLevel:'overview',tenantKey:'tenant'});
  await writeFile(PROJECT_MEMORY_RUNTIME_FILE,JSON.stringify(config));
  await Promise.race([overviewUpdated,new Promise((_,reject)=>setTimeout(()=>reject(Error('Reading-only card did not refresh')),5000).unref())]);
  assert.ok(published.includes('overview'));
  const knowledgeChanged = signal('knowledge-only');
  const knowledgeWrites = published.filter(id => id === 'knowledge-only').length;
  await writeFile(join(KNOWLEDGE_ROOT,'config.json'),JSON.stringify({...knowledge,enabled:false,groups:[],personIds:['person_a']}));
  await knowledgeChanged;
  assert.ok(published.filter(id => id === 'knowledge-only').length > knowledgeWrites,
    'removing group scope refreshes its original card even without a project registration');
  const disconnected=signal();authAvailable=false;socket.close();await disconnected;
  assert.equal(runtime.projectCardsConnected,false);
  console.log('Project group cards: scoped live invalidations, disconnect, completion distinction, unchanged response policy, and fresh bounded brief pointers passed');
} finally {await worker?.stop();if(wss){for(const s of wss.clients)s.terminate();await new Promise(resolve=>wss.close(resolve));}await rm(home,{recursive:true,force:true});}

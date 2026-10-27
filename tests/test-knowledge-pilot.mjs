import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
const temp=await mkdtemp(join(tmpdir(),'knowledge-pilot-'));
process.env.REMOTELAB_CONFIG_DIR=join(temp,'config');
try {
  const {KNOWLEDGE_ROOT:root,captureKnowledgePilot,observeKnowledgeAdmission,queryKnowledge,readKnowledgeObservations,
    readKnowledgeRunMetrics,knowledgePilotPrompt}=await import('../chat/knowledge-pilot.mjs');
  const {requests}=await import('../chat/requests.mjs');
  const {appendEvent}=await import('../chat/history.mjs');
  const {appendRunSpoolRecord,writeRunResult}=await import('../chat/runs.mjs');
  const {handleKnowledgePilot}=await import('../chat/router-knowledge-pilot.mjs');
  const {runKnowledgeCommand}=await import('../lib/knowledge-command.mjs');
  const corpus=join(temp,'corpus');await mkdir(corpus,{recursive:true});await mkdir(root,{recursive:true});
  const sources=[{id:'source-loss',title:'loss分母审计',attribution:'共享方法提供者',evidenceType:'方法提炼',timestamp:'2026-10-26',wikiRef:'sources.md#src-source-loss'}];
  const pages=[{file:'01-loss.md',title:'比较loss口径',whenToUse:'有无监督混合后，训练指标突然下降',aliases:['归一化','loss'],sources},
    {file:'02-escape.md',title:'escape',aliases:[]},
    ...Array.from({length:9},(_,i)=>({file:`hint-${i}.md`,title:'loss示例',aliases:['loss']})),
    {file:'forgotten.md',title:'原域回放',whenToUse:'微调后旧任务退步',aliases:[]}];
  await writeFile(join(corpus,'index.json'),JSON.stringify({version:'v1',pages}));
  await writeFile(join(corpus,'01-loss.md'),'只比较相同 mask 的 loss。');await writeFile(join(corpus,'README.md'),'目录');
  await writeFile(join(temp,'private.md'),'private');await symlink(join(temp,'private.md'),join(corpus,'02-escape.md'));
  const config={version:1,id:'kb',projectId:'claude-tag',enabled:true,name:'组织知识库',personIds:['person_a'],corpusPath:corpus,verificationRequestIds:['verify']};
  const options={viewPersonId:'person_a',initiatedByIdentityId:'identity_a'};
  assert.equal(await captureKnowledgePilot(options),null,'absent config disables');
  await writeFile(join(root,'config.json'),JSON.stringify(config));
  const p=await captureKnowledgePilot(options);assert.equal(p.personId,'person_a');
  for(const change of [{viewPersonId:'person_b'},{initiatedByIdentityId:null},{internalOperation:'job'},{scheduleId:'job'},{automationTitle:'job'},{recordUserMessage:false}])
    assert.equal(await captureKnowledgePilot({...options,...change}),null,'scope must not leak');
  assert.equal(await captureKnowledgePilot(options,{groupFeed:true}),null);
  assert.equal(await captureKnowledgePilot(options,{internalRole:'worker'}),null);
  assert.match(knowledgePilotPrompt(p,'request1'),/remotelab knowledge search/);
  assert.match(knowledgePilotPrompt(p,'request1'),/完整问题目录.*按含义选页.*不限于命中项/);
  assert.doesNotMatch(knowledgePilotPrompt(p,'request1'),/测试期标注/);
  await writeFile(join(root,'config.json'),JSON.stringify({...config,helpedLabel:'【调用了示例wiki】'}));
  const labeled=await captureKnowledgePilot(options);
  assert.equal(labeled.helpedLabel,'【调用了示例wiki】');
  assert.match(knowledgePilotPrompt(labeled,'r'),/实际读到知识正文.*效果记录为 helped.*【调用了示例wiki】/);
  assert.doesNotMatch(knowledgePilotPrompt(p,'request1'),/测试期标注/,'accepted inputs retain their captured policy');
  assert.equal(await captureKnowledgePilot({...options,viewPersonId:'person_b'}),null);
  await writeFile(join(root,'config.json'),JSON.stringify({...config,helpedLabel:'bad\nlabel'}));
  assert.equal(await captureKnowledgePilot(options),null,'invalid labels cannot enter the prompt');
  await writeFile(join(root,'config.json'),JSON.stringify({...config,helpedCitation:'finding-source',helpedLabel:'legacy label'}));
  const cited=await captureKnowledgePilot(options);
  assert.equal(cited.helpedCitation,'finding-source');
  const citationPrompt=knowledgePilotPrompt(cited,'citation');
  assert.match(citationPrompt,/实际读到知识正文.*效果记录为 helped.*引用组织wiki/);
  assert.match(citationPrompt,/具体原始来源.*讨论或推断.*不能称为已验证发现/);
  assert.doesNotMatch(citationPrompt,/legacy label/,'source citation replaces the generic label');
  assert.doesNotMatch(knowledgePilotPrompt(labeled,'old'),/引用组织wiki/,'existing accepted label snapshots remain frozen');
  assert.equal(await captureKnowledgePilot({...options,viewPersonId:'person_b'}),null);
  await writeFile(join(root,'config.json'),JSON.stringify({...config,helpedCitation:'invalid'}));
  assert.equal(await captureKnowledgePilot(options),null);
  await writeFile(join(root,'config.json'),JSON.stringify(config));
  assert.equal(knowledgePilotPrompt(null,'r'), '');
  const {buildPrompt}=await import('../chat/session-manager.mjs');
  const prepared={project:'',directory:'',personalMemory:'',skillExtraction:'',text:''};
  const actualPrompt=await buildPrompt('test-knowledge',{id:'test-knowledge',tool:'codex'},'loss为什么不一样',null,'codex',null,
    {...options,knowledgePilot:p,requestId:'request1'},prepared);
  assert.match(actualPrompt,/Organization knowledge on demand/);
  const labeledPrompt=await buildPrompt('test-label',{id:'test-label',tool:'codex'},'分析',null,'codex',null,
    {...options,knowledgePilot:labeled,requestId:'labeled'},prepared);
  assert.match(labeledPrompt,/【调用了示例wiki】/);
  const citedPrompt=await buildPrompt('test-citation',{id:'test-citation',tool:'codex'},'分析',null,'codex',null,
    {...options,knowledgePilot:cited,requestId:'citation'},prepared);
  assert.match(citedPrompt,/引用组织wiki.*具体原始来源/);
  const otherPrompt=await buildPrompt('test-other',{id:'test-other',tool:'codex'},'hello',null,'codex',null,
    {...options,viewPersonId:'person_b',requestId:'other'},prepared);
  assert.doesNotMatch(otherPrompt,/remotelab knowledge search/);
  const r=(await requests.accept({sessionId:'test-knowledge',requestId:'request1',text:'loss为什么不一样',options:{...options,knowledgePilot:p}})).record;
  const at=Date.now();await observeKnowledgeAdmission(r,root,at);await observeKnowledgeAdmission(r,root,at+1);
  const search=await queryKnowledge(r,{action:'search',query:'loss 归一化',operationId:'search1'});
  assert.equal(search.matches[0].file,'01-loss.md');assert.equal(search.matches[0].text,undefined);
  const missed=await queryKnowledge(r,{action:'search',query:'调完以后老本事忘了',operationId:'search2'});
  assert.equal(missed.matches.length,0);
  assert.equal(missed.catalogComplete,true);
  assert.deepEqual(missed.catalog.map(p=>p.file),pages.map(p=>p.file),'zero hits retain every candidate');
  assert.equal(missed.catalog.at(-1).whenToUse,'微调后旧任务退步');
  assert.equal(search.matches.length,8,'lexical hints retain their bounded size');
  assert.deepEqual(search.catalog,missed.catalog,'partial/top-eight hits cannot hide other candidates');
  assert.equal(search.catalog[1].whenToUse,'','older indexes can still route by title');
  assert.ok(search.catalog.every(p=>!('text' in p) && !('sources' in p)),'routing does not inject body or source content');
  // Most catalog files deliberately do not exist; search must never open them.
  const read=await queryKnowledge(r,{action:'read',page:'01-loss.md',operationId:'read1'});
  assert.equal(read.chars,[...read.text].length);assert.equal(read.kind,'body');
  assert.equal(read.title,'比较loss口径');assert.deepEqual(read.sources,sources);
  assert.equal(search.matches[0].sources,undefined,'search does not inject all source metadata');
  assert.equal((await queryKnowledge(r,{action:'read',page:'01-loss.md',operationId:'read1'})).replayed,true);
  await assert.rejects(queryKnowledge(r,{action:'read',page:'README.md',operationId:'read1'}),/different/);
  await queryKnowledge(r,{action:'read',page:'01-loss.md',operationId:'read2'});
  await queryKnowledge(r,{action:'read',page:'README.md',operationId:'read3'});
  await assert.rejects(queryKnowledge(r,{action:'read',page:'../private.md',operationId:'escape1'}),/index/);
  await assert.rejects(queryKnowledge(r,{action:'read',page:'02-escape.md',operationId:'escape2'}),/outside/);
  await assert.rejects(queryKnowledge({...r,options:{...r.options,viewPersonId:'person_b'}},{action:'read',page:'01-loss.md',operationId:'other'}),/not enabled/);
  const tool=await appendEvent(r.sessionId,{type:'tool_result',runId:r.runId,output:'mask differs in current source'});
  await assert.rejects(queryKnowledge(r,{action:'report',operationId:'bad-evidence',report:{effect:'helped',reason:'changed analysis',evidenceSeqs:[999999]}}),/evidence/);
  await queryKnowledge(r,{action:'report',operationId:'report1',report:{effect:'helped',reason:'先对齐mask再比较',evidenceSeqs:[tool.seq]}});
  const verify=(await requests.accept({sessionId:'test-knowledge',requestId:'verify',text:'test',options:{...options,knowledgePilot:p}})).record;
  await queryKnowledge(verify,{action:'read',page:'01-loss.md',operationId:'verify1'});
  const noRead=(await requests.accept({sessionId:'test-knowledge-2',requestId:'not-read',text:'hello',options:{...options,knowledgePilot:p}})).record;
  await observeKnowledgeAdmission(noRead);
  const sample=(input,output,cached,lastInput,lastOutput,lastCached)=>({type:'remotelab.context_metrics',inputTokens:lastInput,outputTokens:lastOutput,cachedInputTokens:lastCached,featureUsage:{threadId:'t1',inputTokens:input,outputTokens:output,cachedInputTokens:cached}});
  await appendRunSpoolRecord(r.runId,{ts:new Date(at).toISOString(),json:sample(1200,120,800,200,20,100)});
  await appendRunSpoolRecord(r.runId,{ts:new Date(at+100).toISOString(),json:sample(1600,160,1000,400,40,200)});
  await writeRunResult(r.runId,{completedAt:new Date(at+1000).toISOString(),exitCode:0});
  assert.deepEqual((await readKnowledgeRunMetrics(r.runId)).usage,{inputTokens:600,cachedInputTokens:300,outputTokens:60,source:'provider_run_counter_delta'});
  const report=await readKnowledgeObservations({nativeReceipt:async()=>true});
  assert.equal(report.admittedInputs,2);assert.equal(report.verification.inputs,1);
  assert.equal(report.totals.bodyReadCalls,2);assert.equal(report.totals.repeatedReads,1);
  assert.equal(report.totals.readInputs,1);assert.equal(report.totals.noReadInputs,1);
  assert.equal(report.totals.effects.helped,1);assert.equal(report.usage.inputTokens,600);
  assert.equal(report.usage.unknown,1);assert.equal(report.usage.incrementalTokens,null);
  await appendRunSpoolRecord(r.runId,{ts:new Date(at+200).toISOString(),json:sample(10,10,0,10,10,0)});
  assert.equal((await readKnowledgeRunMetrics(r.runId)).usage,null,'counter reset cannot become negative savings');
  const api=async(body,auth={authKind:'service'})=>{
    let status,reply;
    await handleKnowledgePilot({req:Object.assign(Readable.from([JSON.stringify(body)]),{method:'POST'}),res:{},pathname:'/api/knowledge-pilot',authSession:auth,writeJson:(_r,s,v)=>{status=s;reply=v;}});
    return {status,reply};
  };
  const body={runId:r.runId,requestId:r.requestId,action:'read',page:'01-loss.md',operationId:'api1'};
  assert.equal((await api(body,{authKind:'person',personId:'person_b'})).status,403);
  assert.equal((await api({...body,requestId:'not-in-session'})).status,403);
  assert.equal((await api(body)).status,200);
  let sent,output='';await runKnowledgeCommand(['read','--page','01-loss.md'],{requestId:'request1',runId:r.runId,stdout:{write:s=>output+=s},client:{request:async(path,options)=>{sent={path,...options};return {response:{ok:true},json:read};}}});
  assert.equal(sent.path,'/api/knowledge-pilot');assert.equal(sent.body.requestId,'request1');assert.equal(JSON.parse(output).sha256,read.sha256);
  // Group enrollment follows the authenticated input, never the Session or a
  // Person globally. These are synthetic groups/identities and a fixture corpus.
  const groups=['chat_discuss','chat_work'].map(chatId=>({sourceRouteId:'bot_test',tenantKey:'tenant_test',chatId}));
  const groupConfig={...config,id:'kb_groups',groups,helpedCitation:'experience-source'};
  await writeFile(join(root,'config.json'),JSON.stringify(groupConfig));
  const member={viewPersonId:'person_b',initiatedByIdentityId:'identity_b',feishuConnectorAuthenticated:true,
    sourceContext:{connector:'feishu',chatType:'group',...groups[0]}};
  const groupPolicy=await captureKnowledgePilot(member);
  assert.equal(groupPolicy.scope,'group');assert.deepEqual(groupPolicy.group,groups[0]);
  assert.equal((await captureKnowledgePilot({...member,sourceContext:{...member.sourceContext,...groups[1]}})).scope,'group');
  assert.equal((await captureKnowledgePilot({...member,viewPersonId:'person_c',initiatedByIdentityId:'identity_c'})).scope,'group');
  assert.equal((await captureKnowledgePilot(options)).scope,'person','existing personal opt-in remains enabled');
  for(const change of [{connector:'web'},{chatType:'p2p'},{chatId:'elsewhere'},{tenantKey:'another'},{sourceRouteId:'another'}])
    assert.equal(await captureKnowledgePilot({...member,sourceContext:{...member.sourceContext,...change}}),null);
  for(const change of [{feishuConnectorAuthenticated:false},{initiatedByIdentityId:null},{sourceContext:undefined},
    {internalOperation:'job'},{automationTitle:'job'},{scheduleId:'job'},{triggerId:'job'},{workReference:{}},{deliveryOnly:true},{recordUserMessage:false}])
    assert.equal(await captureKnowledgePilot({...member,...change}),null);
  assert.equal(await captureKnowledgePilot({...member,sourceContext:undefined},{conversation:{connector:'feishu',target:groups[0]}}),null);
  assert.equal(await captureKnowledgePilot(member,{groupFeed:true}),null);
  assert.equal(await captureKnowledgePilot(member,{internalRole:'worker'}),null);
  const groupPrompt=await buildPrompt('test-kb-group',{id:'test-kb-group',tool:'codex'},'查已有经验',null,'codex',null,
    {...member,knowledgePilot:groupPolicy,requestId:'group'},prepared);
  assert.match(groupPrompt,/范围不延伸至成员的其他群或私聊/);
  assert.match(groupPrompt,/参考组织 Wiki 中〈实际来源〉的经验/);
  assert.match(groupPrompt,/本次实际采用的要点.*真实作者或团队.*不代表已在当前任务中验证有效/s);
  assert.match(knowledgePilotPrompt(cited,'old'),/引用组织wiki/,'previous citation snapshots retain the old style');
  const groupRecord=(await requests.accept({sessionId:'test-kb-group',requestId:'group',text:'查已有经验',options:{...member,knowledgePilot:groupPolicy}})).record;
  await observeKnowledgeAdmission(groupRecord);
  const groupBody={runId:groupRecord.runId,requestId:groupRecord.requestId,action:'read',page:'01-loss.md',operationId:'group-read'};
  assert.equal((await api(groupBody,{authKind:'person',personId:'person_b'})).status,200,'group member can use the real API');
  assert.equal((await api({...groupBody,operationId:'wrong-reader'},{authKind:'person',personId:'person_c'})).status,403);
  const groupStats=await readKnowledgeObservations({lookup:async()=>null,meter:async()=>({usage:null}),nativeReceipt:async()=>false});
  assert.equal(groupStats.inputRecords[0].scope,'group');assert.deepEqual(groupStats.inputRecords[0].group,groups[0]);
  assert.equal(groupStats.totals.bodyReadCalls,1);
  const copied={...groupRecord,options:{...groupRecord.options,sourceContext:{...member.sourceContext,chatId:'elsewhere'}}};
  await assert.rejects(queryKnowledge(copied,{action:'read',page:'01-loss.md',operationId:'copied'}),/not enabled/);
  await writeFile(join(root,'config.json'),JSON.stringify({...groupConfig,personIds:[]}));
  assert.ok(await captureKnowledgePilot(member),'group-only enrollment is valid');
  assert.equal(await captureKnowledgePilot(options),null);
  await writeFile(join(root,'config.json'),JSON.stringify({...groupConfig,groups:[]}));
  assert.equal((await api({...groupBody,operationId:'removed-group'})).status,403,'removing group stops further reads');
  assert.ok(await captureKnowledgePilot(options),'removing groups preserves personal opt-in');
  await writeFile(join(root,'config.json'),JSON.stringify({...groupConfig,groups:[{chatId:'chat_discuss'}]}));
  assert.equal(await captureKnowledgePilot(member),null,'incomplete group identity fails closed');
  await writeFile(join(root,'config.json'),JSON.stringify({...config,enabled:false}));
  assert.equal(await captureKnowledgePilot(options),null);
  assert.equal((await api({...body,operationId:'disabled'})).status,403);
  console.log('PASS knowledge scope/default-off, actual page read/search, hash/Unicode counts, retry and duplicates, symlink escape, source evidence, verification exclusion, run counters/reset/unknown, API identity and CLI');
} finally {await rm(temp,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureGovernance } from '../scripts/memory-governance-capture.mjs';
import { collectGovernance } from '../scripts/memory-governance-collect.mjs';
import { runGovernanceSandbox } from '../scripts/memory-governance-sandbox.mjs';

const base = await mkdtemp(join(tmpdir(),'governance-collection-'));
const formal = join(base,'formal');
await mkdir(formal);
await writeFile(join(formal,'canary'),'original');
let namespaces = false;
try { if(process.platform === 'linux') { execFileSync('/usr/bin/unshare',['--user','--map-root-user','--net','true'],{stdio:'pipe'}); namespaces = true; } } catch {}
const project = {id:'alpha',title:'虚构项目'};
const source = join(base,'source.md');
const plan = () => ({schemaVersion:1,projects:[project],sources:[{id:'ledger',format:'markdown-blocks',projectIds:['alpha'],files:[source],blocks:[{id:'one',start:1,end:1,projectIds:['alpha']}],coverage:'one explicit block',cutoff:'2026-10-03T00:00:00Z'}]});

test('capture refuses byte budgets and conflicting original messages',async()=>{
  await writeFile(source,'hello');
  const p=plan();p.sources[0].blocks[0].end=100;
  await assert.rejects(captureGovernance(p),/range/);
  const a=join(base,'a.json'),b=join(base,'b.json');
  for(const [path,text] of [[a,'old'],[b,'new']]) await writeFile(path,JSON.stringify({messages:[{chat_id:'chat',message_id:'m',content:text}]}));
  await assert.rejects(captureGovernance({schemaVersion:1,projects:[project],sources:[{id:'group',format:'feishu-pages',projectIds:['alpha'],chatId:'chat',files:[a,b],coverage:'explicit'}]}),/Conflicting/);
  const big=join(base,'big');await writeFile(big,Buffer.alloc(40*1024*1024+1));
  const oversized=plan();oversized.sources[0].files=[big];await assert.rejects(captureGovernance(oversized),/budget/);
});

test('bounded streams and Session echoes retain lineage and do not invent acceptance',async()=>{
  const group=join(base,'group.json'),session=join(base,'session.json'),stream=join(base,'stream.jsonl');
  await writeFile(group,JSON.stringify({messages:[{chat_id:'chat',message_id:'m',content:'human original',sender:{sender_type:'user',name:'本人'}}]}));
  await writeFile(session,JSON.stringify({sessionId:'s',events:[{type:'message',role:'user',seq:1,content:'wrapper',sourceContext:{chatId:'chat',messageId:'m'}},{type:'message',role:'assistant',seq:2,content:'derived report'}]}));
  await writeFile(stream,JSON.stringify({allowed:true,summary:{chatId:'chat',messageId:'m',messageText:'short'}})+'\n');
  const doc=await captureGovernance({schemaVersion:1,projects:[project],sources:[
    {id:'group',format:'feishu-pages',chatId:'chat',projectIds:['alpha'],files:[group],coverage:'visible'},
    {id:'session',format:'session-events',projectIds:['alpha'],files:[session],coverage:'bounded'},
    {id:'stream',format:'jsonl-stream',chatProjects:{chat:['alpha']},projectIds:['alpha'],files:[stream],coverage:'snippet'},
  ]});
  assert.equal(doc.records.length,2);assert.equal(doc.records[1].kind,'agent-report');
  assert.equal(doc.sources[1].reusedOriginals,1);assert.equal(doc.sources[2].reusedOriginals,1);
});

test('namespace worker cannot read host files, mutate input/formal files, or reach active service', {skip:!namespaces},async()=>{
  const ws=join(base,'probe');await mkdir(join(ws,'input'),{recursive:true});await mkdir(join(ws,'output'));
  await writeFile(join(ws,'input','worker.mjs'),`
    import fs from 'node:fs/promises';import net from 'node:net';
    const denied=[];for(const [name,fn] of [
      ['formal-read',()=>fs.readFile(${JSON.stringify(join(formal,'canary'))})],
      ['formal-write',()=>fs.writeFile(${JSON.stringify(join(formal,'canary'))},'bad')],
      ['proc-root',()=>fs.readFile('/proc/1/root'+${JSON.stringify(join(formal,'canary'))})],
      ['input-write',()=>fs.writeFile('/input/worker.mjs','bad')],
      ['runtime-write',()=>fs.writeFile('/runtime/node','bad')]
    ]){try{await fn();throw Error('unexpected access '+name)}catch(e){if(String(e).includes('unexpected'))throw e;denied.push(name)}}
    const network=await new Promise((resolve,reject)=>{const s=net.connect(7696,'127.0.0.1');s.setTimeout(1000);s.on('connect',()=>{s.destroy();reject(Error('service reachable'))});s.on('error',e=>resolve(e.code));s.on('timeout',()=>{s.destroy();resolve('timeout')})});
    const status=await fs.readFile('/proc/self/status','utf8'),limits=await fs.readFile('/proc/self/limits','utf8');
    await fs.writeFile('/output/probe.json',JSON.stringify({denied,network,status,limits,env:process.env}));
    console.log(JSON.stringify({ok:true}));
  `);
  await runGovernanceSandbox({workspace:ws,protectedRoots:[formal]});
  const result=JSON.parse(await readFile(join(ws,'output/probe.json')));
  assert.equal(result.denied.length,5);assert.ok(['ECONNREFUSED','ENETUNREACH','timeout'].includes(result.network));
  assert.match(result.status,/Pid:\s+1\n/);assert.match(result.status,/CapEff:\s+0+\n/);assert.match(result.status,/CapBnd:\s+0+\n/);assert.match(result.status,/NoNewPrivs:\s+1/);
  assert.match(result.limits,/Max cpu time\s+30\s+30/);assert.match(result.limits,/Max address space\s+2147483648/);
  assert.equal(result.env.REMOTELAB_SESSION_ID,undefined);assert.equal(result.env.HOME,undefined);
  assert.equal(await readFile(join(formal,'canary'),'utf8'),'original');
});

test('collection replays without new version; edits advance once; stale revision and protected aliases fail closed',{skip:!namespaces},async()=>{
  const ws=join(base,'flow');await writeFile(source,'submitted, not accepted');
  const a=await collectGovernance({plan:plan(),workspace:ws,protectedRoots:[formal]});assert.equal(a.revision,1);
  const b=await collectGovernance({plan:plan(),workspace:ws,protectedRoots:[formal]});assert.equal(b.unchanged,true);
  await writeFile(source,'still running');
  const c=await collectGovernance({plan:plan(),workspace:ws,protectedRoots:[formal]});assert.equal(c.revision,2);
  const name=(await readFile(join(ws,'output/CURRENT'),'utf8')).trim();
  const state=JSON.parse(await readFile(join(ws,'output',name,'state.json')));
  assert.equal(state.entries[0].version,2);assert.equal(state.entries[0].confirmation,'pending');assert.equal(state.entries[0].businessState,'unclassified');assert.equal(state.humanAccepted,false);
  const d=await collectGovernance({plan:plan(),workspace:ws,protectedRoots:[formal]});assert.equal(d.unchanged,true);
  const stale=plan();stale.expectedRevision=1;
  await assert.rejects(collectGovernance({plan:stale,workspace:ws,protectedRoots:[formal]}),/Stale/);
  assert.equal((await readFile(join(ws,'output/CURRENT'),'utf8')).trim(),name);
  const alias=join(base,'alias');await symlink(formal,alias);
  await assert.rejects(collectGovernance({plan:plan(),workspace:alias,protectedRoots:[formal]}),/overlaps/);
  await mkdir(join(ws,'.capture-lock'));
  await assert.rejects(collectGovernance({plan:plan(),workspace:ws,protectedRoots:[formal]}),/EEXIST/);
  await rm(join(ws,'.capture-lock'),{recursive:true});
  const corrupt=join(base,'corrupt');await mkdir(join(corrupt,'input'),{recursive:true});await mkdir(join(corrupt,'output'));await writeFile(join(corrupt,'output/CURRENT'),'generation-7-deadbeef\n');
  await assert.rejects(collectGovernance({plan:plan(),workspace:corrupt,protectedRoots:[formal]}),/failed/);
  assert.equal(await readFile(join(corrupt,'output/CURRENT'),'utf8'),'generation-7-deadbeef\n');
  const competing=await Promise.allSettled([1,2].map(()=>collectGovernance({plan:plan(),workspace:join(base,'race'),protectedRoots:[formal]})));
  assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(competing.filter(r=>r.status==='rejected').length,1);
});

test.after(async()=>{await rm(base,{recursive:true,force:true});});

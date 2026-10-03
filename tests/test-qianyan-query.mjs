import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {query,rpc} from '../knowledge/qianyan.mjs';
import {handleQianyanRoutes} from '../chat/router-qianyan-routes.mjs';

const corpus={schema_version:1,meta:{corpus_revision:'test',coverage_cutoff:'2026-10-03'},limitations:['partial coverage'],history:[],changes:[],records:[
 {id:'classic',revision:'a',kind:'paper',title:'Diffusion Policy',summary:'基于动作扩散的策略',date:'2023-03-07',direction:'model',scope:'fulltext',evidence_status:'source_only',source:{url:'https://example.org/paper'},visibility:'public',search_text:'private full original action diffusion robot teleoperation'},
 {id:'tele',revision:'b',kind:'item',title:'DITTO-X：灵巧手遥操作',summary:'触觉反馈与接管',date:'2026-10-03',direction:'data',scope:'fulltext',evidence_status:'supported',source:{url:'https://example.org/tele'},visibility:'public',facts:[{citations:[{text:'exact quotation',start:10,end:25}],conditions:{setting:'real robot'}}]},
 {id:'secret',revision:'s',kind:'item',title:'Private personnel data',date:'2026-10-03',visibility:'private',search_text:'teleoperation'},
]};
corpus.history=[{...corpus.records[1],revision:'old',summary:'old statement'}];
corpus.changes=[{id:'tele',revision:'b',changed_at:'2026-10-03',change:'corrected'}];
assert.equal(query(corpus,'qianyan_search',{query:'扩散策略'}).results[0].id,'classic');
assert.equal(query(corpus,'qianyan_search',{query:'teleoperation'}).results.some(r=>r.id==='tele'),true);
assert.equal(query(corpus,'qianyan_search',{query:'teleoperation'}).results.some(r=>r.id==='secret'),false);
assert.throws(()=>query(corpus,'qianyan_read',{id:'secret'}),e=>e.status===404);
assert.equal(query(corpus,'qianyan_read',{id:'tele',revision:'old'}).is_current,false);
assert.throws(()=>query(corpus,'qianyan_read',{id:'tele',revision:'missing'}),e=>e.status===409);
assert.equal(query(corpus,'qianyan_read',{id:'classic'}).record.search_text,undefined);
assert.throws(()=>query(corpus,'qianyan_search',{query:'robot',scope:'private'}),e=>e.status===400);
assert.throws(()=>query(corpus,'qianyan_search',{query:'robot',limit:1000}),e=>e.status===400);
const pack=query(corpus,'qianyan_context',{question:'teleoperation',max_chars:2500});
assert(JSON.stringify(pack).length<=2500);assert(!JSON.stringify(pack).includes('private full original'));assert(pack.next_reads.length>0);
const page=query(corpus,'qianyan_search',{query:'teleoperation',limit:1});assert.equal(page.next_offset,1);
assert.equal(query(corpus,'qianyan_updates',{since:'2026-10-02'}).changes[0].change,'corrected');
assert.equal(rpc(corpus,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'qianyan_read',arguments:{id:'tele'}}}).result.structuredContent.record.id,'tele');
assert.equal(rpc(corpus,{jsonrpc:'2.0',method:'notifications/initialized'}),null);
assert.equal(rpc(corpus,{jsonrpc:'2.0',id:17,method:'bad'}).id,17);

const dir=await mkdtemp(join(tmpdir(),'qianyan-routes-'));const path=join(dir,'corpus.json');await writeFile(path,JSON.stringify(corpus));
const server=createServer(async(req,res)=>{
 const writeJson=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(!await handleQianyanRoutes({req,res,pathname:new URL(req.url,'http://localhost').pathname,writeJson,corpusPath:path})){res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/qianyan/v1/`;
try {
 let response=await fetch(base+'search?query=teleoperation');assert.equal(response.status,200);assert.equal((await response.json()).results.some(r=>r.id==='secret'),false);
 response=await fetch(base+'read?id=tele&revision=old');assert.equal((await response.json()).record.summary,'old statement');
 const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
 response=await fetch(base+'mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal((await response.json()).result.tools.length,4);
 response=await fetch(base+'mcp',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'});assert.equal(response.status,403);
 response=await fetch(base+'mcp',{method:'POST',headers:{...headers,Accept:'application/json'},body:'{}'});assert.equal(response.status,406);
 response=await fetch(base+'mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});assert.equal(response.status,202);assert.equal(await response.text(),'');
 response=await fetch(base+'mcp');assert.equal(response.status,405);
 response=await fetch(base+'read?id=missing');assert.equal(response.status,404);
 await rm(path);response=await fetch(base+'status');assert.equal(response.status,503);
 console.log('qianyan: archive/bilingual retrieval, visibility, exact versions, budget, pagination, privacy, MCP and HTTP passed');
}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}

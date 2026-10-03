import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { query, rpc, queryTools } from '../knowledge/qianyan.mjs';
import { readBody } from '../lib/utils.mjs';

export async function handleQianyanRoutes({req,res,pathname,writeJson,corpusPath}) {
  const prefix='/api/qianyan/v1/';if(!pathname.startsWith(prefix))return false;
  // This endpoint serves only the public projection, never runtime or internal material.
  const file=corpusPath||process.env.REMOTELAB_QIANYAN_CORPUS||join(homedir(),'.remotelab','workspace','qianyan-workbench','private','pipeline','agent_corpus.json');
  const action=pathname.slice(prefix.length),mcp=action==='mcp';
  const origin=req.headers.origin;
  if(origin) {
    const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
    let supplied;try{supplied=new URL(origin);}catch{writeJson(res,403,{error:'Invalid origin'});return true;}
    if(supplied.host!==host||!['http:','https:'].includes(supplied.protocol)){writeJson(res,403,{error:'Invalid origin'});return true;}
  }
  res.setHeader('Cache-Control','no-store');
  if(mcp&&req.method!=='POST'){writeJson(res,405,{error:'Use POST; this stateless MCP server has no SSE stream'});return true;}
  if(!mcp&&req.method!=='GET'){writeJson(res,405,{error:'Use GET'});return true;}
  try {
    const corpus=JSON.parse(await readFile(file,'utf8'));
    if(mcp) {
      if(!String(req.headers['content-type']).startsWith('application/json')){writeJson(res,415,{error:'Use application/json'});return true;}
      const accept=String(req.headers.accept||'');
      if(!accept.includes('application/json')||!accept.includes('text/event-stream')){writeJson(res,406,{error:'Accept application/json and text/event-stream'});return true;}
      const version=req.headers['mcp-protocol-version'];
      if(version&&!['2025-03-26','2025-06-18','2025-11-25'].includes(version)){writeJson(res,400,{error:'Unsupported MCP protocol version'});return true;}
      const message=JSON.parse(await readBody(req,16*1024));const result=rpc(corpus,message);
      if(result===null){res.writeHead(202);res.end();}else writeJson(res,200,result);
    } else if(action==='status')writeJson(res,200,{meta:corpus.meta,tools:queryTools,records:corpus.records.length,visibility:'public',limitations:corpus.limitations});
    else {
      const args=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
      writeJson(res,200,query(corpus,'qianyan_'+action,args));
    }
  } catch(e){writeJson(res,e.status|| (e instanceof SyntaxError?400:503),{error:e.status?e.message:'Research corpus unavailable'});}
  return true;
}

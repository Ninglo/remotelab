// Same-origin, authenticated presentation of the separately managed preview service.
import http from 'node:http';
import {evidenceConfig} from './monitoring-file-evidence.mjs';
import {readResolutionConfig} from './monitoring-resolution.mjs';
export function rewriteMonitoringPresentation(text,{prefix='/monitoring-preview',publicOrigin}={}){
 // A standalone '/' in JavaScript may be a date/path separator, not a URL.
 // Only the HTML home link and known presentation routes belong to this proxy.
 text=text.replace(/(\bhref\s*=\s*)(["'])\/\2/gi,(_,attribute,quote)=>attribute+quote+prefix+'/'+quote);
 text=text.replace(/(["'])\/(?=\?|api\/(?!monitoring-evidence|monitoring-resolution|auth\/|project-feedback)|app\.js|feature-trials\.js|group-participation\.js|style\.css)/g,'$1'+prefix+'/');
 if(publicOrigin)for(const quote of ['"',"'"])text=text.split(quote+publicOrigin+'/?').join(quote+prefix+'/?');
 return text.replace(/(["'])\/case-review\//g,'$1'+prefix+'/case-review/');
}
const caseAssets=new Set(['','index.html','project-adapter.js','workbench.js','review-model.js','case-catalog.json','session-bindings.json','agent-assessments.json','workbench.css','workbench-layout.css','feedback-layout.css','overview-layout.css','compact-layout.css','project-overview.js','overview-model.js','project-overview.json','project-feedback.json','feedback-review.js']);
export async function handleMonitoringPreview({req,res,pathname,configOverride}) {
 const prefix='/monitoring-preview';if(pathname!==prefix&&!pathname.startsWith(prefix+'/'))return false;
 const config=configOverride||await evidenceConfig(),port=config?.previewPort;
 const publicOrigin=(await readResolutionConfig())?.publicOrigin;
 if(!Number.isInteger(port)||port<1||port>65535){res.writeHead(404);res.end();return true}
 const path=pathname.slice(prefix.length)||'/';
 if(req.method!=='GET'||!(['/','/app.js','/feature-trials.js','/group-participation.js','/style.css','/api/snapshot','/api/reviews'].includes(path)||path.startsWith('/case-review/')&&caseAssets.has(path.slice('/case-review/'.length)))){res.writeHead(405);res.end();return true}
 const query=new URL(req.url,'http://local').search;
 await new Promise(resolve=>{
  const upstream=http.get({hostname:'127.0.0.1',port,path:path+query,timeout:12000},response=>{
   let bytes=0;const chunks=[];response.on('data',chunk=>{bytes+=chunk.length;if(bytes>20*1024*1024){upstream.destroy();return}chunks.push(chunk)});
   response.on('end',()=>{
    let body=Buffer.concat(chunks);const type=response.headers['content-type']||'application/octet-stream';
    if(/html|javascript/.test(type)){
     body=Buffer.from(rewriteMonitoringPresentation(body.toString(),{prefix,publicOrigin}));
    }
    res.writeHead(response.statusCode||502,{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);resolve();
   });
  });upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();resolve()});res.on('close',()=>upstream.destroy());
 });return true;
}

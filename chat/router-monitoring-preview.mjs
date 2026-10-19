// Same-origin, authenticated presentation of the separately managed preview service.
import http from 'node:http';
import {evidenceConfig} from './monitoring-file-evidence.mjs';
export async function handleMonitoringPreview({req,res,pathname,configOverride}) {
 const prefix='/monitoring-preview';if(pathname!==prefix&&!pathname.startsWith(prefix+'/'))return false;
 const config=configOverride||await evidenceConfig(),port=config?.previewPort;
 if(!Number.isInteger(port)||port<1||port>65535){res.writeHead(404);res.end();return true}
 const path=pathname.slice(prefix.length)||'/';
 if(req.method!=='GET'||!['/','/app.js','/style.css','/api/snapshot','/api/reviews'].includes(path)){res.writeHead(405);res.end();return true}
 const query=new URL(req.url,'http://local').search;
 await new Promise(resolve=>{
  const upstream=http.get({hostname:'127.0.0.1',port,path:path+query,timeout:12000},response=>{
   let bytes=0;const chunks=[];response.on('data',chunk=>{bytes+=chunk.length;if(bytes>20*1024*1024){upstream.destroy();return}chunks.push(chunk)});
   response.on('end',()=>{
    let body=Buffer.concat(chunks);const type=response.headers['content-type']||'application/octet-stream';
    if(/html|javascript/.test(type))body=Buffer.from(body.toString().replace(/(["'])\/(?=\?|api\/(?!monitoring-evidence)|app\.js|style\.css)/g,'$1'+prefix+'/'));
    res.writeHead(response.statusCode||502,{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);resolve();
   });
  });upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();resolve()});res.on('close',()=>upstream.destroy());
 });return true;
}

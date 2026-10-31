import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const root = await mkdtemp(join(tmpdir(), 'site-login-migration-'));
setIsolatedTestHome(root); process.env.REMOTELAB_CONFIG_DIR = root;
const { handlePreviewProxy } = await import('../chat/preview-proxy.mjs');
const { legacySiteLogin } = await import('../lib/legacy-site-login.mjs');
const { previewUpstreamAuthorized } = await import('../lib/preview-upstream-auth.mjs');
const { runPreviewCommand } = await import('../lib/preview-command.mjs');
const { updateAuthDocument } = await import('../lib/auth-config.mjs');
await writeFile(join(root, 'site-login.json'), JSON.stringify({ realm: 'fixture', tenantKey: 'fixture', feishuConfigPath: join(root, 'unused.json') }));
await updateAuthDocument(d => d.people.push(...['a','b'].map(x => ({ id: 'person_'+x, name:x, credentials:[], identities:[{id:'identity_'+x,kind:'feishu',realm:'fixture',subjectId:'open_'+x}] }))));
const hash = v => createHash('sha256').update(v).digest('hex');
await writeFile(join(root, 'qianyan-identity.json'), JSON.stringify({ pending:{},sessions:Object.fromEntries(['a','b'].map(x=>[hash('cookie_'+x),{personId:'person_'+x,openId:'open_'+x,realm:'fixture',tenantKey:'fixture',expiresAt:Date.now()+86400000}])) }));
let valid = 'Basic '+Buffer.from('site:fixture-secret').toString('base64');
const upstream = http.createServer(async (req,res) => {
 if(req.headers.authorization!==valid && !await previewUpstreamAuthorized(req)) {res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});res.end('legacy login');return;}
 if(req.headers.range){res.writeHead(206,{'Content-Range':'bytes 2-4/10','Accept-Ranges':'bytes','Content-Type':'video/mp4'});res.end('234');return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({person:req.headers['x-remotelab-person-id'],cookie:req.headers.cookie||null}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const port=upstream.address().port;
const routes={old:{port,postPaths:['/save'],requestHeaders:['x-fixture']}};
await writeFile(join(root,'preview-routes.json'),JSON.stringify(routes));
const server=http.createServer(async(req,res)=>{try{if(!await handlePreviewProxy(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const request=(headers={},path='',options={})=>fetch(base+'/preview/old/'+path,{headers,redirect:'manual',...options});
try {
 const file=join(root,'binding.json');await writeFile(file,JSON.stringify({authorization:valid,personIds:['person_a']}));
 await runPreviewCommand(['migrate-login','--slug','old','--credential-file',file]);
 assert.deepEqual(JSON.parse(await readFile(join(root,'preview-routes.json'))),routes,'original route and operations remain intact');
 const anonymous=await request({Accept:'text/html'});assert.equal(anonymous.status,302);assert.match(anonymous.headers.get('location'),/^\/site-login/);assert.equal(anonymous.headers.get('www-authenticate'),null);
 assert.equal((await request()).status,401,'data requests remain protected');
 let r=await request({Cookie:'employee_site_session=cookie_a'});assert.equal(r.status,200,'first verified visit needs no previous password login');assert.deepEqual(await r.json(),{person:'person_a',cookie:null});
 r=await request({Cookie:'employee_site_session=cookie_b'});assert.equal(r.status,403);assert.equal(r.headers.get('www-authenticate'),null,'personal restrictions do not become a password dialog');
 assert.equal((await request({Authorization:valid})).status,200,'original authenticated callers continue without an employee cookie');
 assert.equal((await request({'X-Remotelab-Person-Id':'person_a'})).status,401);
 assert.equal((await request({Cookie:'employee_site_session=cookie_a',Origin:'https://evil.test'},'save',{method:'POST'})).status,403);
 assert.equal((await request({Cookie:'employee_site_session=cookie_a',Origin:base},'save',{method:'POST'})).status,200);
 r=await request({Cookie:'employee_site_session=cookie_a',Range:'bytes=2-4'},'video.mp4');assert.equal(r.status,206);assert.equal(await r.text(),'234');
 valid='Basic rotated';r=await request({Cookie:'employee_site_session=cookie_a'});assert.equal(r.status,503);assert.equal(r.headers.get('www-authenticate'),null,'expired mapping never reintroduces a password popup');
 await writeFile(file,JSON.stringify({authorization:valid,employees:true}));await runPreviewCommand(['migrate-login','--slug','old','--credential-file',file]);
 assert.equal((await request({Cookie:'employee_site_session=cookie_b'})).status,200,'explicit shared employee scope admits a second employee');
 const token='Bearer fixture-scoped-source-key';await legacySiteLogin.bindSite('old',port,{authorization:token,employees:true,upstreamToken:true});
 assert.equal(await previewUpstreamAuthorized({headers:{authorization:token},socket:{localPort:port+1}}),false,'token cannot reach another service');
 assert.equal(await previewUpstreamAuthorized({headers:{authorization:'Bearer forged'},socket:{localPort:port}}),false);
 assert.equal((await request({Cookie:'employee_site_session=cookie_a'})).status,200,'hash-only upstream adapter accepts its independent scoped capability');
 assert.equal((await request({Authorization:'Basic invalid'})).status,401,'explicit legacy failures remain failures');
 await assert.rejects(runPreviewCommand(['expose','--slug','new-basic','--port',String(port),'--access','basic','--owner','person_a']),/must use employee login/);
 for(const [slug,fn] of [
  ['get-password',(req,res)=>{if(req.method==='HEAD')res.end();else{res.writeHead(401,{'WWW-Authenticate':'Basic realm="hidden"'});res.end();}}],
  ['login-form',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<form><input type="password"></form>');}],
  ['login-redirect',(_req,res)=>{res.writeHead(302,{Location:'/login'});res.end();}]
 ]) {
  const hidden=http.createServer(fn);await new Promise(r=>hidden.listen(0,'127.0.0.1',r));
  try{await assert.rejects(runPreviewCommand(['expose','--slug',slug,'--port',String(hidden.address().port),'--owner','person_a']),/without a second login/);}finally{await new Promise(r=>hidden.close(r));}
 }
 console.log('Site login migration PASS: first-visit SSO, original-person/shared scope, legacy calls, forged identity, CSRF, video range, rotation, port-pinned adapter and new-site GET/login-form checks');
} finally {await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);await rm(root,{recursive:true,force:true});}

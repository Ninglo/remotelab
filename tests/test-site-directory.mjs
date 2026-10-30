import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const root = await mkdtemp(join(tmpdir(), 'site-directory-')); setIsolatedTestHome(root);
process.env.REMOTELAB_CONFIG_DIR=root;process.env.REMOTELAB_PUBLIC_PAGES_DIR=join(root,'pages');
process.env.REMOTELAB_PUBLIC_BASE_URL='https://fixture.test';
const { createSiteDirectory, recordSiteOrigin }=await import('../lib/site-directory.mjs');
const { createSiteDirectoryHandler }=await import('../chat/router-site-directory.mjs');
const { publishStaticSource }=await import('../lib/static-publish-command.mjs');
const people=[{id:'person_fixture_owner',name:'原创建人'}],actor={id:'person_fixture_editor',name:'登记员工'};
await mkdir(join(root,'source'),{recursive:true});await writeFile(join(root,'source','index.html'),'<title>真实来源测试 &amp; 网站</title>');
const published=await publishStaticSource({source:join(root,'source'),slug:'one',access:'public',verify:false});
const metadataPath=join(root,'pages','one','_remote_publish.json');
const metadata=JSON.parse(await readFile(metadataPath,'utf8'));metadata.ownerPersonId=people[0].id;await writeFile(metadataPath,JSON.stringify(metadata));
await mkdir(join(root,'pages','legacy'));await writeFile(join(root,'pages','legacy','index.html'),'<title>旧站点</title>');
await writeFile(join(root,'preview-routes.json'),JSON.stringify({dynamic:{port:12345}}));
const options={configDir:root,pagesDir:join(root,'pages'),baseUrl:'https://fixture.test',people:async()=>people};
let directory=createSiteDirectory(options), result=await directory.listing();
assert.equal(result.totals.all,3);assert.equal(result.entries.find(e=>e.id==='static:one').title,'真实来源测试 & 网站');
assert.equal(result.entries.find(e=>e.id==='static:one').origin.sourcePath,join(root,'source'),'publish records private provenance automatically');
assert.equal((await readFile(metadataPath,'utf8')).includes(join(root,'source')),false,'source path never enters publicly served metadata');
assert.equal(result.entries.find(e=>e.id==='static:legacy').metadataMissing,true);
assert.equal(result.entries.find(e=>e.id==='preview:dynamic').access,'basic');
await directory.save({id:'static:one',revision:0,values:{project:'测试项目',contact:'维护同事',status:'active'}},actor);
await assert.rejects(directory.save({id:'static:one',revision:0,values:{project:'过期修改'}},actor),e=>e.status===409);
await assert.rejects(directory.save({id:'static:one',revision:1,values:{ownerPersonId:actor.id}},actor),e=>e.status===400);
const saved=await directory.save({revision:0,values:{title:'外部网站',url:'https://external.test/app',project:'测试项目',status:'planned'}},actor);
await assert.rejects(directory.save({revision:0,values:{title:'重复',url:'https://external.test/app'}},actor),e=>e.status===409);
await assert.rejects(directory.save({revision:0,values:{title:'坏链接',url:'javascript:alert(1)'}},actor),e=>e.status===400);
await assert.rejects(directory.save({revision:0,values:{title:'凭据',url:'https://user:password@example.test/'}},actor),e=>e.status===400);
await assert.rejects(directory.save({revision:0,values:{title:'令牌',url:'https://example.test/?access_token=secret'}},actor),e=>e.status===400);
directory=createSiteDirectory(options);result=await directory.listing();
const one=result.entries.find(e=>e.id==='static:one');assert.equal(one.project,'测试项目');assert.equal(one.ownerPersonId,people[0].id);assert.equal(one.access,'public');
assert.equal(result.entries.find(e=>e.id===saved.id).ownerPersonId,actor.id);
assert.equal((await stat(join(root,'site-directory.json'))).mode & 0o777,0o600);
assert.equal(JSON.parse(await readFile(join(root,'site-directory.json'),'utf8')).history.length,2);
await mkdir(join(root,'pages','later'));await writeFile(join(root,'pages','later','index.html'),'<title>新发布自动出现</title>');
assert.equal((await directory.listing()).totals.all,5);
const before=await readFile(metadataPath,'utf8');
const handler=createSiteDirectoryHandler({directory,authorize:async(req,res)=>{
  if(req.headers.cookie==='fixture=yes')return actor;
  res.writeHead(401);res.end();return null;
}});
const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
try{
 for(const path of ['/sites','/sites/app.js','/api/sites','/api/sites/export'])assert.equal((await fetch(base+path)).status,401);
 const auth={Cookie:'fixture=yes'};
 const response=await fetch(base+'/api/sites/export',{headers:auth});assert.match(response.headers.get('content-disposition'),/attachment/);
 assert.equal((await response.json()).totals.all,5);
 assert.equal((await fetch(base+'/api/sites/entries',{method:'PATCH',headers:{...auth,Origin:'https://evil.test'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/sites/entries',{method:'DELETE',headers:auth})).status,405);
 if(process.env.SITE_TEST_PLAYWRIGHT){
  const {chromium}=await import(pathToFileURL(process.env.SITE_TEST_PLAYWRIGHT));
  const browser=await chromium.launch({executablePath:process.env.SITE_TEST_CHROME,headless:true,args:['--no-sandbox']});
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'fixture',value:'yes',domain:'127.0.0.1',path:'/'}]);
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/sites');await page.locator('#total').filter({hasText:'5'}).waitFor();
   await page.locator('#search').fill('真实来源');assert.equal(await page.locator('#rows tr').count(),1);
   await page.locator('#rows button').click();await page.locator('[name=notes]').fill('浏览器保存的迁移备注');await page.locator('#save').click();await page.locator('#editor').waitFor({state:'hidden'});
   assert.equal((await directory.listing()).entries.find(e=>e.id==='static:one').notes,'浏览器保存的迁移备注');
   await page.locator('#register').click();await page.locator('[name=title]').fill('<img src=x onerror=alert(1)>');await page.locator('[name=url]').fill('https://another.test/');await page.locator('#save').click();await page.locator('#editor').waitFor({state:'hidden'});
   await page.locator('#search').fill('onerror');assert.equal(await page.locator('#rows img').count(),0);assert.equal(await page.locator('#rows tr').count(),1);
   await page.locator('#search').fill('');await page.setViewportSize({width:390,height:844});
   const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body > *, main > *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width])}));
   assert.equal(layout.scroll<=layout.width,true,JSON.stringify(layout));
   await page.locator('#register').click();assert.equal(await page.evaluate(()=>document.querySelector('dialog').getBoundingClientRect().right<=innerWidth),true);
   await page.locator('#cancel').click();assert.deepEqual(errors,[]);
   console.log('Browser PASS: search, edit persistence, external registration, XSS escaping, mobile table and form. Isolated fixture login.');
  }finally{await browser.close();}
 }
 assert.equal(await readFile(metadataPath,'utf8'),before,'registry edits never mutate original site policy or metadata');
 console.log('Project sites PASS: automatic inventory, private provenance, legacy metadata, immutable creator/access, manual registration, deduplication, concurrent edit conflict, durable history, safe URLs, employee boundary and export.');
}finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}

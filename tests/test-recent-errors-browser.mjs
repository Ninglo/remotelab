// node scripts/run-with-clean-instance-env.mjs node tests/test-recent-errors-browser.mjs <playwright module> [chromium executable]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const { chromium } = await import(pathToFileURL(resolve(process.argv[2])).href);
const home = await mkdtemp(join(tmpdir(), 'recent-error-browser-'));
setIsolatedTestHome(home);
const config = join(home, 'fixture-config'); await mkdir(config);
process.env.REMOTELAB_CONFIG_DIR = config;
const { recentErrors } = await import('../lib/recent-errors.mjs');
const json = (path, value) => writeFile(join(config,path), JSON.stringify(value));
await json('auth.json',{token:'fixture-token'});
await json('auth-sessions.json',{fixture:{role:'owner',expiry:Date.now()+3600000}});
await json('recent-errors.json',{enabled:true});
const upstream = createServer((req,res) => {
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end('<html><head><title>Monitor fixture</title></head><body><main><nav id="tabs"><a data-tab="overview" aria-current="page">总览</a></nav><div id="content">Report</div></main></body></html>');
});
upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
await json('monitoring-evidence.json',{previewPort:upstream.address().port});
for (const operation of ['a','b','c']) await recentErrors.record('source-delivery',{operation,error:'ETIMEDOUT request run_51a14f00d00f00de'});
await recentErrors.record('feishu-inbox',{operation:'other',error:'Unknown failure'});
const reservation = createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
const port = reservation.address().port; await new Promise(r=>reservation.close(r));
const base=`http://127.0.0.1:${port}`, api=base+'/api/monitoring/recent-errors';
const logs=[];
const child=spawn(process.execPath,['chat-server.mjs'],{env:{...process.env,CHAT_PORT:String(port),SECURE_COOKIES:'0'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data', data=>logs.push(String(data))); child.stderr.on('data', data=>logs.push(String(data)));
let browser;
try {
  await new Promise((r,j)=>{ const timer=setTimeout(()=>j(Error(logs.join(''))),16000); child.stdout.on('data',()=>{ if(logs.join('').includes('Chat server listening')){clearTimeout(timer);r();} }); child.once('exit',()=>{clearTimeout(timer);j(Error(logs.join('')));}); });
  const denied=await fetch(api,{redirect:'manual'}); assert([302,401,403].includes(denied.status));
  const cross = await fetch(api+'/repair',{method:'POST',headers:{cookie:'session_token=fixture','sec-fetch-site':'cross-site','content-type':'application/json'},body:'{}'});
  assert.equal(cross.status,403);
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.argv[3]});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addCookies([{name:'session_token',value:'fixture',url:base}]);
  const page=await context.newPage();
  const proxy=await page.goto(base+'/monitoring-preview/?tab=overview');
  assert.equal(proxy.status(),200);
  const box=page.locator('#monitorRecentErrors');
  await box.getByText('网络连接超时').waitFor();
  await box.getByText('未分类报错').waitFor();
  assert.match(await box.innerText(), /1 类待修/);
  await box.locator('small[data-state="pending"]').waitFor({ timeout: 5000 });
  await box.getByText('网络连接超时').click();
  await box.locator('.recent-error-cluster[open] li').first().waitFor();
  assert.equal(await box.locator('.recent-error-cluster[open] li').count(), 3);
  await box.getByLabel('修复提交（完整 SHA）').fill('b'.repeat(40));
  await box.getByLabel('验证结果', {exact:false}).fill('复验：fixture 连接成功 <b>literal</b>');
  await box.getByRole('button',{name:'登记验证并标为已修'}).click();
  await box.getByText('已修',{exact:true}).waitFor();
  await box.getByText(/literal/).waitFor(); assert.equal(await box.locator('b').count(), 0);
  await page.evaluate(()=>{ const a=document.querySelector('#tabs a');a.dataset.tab='usage';a.setAttribute('aria-current','page'); });
  // The upstream switches aria-current and rebuilds tabs on client-side navigation.
  await page.evaluate(()=>{ const a=document.querySelector('#tabs a');a.replaceWith(a.cloneNode(true)); });
  await box.waitFor({state:'hidden'});
  await page.goto(base+'/?tab=tasks&monitor=overview');
  await page.locator('#monitorRecentErrors').getByText('已修',{exact:true}).waitFor();
  console.log('recent errors browser: actual protected preview, compact layout, details, repair, origin policy and local overview passed');
} finally {
  if (browser) await browser.close();
  if (child.exitCode===null && child.kill('SIGTERM')) await once(child,'exit');
  await new Promise(r=>upstream.close(r));
  await rm(home,{force:true,recursive:true});
}

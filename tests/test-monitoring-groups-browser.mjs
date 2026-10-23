// Browser verification against a prepared copy of the instance-owned site and a real source snapshot.
// Args: playwright-module browser-executable prepared-site evidence-directory
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [modulePath, executablePath, site, out] = process.argv.slice(2).map(p=>resolve(p));
const { chromium } = await import(pathToFileURL(modulePath));
const { createApp } = await import(pathToFileURL(join(site,'server.mjs')));
const snapshot=JSON.parse(await readFile(join(site,'data/snapshot.json'),'utf8'));
const expected=snapshot.sections.speed.dashboard;
const server=createApp({root:site,dataDir:join(site,'data'),ipReportFile:join(site,'absent.json')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});
const errors=[],requests=[];
await mkdir(out,{recursive:true});
try {
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>requests.push({method:r.method(),path:new URL(r.url()).pathname}));
  await page.goto(origin+'/?tab=speed');
  await page.getByRole('heading',{name:'普通会话响应性能',exact:true}).waitFor();
  assert.equal(await page.locator('[data-testid="group-participation"]').count(),1);
  const text=await page.locator('[data-testid="group-participation"]').innerText();
  assert(text.includes(expected.groupParticipation.today.received.toLocaleString('zh-CN')));
  assert(text.includes('当前主动参与群'));assert(text.includes('社交表情'));assert(text.includes('追加输入')===false);
  await page.locator('[data-agent-fold="group-days"] summary').click();
  assert.equal(await page.locator('[data-agent-fold="group-days"] tbody tr').count(),7);
  await page.getByRole('button',{name:'刷新数据',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-agent-fold="group-days"]')?.open===true);
  const layouts=[];
  for (const width of [1440,390,320]) {
    await page.setViewportSize({width,height:1000});
    const sizes=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
    assert(sizes.scrollWidth<=width+1,JSON.stringify(sizes));
    await page.screenshot({path:join(out,'group-partition-'+width+'.png'),fullPage:true});layouts.push(sizes);
  }
  const offline=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
  const ssr=await offline.newPage();await ssr.goto(origin+'/?tab=speed');
  assert((await ssr.locator('body').innerText()).includes('普通会话响应性能'));
  assert((await ssr.locator('body').innerText()).includes('群主线参与'));
  const native=await browser.newPage({viewport:{width:390,height:844}});
  native.on('pageerror',e=>errors.push(e.message));
  await native.setContent('<div id="native"></div>');
  await native.addStyleTag({content:await readFile(new URL('../static/chat/agent-monitor-dashboard.css',import.meta.url),'utf8')});
  await native.addScriptTag({content:await readFile(new URL('../static/chat/agent-monitor-dashboard.js',import.meta.url),'utf8')});
  await native.evaluate(data=>{window.data=data;window.state={};RemoteLabAgentDashboard.render(document.querySelector('#native'),data,{state});},expected);
  assert.equal(await native.getByRole('heading',{name:'普通会话首次响应时间',exact:true}).count(),1);
  await native.locator('[data-agent-fold="group-days"] summary').click();
  await native.waitForFunction(()=>window.state['group-days']===true);
  await native.evaluate(()=>RemoteLabAgentDashboard.render(document.querySelector('#native'),data,{state}));
  assert.equal(await native.locator('[data-agent-fold="group-days"]').evaluate(el=>el.open),true);
  assert.equal(await native.locator('[data-testid="group-participation"]').count(),1);
  await native.evaluate(()=>{const legacy={...data,responseScope:undefined,groupParticipation:undefined};RemoteLabAgentDashboard.render(document.querySelector('#native'),legacy,{state});});
  assert.equal(await native.getByRole('heading',{name:'平均首次响应时间',exact:true}).count(),1);
  await native.close();
  await offline.close();assert.deepEqual(errors,[]);assert(requests.every(r=>['GET','HEAD'].includes(r.method)));
  const receipt={at:new Date().toISOString(),sourceGeneratedAt:expected.generatedAt,checks:['real snapshot values','ordinary/group sections','seven-day detail','refresh preserves disclosure','1440/390/320 no overflow','SSR without JavaScript','native renderer and disclosure state','legacy snapshot retains legacy labels','no writes'],layouts,errors,requests};
  await writeFile(join(out,'browser.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
} finally {await browser.close();await new Promise(r=>server.close(r));}

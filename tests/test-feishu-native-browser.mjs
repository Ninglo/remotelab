import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [modulePath,executablePath,runtimePath,out]=process.argv.slice(2);const {chromium}=await import(pathToFileURL(modulePath));
const runtime=(await fs.readFile(runtimePath,'utf8')).replace('__CAPABILITY__',JSON.stringify('fixture-capability'));
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:448,height:849}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message)});page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text())});
await page.route('https://fixture.feishu.cn/messenger/messenger/zh-CN.html',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{margin:0}#app{height:100vh}.feed-main-list{width:100%}</style><div id="app"><div class="feed-main-list"><div data-feed-id="1000000000000000011"><div class="a11y_feed_card_main"><span class="_9f5c521">现有话题</span><div class="_97ba617">原有摘要</div></div></div></div><div contenteditable="true">尚未发送的草稿</div></div>'}));
await page.goto('https://fixture.feishu.cn/messenger/messenger/zh-CN.html');
await page.evaluate(()=>{
 const account='1000000000000000001';globalThis.ShellAPI={app:{passport:{getAuthInfo:async()=>({userId:account})}}};
 globalThis.fixture={prefs:{enabled:true,usageEnabled:false,theme:'sky',font:'system-ui',bodyFont:'inherit',readingEnabled:false,size:18,line:1.8,width:840,density:'normal',layout:'native',expand:false,aliases:{},petEnabled:false,petKind:'boocha',petMotion:'gentle',petSize:90,petX:.96,petY:.12,sortMode:'native',pins:[]},storage:{},calls:[],state:null};
 const f=fixture,enc=new TextEncoder();let controller;f.emit=(type,value)=>controller.enqueue(enc.encode(JSON.stringify({type,value})+'\n'));
 globalThis.fetch=async(url,opts={})=>{const path=new URL(url,location.href).pathname,b=opts.body?JSON.parse(opts.body):{};f.calls.push({path,body:b});let d={ok:true};
 if(path==='/events')return new Response(new ReadableStream({start(c){controller=c;}}));
 if(path==='/initial')d={settings:f.prefs,topics:{sourceConnected:false,entries:[]}};
 else if(path==='/save'){f.prefs=b.value;}
 else if(path==='/state')f.state=b;
 else if(path==='/storage/get')d={[b.key]:f.storage[b.key]||null};
 else if(path==='/storage/set'){Object.assign(f.storage,b.values);f.emit('storage',Object.fromEntries(Object.entries(b.values).map(([k,v])=>[k,{newValue:v}])));}
 else if(path==='/verification')f.verification=b;
 return new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json'}});};
});
try{
 await page.addScriptTag({content:runtime});
 await page.waitForFunction(()=>globalThis.__RLFE_WORKSPACE__&&globalThis.__RLFE_SETTINGS_STATUS__?.().saved);
 assert.equal(await page.locator('#rlfe-resource-nav-host a').count(),2);
 assert.equal(await page.locator('#rlfe-personal-nav button').count(),2);
 if(await page.locator('#rlfe-host #firstUseLater').count())await page.locator('#rlfe-host #firstUseLater').click();
 await page.locator('#rlfe-host #launcher').click();
 const panel=await page.locator('#rlfe-host #panel').boundingBox();assert(panel.x>=0&&panel.x+panel.width<=448&&panel.y+panel.height<=849);
 await page.locator('#rlfe-host [data-theme="mist"]').click();assert.equal(await page.evaluate(()=>fixture.prefs.theme),'sky');
 await page.locator('#rlfe-host #close').click();assert.equal(await page.evaluate(()=>__RLFE_SETTINGS_STATUS__().current.theme),'sky');
 await page.locator('#rlfe-host #launcher').click();await page.locator('#rlfe-host [data-theme="mist"]').click();await page.locator('#rlfe-host #apply').click();await page.waitForFunction(()=>fixture.prefs.theme==='mist');
 await page.locator('#rlfe-personal-nav button').first().click();assert.equal(await page.evaluate(()=>__RLFE_WORKSPACE__.status().visible),true);await page.keyboard.press('Escape');
 await page.locator('#rlfe-personal-nav button').nth(1).click();assert.equal(await page.evaluate(()=>__RLFE_WORKSPACE__.status().surface),'thinking');await page.keyboard.press('Escape');
 await page.evaluate(()=>__RLFE_SET_TOPICS__({sourceConnected:true,entries:[{webThreadId:'1000000000000000011',sessionId:'a'.repeat(32),name:'真实工作标题',summary:'核对状态',status:'running'}]}));
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-name')?.textContent==='真实工作标题');
 assert.equal(await page.locator('.rlfe-feed-status').textContent(),'running');
 await page.evaluate(()=>__RLFE_SET_TOPICS__({sourceConnected:false,entries:[{webThreadId:'1000000000000000011',name:'真实工作标题',summary:'核对状态',status:'running'}]}));
 assert.equal(await page.locator('.rlfe-feed-status').textContent(),'未同步');assert.equal(await page.locator('[contenteditable=true]').textContent(),'尚未发送的草稿');
 assert.deepEqual(errors,[]);await fs.mkdir(out,{recursive:true});await page.screenshot({path:out+'/native-1.2-browser.png'});await fs.writeFile(out+'/native-browser-verification.json',JSON.stringify({navigation:true,settingsPreviewAndSave:true,indexAndThinkingOpen:true,topicStateAndDisconnect:true,editorPreserved:true,errors},null,2));console.log('Native browser component checks passed');
}finally{await browser.close();}

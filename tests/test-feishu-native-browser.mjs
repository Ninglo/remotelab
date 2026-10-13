import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [modulePath,executablePath,runtimePath,out]=process.argv.slice(2);const {chromium}=await import(pathToFileURL(modulePath));
const runtime=(await fs.readFile(runtimePath,'utf8')).replace('__CAPABILITY__',JSON.stringify('fixture-capability'));
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:448,height:849}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message)});page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text())});
await page.route('https://fixture.feishu.cn/messenger/messenger/zh-CN.html',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><style>body{margin:0}#app{height:100vh;position:absolute;inset:0;display:flex}.a11y_feed_filter_list{width:clamp(72px,25vw,160px);height:100%;flex:none;display:flex;flex-direction:column}.native-groups-scroll{flex:1;min-height:0;overflow:auto}.message-pane{flex:1;min-width:0}.feed-main-list{width:100%;height:440px;overflow:auto}.a11y_feed_card_main{min-width:0;flex:1}.card{display:flex;padding:12px;gap:8px;height:56px}.avatar{width:36px;flex:none}.title-row,.detail-row{display:flex;min-width:0;gap:8px;height:24px}.title-slot{display:grid;grid-template-columns:1fr max-content minmax(0,auto);min-width:0;flex:1}._9f5c521{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.digest-slot{display:flex;min-width:0;flex:1;overflow:hidden}.native-digest{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.native-time,.native-action{flex:none}.app-heading{height:46px;padding:8px;box-sizing:border-box;font:18px system-ui}</style><div id="app"><div class="a11y_feed_filter_list"><div class="native-groups-scroll"><div class="a11y_feed_filter_list_item">全部消息</div><div class="a11y_feed_filter_list_item">工作分组</div></div></div><div class="message-pane"><div class="app-heading">消息</div><div class="feed-main-list"><div class="card" data-feed-id="1000000000000000011"><div class="avatar">头像</div><div class="a11y_feed_card_main"><div class="title-row"><div class="title-slot"><span class="_9f5c521">现有话题</span></div><span class="native-time">23:31</span></div><div class="detail-row"><div class="digest-slot"><div class="native-digest">原有摘要</div></div><button class="native-action">完成</button></div></div></div></div><div contenteditable="true">尚未发送的草稿</div></div></div>`}));
await page.goto('https://fixture.feishu.cn/messenger/messenger/zh-CN.html');
await page.evaluate(()=>{
 const account='1000000000000000001';globalThis.ShellAPI={app:{passport:{getAuthInfo:async()=>({userId:account})}}};
 globalThis.fixture={prefs:{enabled:true,usageEnabled:false,theme:'sky',font:'system-ui',bodyFont:'inherit',readingEnabled:false,size:18,line:1.8,width:840,density:'normal',layout:'native',expand:false,aliases:{},petEnabled:false,petKind:'boocha',petMotion:'gentle',petSize:90,petX:.96,petY:.12,sortMode:'native',pins:[]},storage:{},calls:[],state:null};
 const f=fixture,enc=new TextEncoder();let controller;f.closeStream=()=>controller.close();f.emit=(type,value)=>controller.enqueue(enc.encode(JSON.stringify({type,value})+'\n'));
 globalThis.fetch=async(url,opts={})=>{const path=new URL(url,location.href).pathname,b=opts.body?JSON.parse(opts.body):{};f.calls.push({path,body:b});let d={ok:true};
 if(path==='/events'){f.connections=(f.connections||0)+1;}
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
 await page.locator('#rlfe-native-settings').click();
 await page.locator('#rlfe-host #connectTopics').click();
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.path==='/connect').at(-1)?.body.kind),'topics');
 assert.equal(await page.locator('#rlfe-native-rail').count(),0);
 for(const width of [280,320,448,768,1280]){
  await page.setViewportSize({width,height:849});
  const app=await page.locator('#app').boundingBox();assert.equal(app.x,0);assert.equal(app.y,0);assert.equal(app.width,width);assert.equal(app.y+app.height,849);
  const buttons=await page.locator('#rlfe-personal-nav button,#rlfe-resource-nav-host a,#rlfe-native-settings').all();
  assert.equal(buttons.length,5);const sidebar=await page.locator('.a11y_feed_filter_list').boundingBox();for(const button of buttons){const b=await button.boundingBox();assert(b&&b.x>=sidebar.x&&b.x+b.width<=sidebar.x+sidebar.width&&b.y>=0&&b.y+b.height<=849,JSON.stringify(b));}assert.equal(await page.locator('#rlfe-native-sidebar header').textContent(),'测试中的功能');assert.equal(await page.locator('#rlfe-native-settings-fallback').isVisible(),false);
 }
 await page.setViewportSize({width:448,height:849});
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const panel=await page.locator('#rlfe-host #panel').boundingBox();assert(panel.x>=0&&panel.x+panel.width<=448&&panel.y+panel.height<=849,JSON.stringify(panel));
 await page.locator('#rlfe-host [data-theme="mist"]').click();assert.equal(await page.evaluate(()=>fixture.prefs.theme),'sky');
 await page.locator('#rlfe-host #close').click();assert.equal(await page.evaluate(()=>__RLFE_SETTINGS_STATUS__().current.theme),'sky');
 await page.locator('#rlfe-native-settings').click();await page.locator('#rlfe-host [data-theme="mist"]').click();await page.locator('#rlfe-host #apply').click();await page.waitForFunction(()=>fixture.prefs.theme==='mist');
 await page.locator('#rlfe-personal-nav button').first().click();assert.equal(await page.evaluate(()=>__RLFE_WORKSPACE__.status().visible),true);
 const workspace=await page.locator('#rlfe-personal-workspace').boundingBox(),scroll=await page.locator('#rlfe-personal-workspace #scroll').boundingBox();assert.equal(workspace.x,0);assert.equal(workspace.y,0);assert(scroll.y+scroll.height<=849);await page.keyboard.press('Escape');
 await page.locator('#rlfe-personal-nav button').nth(1).click();assert.equal(await page.evaluate(()=>__RLFE_WORKSPACE__.status().surface),'thinking');await page.keyboard.press('Escape');
 await page.evaluate(()=>fixture.emit('topics',{sourceConnected:true,entries:[{webThreadId:'1000000000000000011',sessionId:'a'.repeat(32),name:'真实工作标题',summary:'核对状态',status:'running'}]}));
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-name')?.textContent==='真实工作标题');
 assert.equal(await page.locator('.rlfe-feed-status').textContent(),'running');
 // Regression: native title is a three-column grid, not the old flat Web fixture.
 const slots=await page.evaluate(()=>{const get=s=>{const b=document.querySelector(s).getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}};return {title:get('.rlfe-feed-headline'),badge:get('.rlfe-feed-status'),name:get('.rlfe-feed-name'),summary:get('.rlfe-feed-preview'),time:get('.native-time'),action:get('.native-action')};});
 assert(slots.summary.y>=slots.title.y+slots.title.h,JSON.stringify(slots));
 assert(slots.name.w>80,JSON.stringify(slots));assert(slots.badge.w>40);assert(slots.title.x+slots.title.w<=slots.time.x);
 assert(slots.summary.x+slots.summary.w<=slots.action.x);
 assert.equal(await page.locator('.native-digest').isVisible(),false);
 // Unchanged stream projections do not churn the DOM and flicker the grid.
 assert.equal(await page.evaluate(async()=>{let n=0;const o=new MutationObserver(rs=>n+=rs.length);o.observe(document.querySelector('.feed-main-list'),{subtree:true,childList:true,attributes:true,characterData:true});for(let i=0;i<20;i++)__RLFE_SET_TOPICS__({sourceConnected:true,entries:[{webThreadId:'1000000000000000011',sessionId:'a'.repeat(32),name:'真实工作标题',summary:'核对状态',status:'running'}]});await new Promise(r=>requestAnimationFrame(r));o.disconnect();return n;}),0);
 // Idle is a real RemoteLab state, not a reason to make the status disappear.
 await page.evaluate(()=>fixture.emit('topics',{sourceConnected:true,entries:[{webThreadId:'1000000000000000011',sessionId:'a'.repeat(32),name:'真实工作标题',summary:'核对状态',status:'idle',label:'空闲'}]}));
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-status')?.textContent==='空闲');
 assert.equal(await page.locator('.rlfe-feed-status').isVisible(),true);
 // Virtualized rows must shed the old Session immediately when reused.
 await page.evaluate(()=>document.querySelector('[data-feed-id]').dataset.feedId='1000000000000000099');
 await page.waitForFunction(()=>!document.querySelector('.rlfe-feed-headline'));
 assert.equal(await page.locator('._9f5c521').isVisible(),true);assert.equal(await page.locator('.native-digest').isVisible(),true);
 await page.evaluate(()=>document.querySelector('[data-feed-id]').dataset.feedId='1000000000000000011');
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-headline'));
 assert.equal(await page.locator('.rlfe-feed-headline').count(),1);

 await page.evaluate(()=>fixture.emit('topics',{sourceConnected:false,entries:[{webThreadId:'1000000000000000011',name:'真实工作标题',summary:'核对状态',status:'running'}]}));
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-status')?.textContent==='未同步');assert.equal(await page.locator('.rlfe-feed-status').textContent(),'未同步');assert.equal(await page.locator('[contenteditable=true]').textContent(),'尚未发送的草稿');

 await page.evaluate(()=>{const groups=document.querySelector('.a11y_feed_filter_list');groups.style.width='0px';groups.style.overflow='hidden';});
 await page.waitForFunction(()=>!document.getElementById('rlfe-native-settings-fallback').hidden);
 await page.locator('#rlfe-native-settings-fallback').click();assert.equal(await page.evaluate(()=>__RLFE_SETTINGS_STATUS__().open),true);await page.locator('#rlfe-host #close').click();
 await page.evaluate(()=>{const groups=document.querySelector('.a11y_feed_filter_list');groups.style.width='';groups.style.overflow='';});
 await page.waitForFunction(()=>document.getElementById('rlfe-native-settings-fallback').hidden);
 await page.evaluate(()=>{fixture.groups=document.querySelector('.a11y_feed_filter_list');fixture.groups.remove();});
 await page.waitForFunction(()=>!document.getElementById('rlfe-native-settings-fallback').hidden);
 await page.locator('#rlfe-native-settings-fallback').click();assert.equal(await page.evaluate(()=>__RLFE_SETTINGS_STATUS__().open),true);
 await page.locator('#rlfe-host #close').click();
 await page.evaluate(()=>document.getElementById('app').prepend(fixture.groups));
 await page.waitForFunction(()=>document.getElementById('rlfe-native-sidebar')?.parentElement===fixture.groups);
 assert.equal(await page.locator('#rlfe-native-sidebar').count(),1);
 // The separate chat renderer has no feed store; identity comes from committed header props.
 await page.evaluate(()=>{
  const chat=document.createElement('div');chat.className='lark-chat';chat.innerHTML='<div class="chatContainer__headerWrapper"></div>';document.getElementById('app').append(chat);
  chat.firstElementChild.__reactFiber$fixture={memoizedProps:{threadId:'1000000000000000011',chatId:'1000000000000000021'}};
  const topic={sessionId:'a'.repeat(32),webThreadId:'1000000000000000011',chatId:'group',name:'真实工作标题',summary:'核对状态',status:'running',usage:{cumulative:{totalTokens:1234}}};
  fixture.projection={sourceConnected:true,syncedAt:new Date().toISOString(),entries:[topic],boards:[{id:'fixture',name:'群',groups:[{chatId:'group',webChatId:'1000000000000000021',name:'群'}],topics:[{...topic,state:'running'}]}],webArtifacts:[]};fixture.emit('topics',fixture.projection);
 });
 await page.waitForFunction(()=>__RLFE_GROUP_BOARD_STATUS__?.().visible);
 assert.equal(await page.locator('#rlfe-group-board-host #counts').textContent(),'运行 1 · 完成 0 · 闲置 0');
 assert.equal(await page.evaluate(()=>__RLFE_USAGE_STATUS__().activeSession),'a'.repeat(32));
 await page.locator('#rlfe-group-board-host #toggle').click();assert.equal(await page.locator('#rlfe-group-board-host .name').textContent(),'真实工作标题');
 await page.evaluate(()=>{fixture.projection.entries[0].status='waiting';fixture.projection.boards[0].topics[0].state='waiting';fixture.emit('topics',fixture.projection)});
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-status')?.textContent==='waiting');
 await page.evaluate(()=>fixture.emit('topics',{...fixture.projection,sourceConnected:false}));
 await page.waitForFunction(()=>__RLFE_GROUP_BOARD_STATUS__().counts==='未同步');
 await page.evaluate(()=>fixture.emit('topics',fixture.projection));
 await page.waitForFunction(()=>document.querySelector('.rlfe-feed-status')?.textContent==='waiting');
 assert.equal(await page.evaluate(()=>typeof __RLFE_WEB_ARTIFACT_STATUS__),'function');
 await page.evaluate(()=>fixture.closeStream());
 await page.waitForFunction(()=>fixture.connections===2);
 await page.evaluate(()=>fixture.emit('topics',fixture.projection));
 await page.waitForFunction(()=>__RLFE_SYNC_STATUS__?.state==='connected');
 assert.equal(await page.locator('.rlfe-feed-status').textContent(),'waiting');

 assert.deepEqual(errors,[]);await fs.mkdir(out,{recursive:true});await page.screenshot({path:out+'/native-1.2-browser.png'});await fs.writeFile(out+'/native-browser-verification.json',JSON.stringify({navigation:true,groupSidebar:true,settingsAlwaysReachable:true,nativeGridSlots:true,unchangedProjectionNoDomChurn:true,recycledRowRestored:true,settingsPreviewAndSave:true,indexAndThinkingOpen:true,topicStateAndDisconnect:true,editorPreserved:true,errors},null,2));console.log('Native browser component checks passed');
}finally{await browser.close();}

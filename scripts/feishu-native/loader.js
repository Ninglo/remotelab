// Injected only into the isolated trial's messenger pages. No meeting injection.
(async()=>{
 const token=__CAPABILITY__,client=crypto.randomUUID(),base='http://127.0.0.1:19342';
 if(document.readyState==='loading')await new Promise(r=>document.addEventListener('DOMContentLoaded',r,{once:true}));
 async function nativeAccount(){const api=globalThis.ShellAPI?.app?.passport;if(!api?.getAuthInfo)return '';const info=await api.getAuthInfo();return String(info?.userId||'');}
 let account=await nativeAccount();if(!/^\d{10,30}$/.test(account))throw Error('未能确认当前本地飞书账号');
 globalThis.userId=account;document.documentElement.dataset.rlfeAccountId=account;globalThis.__RLFE_NATIVE_ORIGIN__=base;
 const headers=()=>({Authorization:'Bearer '+token,'X-Native-Account':account,'X-Native-Client':client});
 const call=async(route,body)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',credentials:'omit',headers:{...headers(),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const data=await r.json();if(!r.ok)throw Error(data.error||'本机服务不可用');return data;};
 const initial=await call('/initial');globalThis.__RLFE_SHARED_INITIAL__={settings:initial.settings,fontUrl:__FONT_URL__};
 globalThis.__RLFE_SHARED_SAVE__=raw=>{const req=JSON.parse(raw);void call('/save',{value:req.value}).then(()=>__RLFE_SHARED_ACK__(req.nonce,null),e=>__RLFE_SHARED_ACK__(req.nonce,e.message));};
 globalThis.__RLFE_SHARED_PREVIEW__=raw=>{void call('/preview',{value:JSON.parse(raw)}).catch(()=>{});};
 const changed=new Set(),messages=new Set(),ports=new Map();
 const chrome={storage:{local:{get:key=>call('/storage/get',{key}),set:values=>call('/storage/set',{values})},onChanged:{addListener:f=>changed.add(f),removeListener:f=>changed.delete(f)}},runtime:{
  getManifest:()=>({version:'1.2.0'}),onMessage:{addListener:f=>messages.add(f),removeListener:f=>messages.delete(f)},
  sendMessage:async m=>{if(m.type==='rlfe:check-update'){for(const f of messages)f({type:'rlfe:update-status',text:'本地增强 1.2 · 当前使用固定发布版本'});return {ok:true};}return call('/request',m);},
  connect:()=>{const id=crypto.randomUUID(),listeners=new Set(),disconnects=new Set();const p={onMessage:{addListener:f=>listeners.add(f)},onDisconnect:{addListener:f=>disconnects.add(f)},postMessage:m=>{void call('/topics/start',{...m,portId:id}).catch(e=>{for(const f of listeners)f({type:'error',error:e.message});});},disconnect:()=>{ports.delete(id);void call('/topics/stop',{portId:id});},receive:m=>{for(const f of listeners)f(m);}};ports.set(id,p);return p;}
 }};
 const open=window.open.bind(window);window.open=(url,...args)=>{let u;try{u=new URL(url,location.href);}catch{return open(url,...args);}const match=u.origin==='https://index.jiujianian.dev'&&u.pathname.match(/^\/page\/feishu-web-(settings|workspace|topics)\/connect$/);if(!match)return open(url,...args);const popup={nativePopup:crypto.randomUUID()};void call('/connect',{kind:match[1],state:u.searchParams.get('state'),popup:popup.nativePopup}).catch(e=>console.error(e.message));return popup;};
 document.addEventListener('click',e=>{const link=e.composedPath().find(n=>n?.tagName==='A');if(!link||!e.composedPath().some(n=>/^rlfe-/.test(n?.id||'')))return;try{const u=new URL(link.href);if(u.protocol==='https:'&&['index.jiujianian.dev','zhangyu.jiujianian.dev','qcnatfwzm13g.feishu.cn'].includes(u.hostname)){e.preventDefault();void call('/external',{url:u.href}).catch(console.error);}}catch{}},true);
 globalThis.__RLFE_NATIVE_NAVIGATE__=id=>call('/navigate',{id});
 const kind=location.pathname.includes('/messenger-chat/')?'chat':'list';let ids=[],queued=false,loaded=false,last='';
 function state(){if(!loaded)return;const status=globalThis.__RLFE_SHARED_STATUS__?.(),shadow=document.getElementById('rlfe-host')?.shadowRoot;const thread=globalThis.__RLFE_NATIVE_CHAT_THREAD__?.();const context=globalThis.__RLFE_NATIVE_CONTEXT__?.();const own=[...ids,context?.webChatId].filter(Boolean);if(/^\d{10,30}$/.test(thread||''))own.push(thread);
 const info={kind,nativeContext:context,groupBoard:globalThis.__RLFE_GROUP_BOARD_STATUS__?.(),usage:globalThis.__RLFE_USAGE_STATUS__?.(),artifacts:globalThis.__RLFE_WEB_ARTIFACT_STATUS__?.(),displayedRows:[...document.querySelectorAll('.rlfe-feed-headline')].map(e=>({id:e.closest('[data-feed-id]')?.dataset.feedId,sessionId:e.dataset.sessionId,status:e.querySelector('.rlfe-feed-status')?.textContent})),ids:[...new Set(own)],revision:9,webVersion:'1.2.0',theme:status?.settings?.current?.theme,font:status?.settings?.current?.font,open:status?.settings?.open,previewing:status?.settings?.previewing,tabs:[...shadow?.querySelectorAll('.tabs button')||[]].map(e=>e.textContent),themes:shadow?.querySelectorAll('[data-theme]').length,resourceNav:globalThis.__RLFE_RESOURCE_NAV_STATUS__?.(),workspace:globalThis.__RLFE_WORKSPACE__?.status(),messages:globalThis.__RLFE_MESSAGES__?.status(),sync:globalThis.__RLFE_SYNC_STATUS__,viewport:{w:innerWidth,h:innerHeight},accountBound:globalThis.__RLFE_PREFS__?.status().accountBound,editorCount:document.querySelectorAll('[contenteditable=true]').length,hasDraft:[...document.querySelectorAll('[contenteditable=true]')].some(e=>e.textContent.replace(/[\u200B-\u200D\uFEFF]/g,'').trim()),nativeFeedStore:!!globalThis.__feedStore};const digest=JSON.stringify(info);if(digest===last)return;last=digest;void call('/state',info).catch(()=>{});}
 function schedule(){if(queued||!loaded)return;queued=true;queueMicrotask(()=>{queued=false;state();});}
 globalThis.__RLFE_NATIVE_VISIBLE_FEEDS__=raw=>{ids=JSON.parse(raw);schedule();};
 let streamController=new AbortController();
 const response=await fetch(base+'/events',{headers:headers(),credentials:'omit',signal:streamController.signal});if(!response.ok)throw Error('本地同步连接未就绪');
 __WEB_BUNDLE__
 loaded=true;
 let latestTopics=initial.topics;
 const applyTopics=data=>{latestTopics=data;globalThis.__RLFE_SHARED_PROJECT__?.(data);globalThis.__RLFE_SYNC_STATUS__={state:data.sourceConnected?'connected':'disconnected',text:data.sourceConnected?'已与 RemoteLab 同步':data.error||'来源未同步'};window.dispatchEvent(new CustomEvent('rlfe:sync-status'));};
 globalThis.__RLFE_CONNECT_TOPICS__=()=>call('/refresh-source',{});
 applyTopics(initial.topics);

 if(kind==='chat'){globalThis.__RLFE_OPEN_SETTINGS__=()=>{void call('/open-settings',{});};}
 state();const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-feed-id','data-rlfe-theme']});
 for(const e of ['rlfe:settings','rlfe:topics','rlfe:sync-status','resize'])window.addEventListener(e,schedule);
 const panel=document.getElementById('rlfe-host')?.shadowRoot?.getElementById('panel');if(panel)new MutationObserver(schedule).observe(panel,{attributes:true});
 window.addEventListener('focus',()=>{void nativeAccount().then(next=>{if(next!==account){delete globalThis.userId;delete document.documentElement.dataset.rlfeAccountId;globalThis.__RLFE_SYNC_CLEANUP__?.();globalThis.__RLFE_WORKSPACE__?.cleanup();globalThis.__RLFE_MESSAGES__?.cleanup();window.dispatchEvent(new CustomEvent('rlfe:preferences'));location.reload();}});});
 const waitFor=(fn,message)=>new Promise((resolve,reject)=>{let o,t;const check=()=>{if(fn()){o?.disconnect();clearTimeout(t);resolve(true);return true}};if(!check()){o=new MutationObserver(check);o.observe(document,{subtree:true,childList:true,attributes:true});t=setTimeout(()=>{o.disconnect();reject(Error(message))},6000);check();}});
 let verifying=false;
 async function verify(){
  if(kind!=='list'||verifying)return;verifying=true;const before=(await call('/initial')).settings,shadow=document.getElementById('rlfe-host').shadowRoot;
  const report={revision:9,originalWebUi:true,fullOneToOneCompleted:false,remaining:[]};
  try{
   if(globalThis.__RLFE_SETTINGS_STATUS__().open)throw Error('用户正在编辑设置，本轮测试未执行');
   await document.fonts.load("14px 'Smiley Sans'");__RLFE_OPEN_SETTINGS__();
   const p=shadow.getElementById('panel').getBoundingClientRect();report.panel={x:p.x,y:p.y,w:p.width,h:p.height,right:p.right,bottom:p.bottom,viewportW:innerWidth,viewportH:innerHeight};
   if(p.x<0||p.right>innerWidth||p.bottom>innerHeight)throw Error('原面板超过窗口边界');
   report.tabs=[...shadow.querySelectorAll('.tabs button')].map(e=>e.textContent);report.themes=shadow.querySelectorAll('[data-theme]').length;
   const theme=before.theme==='mist'?'paper':'mist';shadow.querySelector('[data-theme="'+theme+'"]').click();
   if((await call('/initial')).settings.theme!==before.theme)throw Error('预览写入了已保存设置');report.previewDoesNotSave=true;
   shadow.getElementById('close').click();if(__RLFE_SETTINGS_STATUS__().current.theme!==before.theme)throw Error('关闭未还原预览');report.closeRestoresPreview=true;
   __RLFE_OPEN_SETTINGS__();shadow.querySelector('[data-theme="'+theme+'"]').click();shadow.getElementById('apply').click();
   await waitFor(()=>shadow.getElementById('panel').hidden,'保存后未收起');
   if((await call('/initial')).settings.theme!==theme)throw Error('选择没有持久保存');report.savePersistsAndCollapses=true;
   await __RLFE_UPDATE_SETTINGS__(before);report.testChoiceRestored=true;
   const selected=shadow.getElementById('topics').options[0]?.value;
   if(selected){
    __RLFE_OPEN_SETTINGS__();shadow.getElementById('topics').value=selected;shadow.getElementById('topics').dispatchEvent(new Event('change'));
    shadow.getElementById('alias').value='原版面板临时核对';shadow.getElementById('saveAlias').click();
    await waitFor(()=>__RLFE_SETTINGS_STATUS__().saved.aliases[':'+selected]==='原版面板临时核对','原版别名没有保存');
    await waitFor(()=>document.querySelector('[data-feed-id="'+selected+'"] .rlfe-feed-name')?.textContent==='原版面板临时核对','别名未显示在当前列表');
    report.aliasUsesOriginalControlsAndChangesList=true;
    if(__RLFE_SETTINGS_STATUS__().open)shadow.getElementById('close').click();
    await __RLFE_UPDATE_SETTINGS__(before);report.testAliasRestored=(await call('/initial')).settings.aliases[':'+selected]===before.aliases[':'+selected];
   }
   report.navigation=globalThis.__RLFE_RESOURCE_NAV_STATUS__?.();report.workspace=globalThis.__RLFE_WORKSPACE__?.status();
   if(!report.navigation?.visible||report.workspace?.entries?.length!==2)throw Error('四个网页导航入口未完整挂载');
   globalThis.__RLFE_WORKSPACE__.open('index');await new Promise(r=>requestAnimationFrame(r));report.indexOpens=globalThis.__RLFE_WORKSPACE__.status().visible;
   document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
   globalThis.__RLFE_WORKSPACE__.open('thinking');await new Promise(r=>requestAnimationFrame(r));report.thinkingOpens=globalThis.__RLFE_WORKSPACE__.status().visible;
   document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
   report.accountBound=globalThis.__RLFE_PREFS__.status().accountBound;
   report.componentChecksPassed=true;
  }catch(e){report.error=e.message;report.componentChecksPassed=false;}
  finally{const now=(await call('/initial')).settings;if(__RLFE_SETTINGS_STATUS__().open)shadow.getElementById('close').click();const restore={...now,aliases:{...now.aliases}};if(now.theme===('mist'===before.theme?'paper':'mist'))restore.theme=before.theme;for(const[k,v]of Object.entries(restore.aliases))if(v==='原版面板临时核对'){if(Object.hasOwn(before.aliases,k))restore.aliases[k]=before.aliases[k];else delete restore.aliases[k];}if(JSON.stringify(restore)!==JSON.stringify(now))await __RLFE_UPDATE_SETTINGS__(restore);state();await call('/verification',report);verifying=false;}
 }
 const consume=msg=>{if(msg.type==='settings')__RLFE_SHARED_RECEIVE__(msg.value);else if(msg.type==='topics')applyTopics(msg.value);else if(msg.type==='navigate'&&kind==='list'){void (async()=>{let error;try{if(!globalThis.__RLFE_NATIVE_LIST_LOCATE__)throw Error('原生导航未加载');await __RLFE_NATIVE_LIST_LOCATE__(msg.value.id);}catch(e){error=e.message;}await call('/navigation-result',{requestId:msg.value.requestId,error});})().catch(console.error);}else if(msg.type==='storage'){for(const f of changed)f(msg.value,'local');}else if(msg.type==='topic-stream'){ports.get(msg.value.portId)?.receive(msg.value);}else if(msg.type==='connected'){window.dispatchEvent(new MessageEvent('message',{origin:'https://index.jiujianian.dev',data:msg.value}));}else if(msg.type==='open-settings'&&kind==='list')__RLFE_OPEN_SETTINGS__();else if(msg.type==='verify')void verify();};
 let stream=response,retryUntil=Date.now()+120000,backoff=250;
 const waitRetry=ms=>new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);window.removeEventListener('focus',done);window.removeEventListener('online',done);resolve();};window.addEventListener('focus',done);window.addEventListener('online',done);if(ms!==null)timer=setTimeout(done,ms);});
 for(;;){
  let heartbeat;
  try{
   if(!stream){streamController=new AbortController();const connectTimer=setTimeout(()=>streamController.abort(),15000);try{stream=await fetch(base+'/events',{headers:headers(),credentials:'omit',signal:streamController.signal});}finally{clearTimeout(connectTimer);}if(!stream.ok)throw Error('本地同步连接失败');last='';state();}
   const reader=stream.body.getReader(),decoder=new TextDecoder();let buffer='';
   const contact=()=>{clearTimeout(heartbeat);heartbeat=setTimeout(()=>streamController.abort(),45000);retryUntil=Date.now()+120000;backoff=250;};contact();
   for(;;){const {value,done}=await reader.read();if(done)throw Error('本地同步服务已断开');contact();buffer+=decoder.decode(value,{stream:true});let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(line)consume(JSON.parse(line));}}
  }catch(e){clearTimeout(heartbeat);streamController.abort();stream=null;applyTopics({...latestTopics,sourceConnected:false,error:'本地同步连接已断开，正在恢复'});}
  if(Date.now()>=retryUntil){await waitRetry(null);retryUntil=Date.now()+120000;backoff=250;}else{await waitRetry(backoff);backoff=Math.min(2000,backoff*2);}
 }

})().catch(e=>{console.error('RemoteLab native:',e.message);const p=document.createElement('div');p.id='rlfe-native-error';p.textContent='本地增强未载入：'+e.message;p.style.cssText='position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#fff3cd;color:#664d03;padding:10px;font:13px system-ui';document.body.append(p);});

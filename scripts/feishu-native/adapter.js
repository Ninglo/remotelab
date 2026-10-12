(() => {
  globalThis.__RLFE_SHARED_CLEANUP__?.();
  globalThis.__RLFE_NATIVE_PREVIEW__?.destroy();
  globalThis.__RLFE_NATIVE_TOPICS_CLEANUP__?.();
  globalThis.__RLFE_CLEANUP__?.();
  globalThis.__RLFE_TOPICS_CLEANUP__?.();
  const initial=globalThis.__RLFE_SHARED_INITIAL__||{},pending=new Map();
  let saved=structuredClone(initial.settings||{}),serial=0,activeSession=null,projection={entries:[]};
  const nativeMain=location.pathname.includes('/messenger/messenger/');
  globalThis.__RLFE_LIVE__={fontUrl:initial.fontUrl,globalFontOnly:true};
  const deviceFields=['width','density','layout','petSize','petX','petY'];
  const fields=['enabled','usageEnabled','theme','font','bodyFont','readingEnabled','size','line','expand','aliases','petEnabled','petKind','petMotion','sortMode','pins',...deviceFields];
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
  const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
  __PORTABLE_VALIDATION__
  const get=async key=>({[key]:structuredClone(saved)});
  const set=values=>new Promise((resolve,reject)=>{
    const value=values['feishuWebExplore.v1'];
    if(!plain(value)||!globalThis.__RLFE_SHARED_SAVE__){reject(Error('本机加载器未连接，设置未保存。'));return;}
    const nonce=String(++serial),timer=setTimeout(()=>{pending.delete(nonce);reject(Error('本机设置保存未确认，请重新载入。'));},6000);
    pending.set(nonce,{resolve,reject,timer,value});
    globalThis.__RLFE_SHARED_SAVE__(JSON.stringify({nonce,value}));
  });
  globalThis.__RLFE_SHARED_ACK__=(nonce,error)=>{const p=pending.get(nonce);if(!p)return;clearTimeout(p.timer);pending.delete(nonce);if(error)p.reject(Error(error));else{saved=structuredClone(p.value);p.resolve();}};
  globalThis.__RLFE_PREFS__={get,set,portable,validate,deviceFields,status:()=>({accountBound:/^\d{10,30}$/.test(String(globalThis.userId||'')),deviceBound:true,loaded:true,message:'显示设置保存在当前本地账号；个人入口和消息设置由本人连接。'})};
  globalThis.__RLFE_SHARED_RECEIVE__=value=>{saved=structuredClone(value);window.dispatchEvent(new CustomEvent('rlfe:preferences',{detail:{accountBound:true}}));};
  const style=document.createElement('style');style.id='rlfe-native-web-adapter-style';
  // Original Web UI markup and styles are reused. Hide its duplicate controls
  // in the separate chat renderer; the list renderer owns the settings panel.
  style.textContent=nativeMain?'#rlfe-pet-host{display:none!important}':'#rlfe-host,#rlfe-sort-host,#rlfe-resource-nav-host,#rlfe-personal-nav,#rlfe-personal-workspace{display:none!important}';
  document.head.append(style);
  // The native navigation is outside the messenger renderer. Mount the same
  // Web components in a dedicated rail inside that renderer; never cover or
  // intercept the official native navigation or editor.
  if(nativeMain){
    const rail=document.createElement('aside');rail.id='rlfe-native-rail';rail.className='appNavbar';
    rail.innerHTML='<div class="appNavbar-navbarMenu"></div>';
    document.body.append(rail);
    const layout=document.createElement('style');layout.id='rlfe-native-rail-style';
    layout.textContent=`#rlfe-native-rail{position:fixed;left:0;top:0;bottom:0;width:132px;z-index:1000;background:var(--rlfe-nav,var(--bg-body,#f5f6f7));border-right:1px solid var(--rlfe-border,#dee0e3);padding:12px 4px;box-sizing:border-box;display:flex;flex-direction:column}#rlfe-native-rail .appNavbar-navbarMenu{display:flex;flex-direction:column;gap:8px;overflow-y:auto}body>div:not([id^="rlfe-"]){max-width:calc(100% - 132px);margin-left:132px}#rlfe-host{--rlfe-launch-width:116px;--rlfe-panel-left:12px;--rlfe-launch-top:auto;--rlfe-launch-bottom:16px}#rlfe-personal-workspace{z-index:2147482900!important}`;
    document.head.append(layout);
  }
  const added=new Map();
  globalThis.__RLFE_NATIVE_WEB_TOPIC_ROWS__=()=>{if(!nativeMain)return [...document.querySelectorAll('.threadWrapper[data-thread-id]')];return [...document.querySelectorAll('.feed-main-list [data-feed-id]')].map(row=>{if(!added.has(row))added.set(row,row.getAttribute('data-thread-id'));row.dataset.threadId=row.dataset.feedId;return row;});};
  globalThis.__RLFE_NATIVE_WEB_TOPIC_NAME__=el=>el.querySelector('._9f5c521')?.textContent||'';
  function nativeContext(){
    const threads=new Set(),chats=new Set();
    const header=document.querySelector('.lark-chat .groupDetail_content--TopicDetailPage')?.firstElementChild||document.querySelector('.lark-chat .chatContainer__headerWrapper');
    const rootOf=n=>{for(let i=0;n?.return&&i<100;i++)n=n.return;return n;};
    for(const el of [header,header?.querySelector('.threadMoreButton'),...(header?.children||[])].filter(Boolean)){
      let f=el[Object.keys(el).find(k=>/^__react(?:Fiber|InternalInstance)/.test(k))];
      const root=rootOf(f),alt=rootOf(f?.alternate);if(root?.stateNode?.current&&root.stateNode.current!==root&&alt?.stateNode?.current===alt)f=f.alternate;
      for(let d=0;f&&d<28;d++,f=f.return){const p=f.memoizedProps||{},read=(o,k)=>typeof o?.get==='function'?o.get(k):o?.[k];
       for(const [set,values]of [[threads,[p.threadId,read(p.thread,'id')]],[chats,[p.chatId,read(p.chat,'id'),read(p.originChat,'id')]]])for(const id of values)if(/^\d{10,30}$/.test(String(id||'')))set.add(String(id));}
    }
    return {threadId:threads.size===1?[...threads][0]:null,webChatId:chats.size===1?[...chats][0]:null};
  }
  function chatThread(){return nativeContext().threadId;}
  globalThis.__RLFE_NATIVE_CONTEXT__=nativeContext;
  globalThis.__RLFE_NATIVE_CHAT_THREAD__=chatThread;
  globalThis.__RLFE_NATIVE_ACTIVE_SESSION__=()=>activeSession;
  globalThis.__RLFE_SHARED_PROJECT__=data=>{
    projection=data;
    const prefs=globalThis.__RLFE_SETTINGS_STATUS__?.().current||saved;
    const entries=(data.entries||[]).map(e=>({...e,name:prefs.aliases?.[':'+e.webThreadId]||e.name}));
    const visible=new Set([...document.querySelectorAll('.feed-main-list [data-feed-id]')].map(n=>n.dataset.feedId));
    for(const [key,name]of Object.entries(prefs.aliases||{})){const id=key.slice(1);if(visible.has(id)&&!entries.some(e=>e.webThreadId===id))entries.push({webThreadId:id,name,summary:'',status:''});}
    globalThis.__RLFE_SET_TOPICS__?.({...data,entries});
    const selected=nativeMain?String(globalThis.__feedStore?.getState?.().status?.activeFeedId||data.nativeContext?.threadId||''):chatThread();
    activeSession=entries.find(e=>e.webThreadId===selected)?.sessionId||null;
    return {sourceConnected:!!data.sourceConnected,matchedRows:document.querySelectorAll('.rlfe-feed-headline').length,visibleRows:document.querySelectorAll('.feed-main-list [data-feed-id]').length,activeSession,resourceNavMounted:globalThis.__RLFE_RESOURCE_NAV_STATUS__?.().visible===true};
  };
  window.addEventListener('rlfe:topics',e=>{projection=e.detail||{entries:[]};const selected=nativeMain?String(globalThis.__feedStore?.getState?.().status?.activeFeedId||document.querySelector('[data-feed-active=true]')?.dataset.feedId||projection.nativeContext?.threadId||''):chatThread();activeSession=(projection.entries||[]).find(x=>x.webThreadId===selected)?.sessionId||null;});
  function visible(){
    const ids=[...new Set([...document.querySelectorAll('.feed-main-list [data-feed-id]')].map(e=>e.dataset.feedId).filter(id=>/^\d{10,30}$/.test(id)))];
    if(nativeMain)globalThis.__RLFE_NATIVE_VISIBLE_FEEDS__?.(JSON.stringify(ids));
  }
  let queued=false;
  const schedule=()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;visible();});};
  const observer=new MutationObserver(records=>{if(records.some(r=>!r.target.closest?.('#rlfe-host,#rlfe-pet-host,#rlfe-sort-host,.rlfe-feed-headline,.rlfe-feed-preview')))schedule();});
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-feed-id']});
  const onSettings=e=>{globalThis.__RLFE_SHARED_PROJECT__?.(projection);if(nativeMain)globalThis.__RLFE_SHARED_PREVIEW__?.(JSON.stringify(e.detail));};
  window.addEventListener('rlfe:settings',onSettings);
  globalThis.__RLFE_SHARED_STATUS__=()=>({revision:9,main:nativeMain,settings:globalThis.__RLFE_SETTINGS_STATUS__?.(),pet:globalThis.__RLFE_PET_STATUS__?.(),reading:globalThis.__RLFE_READING_STATUS__?.(),sort:globalThis.__RLFE_SORT_STATUS__?.(),sync:{sourceConnected:!!projection.sourceConnected,matchedRows:document.querySelectorAll('.rlfe-feed-headline').length},resourceNav:globalThis.__RLFE_RESOURCE_NAV_STATUS__?.(),nativeOuterNavCovered:false});
  globalThis.__RLFE_SHARED_CLEANUP__=()=>{observer.disconnect();window.removeEventListener('rlfe:settings',onSettings);style.remove();for(const [el,value] of added)value===null?el.removeAttribute('data-thread-id'):el.setAttribute('data-thread-id',value);for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('增强已关闭。'));}globalThis.__RLFE_TOPICS_CLEANUP__?.();globalThis.__RLFE_CLEANUP__?.();for(const key of ['__RLFE_SHARED_STATUS__','__RLFE_SHARED_PROJECT__','__RLFE_SHARED_RECEIVE__','__RLFE_SHARED_ACK__','__RLFE_SHARED_CLEANUP__','__RLFE_NATIVE_WEB_TOPIC_ROWS__','__RLFE_NATIVE_WEB_TOPIC_NAME__','__RLFE_NATIVE_CHAT_THREAD__','__RLFE_NATIVE_ACTIVE_SESSION__','__RLFE_NATIVE_CONTEXT__'])delete globalThis[key];};
  visible();
})();

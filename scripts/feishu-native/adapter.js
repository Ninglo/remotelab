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
  // The outer app rail is a different native view. Mount inside Feishu's
  // existing message-group column, outside its virtualized group rows.
  let layoutObserver,toolbar,layout,root,resizeObserver,fallback;
  if(nativeMain){
    toolbar=document.createElement('section');toolbar.id='rlfe-native-sidebar';toolbar.className='appNavbar';
    toolbar.setAttribute('aria-label','测试中的功能');
    toolbar.innerHTML='<div class="appNavbar-navbarMenu"></div><footer><button id="rlfe-native-settings" type="button"><span>设置</span><span class="version">v16</span></button></footer>';
    toolbar.querySelector('button').onclick=()=>globalThis.__RLFE_OPEN_SETTINGS__?.();
    fallback=document.createElement('button');fallback.id='rlfe-native-settings-fallback';fallback.type='button';fallback.textContent='设置 · v16';
    fallback.title='展开消息分组侧栏可查看测试中的功能';fallback.onclick=()=>globalThis.__RLFE_OPEN_SETTINGS__?.();document.body.append(fallback);
    layout=document.createElement('style');layout.id='rlfe-native-layout-style';
    layout.textContent=`
      [data-rlfe-native-groups]{display:flex!important;flex-direction:column!important;min-height:0!important}
      [data-rlfe-native-groups]>:not(#rlfe-native-sidebar){flex:1 1 auto!important;min-height:0!important;overflow:auto}
      #rlfe-native-sidebar{position:relative!important;inset:auto!important;display:flex!important;flex-direction:column!important;flex:0 1 auto!important;width:100%!important;height:auto!important;max-height:48%;min-height:40px!important;overflow:hidden!important;box-sizing:border-box;padding:8px 6px;border-top:1px solid var(--rlfe-border,#dee0e3);background:var(--rlfe-nav,var(--bg-body,#f5f6f7));color:var(--rlfe-text,#1f2329)}
      #rlfe-native-sidebar footer{flex:none;border-top:1px solid var(--rlfe-border,#dee0e3);margin-top:6px;padding-top:4px}
      #rlfe-native-sidebar .version{color:var(--text-caption,#646a73);font:inherit}
      #rlfe-native-sidebar .appNavbar-navbarMenu{display:block!important;width:100%!important;height:auto!important;max-height:none!important;min-height:0!important;overflow:auto!important;flex:1 1 auto!important}
      #rlfe-native-sidebar nav{display:block!important;width:100%!important;margin:0!important}
      #rlfe-native-settings{display:flex!important;align-items:center;justify-content:space-between;gap:4px;width:100%;height:32px;padding:0 6px;text-align:left;border:0;border-radius:5px;color:inherit;background:transparent;font:12px/1.5 var(--rlfe-ui-font,system-ui),sans-serif;cursor:pointer}
      #rlfe-native-settings:hover,#rlfe-native-settings-fallback:hover{background:var(--rlfe-hover,#e8e9eb)}
      #rlfe-native-settings-fallback{position:fixed;left:8px;bottom:8px;z-index:2147482900;padding:7px 10px;border:1px solid var(--rlfe-border,#dee0e3);border-radius:6px;background:var(--rlfe-nav,#f5f6f7);color:var(--rlfe-text,#1f2329);font:12px/1.5 var(--rlfe-ui-font,system-ui),sans-serif;cursor:pointer}
      #rlfe-native-settings-fallback[hidden]{display:none!important}
      #rlfe-host{--rlfe-panel-left:8px}
      #rlfe-personal-workspace{top:0!important;z-index:2147482900!important}
    `;document.head.append(layout);
    const navCss=`:host{display:block!important;width:100%!important;margin:0!important}div,#entries{display:grid!important;gap:2px!important}button,a,:host([data-compact=true]) button,:host([data-compact=true]) a{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;gap:4px!important;min-width:0!important;width:100%!important;height:32px!important;padding:0 6px!important;font:12px/1.5 var(--rlfe-ui-font,system-ui),sans-serif!important;overflow:hidden!important}svg{display:none!important}small.trial{display:inline!important;flex:none!important;font:inherit!important;color:var(--text-caption,#646a73)!important}span{min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important}`;
    function position(){const bounds=root?.getBoundingClientRect();fallback.hidden=!!(bounds&&bounds.width>=48&&bounds.height>80&&getComputedStyle(root).visibility!=='hidden');}
    function mountLayout(){
      const next=document.querySelector('.a11y_feed_filter_list,.feed-left-menu-list');
      if(next!==root){root?.removeAttribute('data-rlfe-native-groups');resizeObserver?.disconnect();root=next;
        if(root){root.setAttribute('data-rlfe-native-groups','');resizeObserver=new ResizeObserver(position);resizeObserver.observe(root);}}
      if(root&&toolbar.parentElement!==root)root.append(toolbar);
      if(!root&&toolbar.isConnected)toolbar.remove();
      for(const id of ['rlfe-resource-nav-host','rlfe-personal-nav','rlfe-host']){
        const shadow=document.getElementById(id)?.shadowRoot;
        if(shadow&&!shadow.getElementById('rlfe-native-sidebar-style')){const css=document.createElement('style');css.id='rlfe-native-sidebar-style';css.textContent=id==='rlfe-host'?'#launcher{display:none!important}':navCss;shadow.append(css);}
      }
      position();
    }
    layoutObserver=new MutationObserver(mountLayout);layoutObserver.observe(document.body,{childList:true,subtree:true});mountLayout();
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
  globalThis.__RLFE_SHARED_STATUS__=()=>({revision:16,main:nativeMain,settings:globalThis.__RLFE_SETTINGS_STATUS__?.(),pet:globalThis.__RLFE_PET_STATUS__?.(),reading:globalThis.__RLFE_READING_STATUS__?.(),sort:globalThis.__RLFE_SORT_STATUS__?.(),sync:{sourceConnected:!!projection.sourceConnected,matchedRows:document.querySelectorAll('.rlfe-feed-headline').length},resourceNav:globalThis.__RLFE_RESOURCE_NAV_STATUS__?.(),nativeOuterNavCovered:false});
  globalThis.__RLFE_SHARED_CLEANUP__=()=>{observer.disconnect();layoutObserver?.disconnect();resizeObserver?.disconnect();toolbar?.remove();fallback?.remove();layout?.remove();root?.removeAttribute('data-rlfe-native-groups');window.removeEventListener('rlfe:settings',onSettings);style.remove();for(const [el,value] of added)value===null?el.removeAttribute('data-thread-id'):el.setAttribute('data-thread-id',value);for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('增强已关闭。'));}globalThis.__RLFE_TOPICS_CLEANUP__?.();globalThis.__RLFE_CLEANUP__?.();for(const key of ['__RLFE_SHARED_STATUS__','__RLFE_SHARED_PROJECT__','__RLFE_SHARED_RECEIVE__','__RLFE_SHARED_ACK__','__RLFE_SHARED_CLEANUP__','__RLFE_NATIVE_WEB_TOPIC_ROWS__','__RLFE_NATIVE_WEB_TOPIC_NAME__','__RLFE_NATIVE_CHAT_THREAD__','__RLFE_NATIVE_ACTIVE_SESSION__','__RLFE_NATIVE_CONTEXT__'])delete globalThis[key];};
  visible();
})();

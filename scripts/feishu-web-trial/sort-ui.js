(() => {
  globalThis.__RLFE_NATIVE_SORT_UI_CLEANUP__?.();
  let alive=true,settings={},projection={},frame,anchor;
  const host=document.createElement('div');host.id='rlfe-native-sort-control';host.style.flex='0 0 auto';
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>:host{display:inline-flex;vertical-align:middle;font:12px system-ui;color:var(--rlfe-muted,#646a73)}:host([hidden]){display:none}label{display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:4px 8px}select{max-width:120px;font:inherit;color:inherit;border:1px solid var(--rlfe-border,#dee0e3);border-radius:4px;background:var(--rlfe-surface,#fff);padding:3px}small{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}small:empty{display:none}</style><label>排序 <select aria-label="消息排序"><option value="native">跟随飞书</option><option value="group">按群排列</option><option value="status">按进度排列</option><option value="topic">话题在前</option></select></label><small role="status"></small>`;
  const select=shadow.querySelector('select'),note=shadow.querySelector('small');
  function send(){window.dispatchEvent(new CustomEvent('rlfe:native-sort-input',{detail:JSON.stringify({mode:settings.localSortMode||'native',entries:(projection.entries||[]).map(e=>({id:String(e.webThreadId||''),status:e.status,stale:e.sourceStale===true||projection.sourceConnected===false}))})}));}
  select.onchange=()=>{void globalThis.__RLFE_UPDATE_SETTINGS__?.({localSortMode:select.value});};
  function render(){frame=null;if(!alive)return;const feed=document.querySelector('.feed-main-list');
    // Mount beside the native list, never in its virtualized rows or over them.
    const next=feed?.closest('._01cd2079')?.querySelector(':scope > ._79e103ba')||feed?.closest('.feed-column')?.querySelector('header');
    if(next&&next!==anchor){anchor=next;anchor.append(host);}
    host.hidden=!feed||!next;
    let state;try{state=JSON.parse(document.documentElement.getAttribute('data-rlfe-native-sort')||'{}');}catch{state={};}
    select.value=settings.localSortMode||'native';select.disabled=!state.hooked;
    const topic=select.querySelector('[value=topic]');topic.hidden=!!state.topicsOnly;
    note.textContent=state.error||(state.hooked&&state.mode!=='native'&&!state.complete?'正在加载列表…':'');
    host.title=note.textContent;
    const status=document.getElementById('rlfe-host')?.shadowRoot?.getElementById('sortStatus');if(status)status.textContent=note.textContent;
  }
  function schedule(){if(frame==null)frame=requestAnimationFrame(render);}
  const onSettings=e=>{settings=e.detail||{};send();schedule();},onTopics=e=>{projection=e.detail||{};send();};
  window.addEventListener('rlfe:settings',onSettings);window.addEventListener('rlfe:topics',onTopics);
  const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true});observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-rlfe-native-sort']});
  globalThis.__RLFE_SORT_STATUS__=()=>{try{return JSON.parse(document.documentElement.getAttribute('data-rlfe-native-sort')||'{}');}catch{return {};}};
  globalThis.__RLFE_NATIVE_SORT_UI_CLEANUP__=()=>{alive=false;observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('rlfe:settings',onSettings);window.removeEventListener('rlfe:topics',onTopics);window.dispatchEvent(new CustomEvent('rlfe:native-sort-input',{detail:JSON.stringify({mode:'native',entries:[]})}));host.remove();delete globalThis.__RLFE_SORT_STATUS__;delete globalThis.__RLFE_NATIVE_SORT_UI_CLEANUP__;};
  schedule();
})();

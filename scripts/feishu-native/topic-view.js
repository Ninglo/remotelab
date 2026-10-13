// Native feed cards have separate title and digest slots. Never place a digest
// beside the title in its three-column grid or change virtual-row dimensions.
(() => {
  globalThis.__RLFE_TOPICS_CLEANUP__?.();
  let data={entries:[]},scheduled=false,alive=true;
  const entries=new Map(),mounted=new Map();
  const make=(tag,cls)=>{const e=document.createElement(tag);e.className=cls;return e;};
  const style=make('style','');style.id='rlfe-sidebar-style';
  style.textContent=`
    .feed-main-list [data-rlfe-original]{display:none!important}
    .rlfe-feed-headline{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;overflow:hidden;font:inherit}
    .rlfe-feed-name{font:inherit!important;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rlfe-feed-status{flex:none!important;font:11px/18px var(--rlfe-ui-font,system-ui),sans-serif!important;white-space:nowrap;padding:0 5px;border-radius:3px;color:#646a73;background:#f2f3f5}
    .rlfe-feed-status[hidden]{display:none!important}
    .rlfe-feed-status[data-state=running]{color:#245bdb;background:#eff4ff}
    .rlfe-feed-status[data-state=waiting]{color:#9a5d00;background:#fff5df}
    .rlfe-feed-status[data-state=review]{color:#7a4dad;background:#f5effb}
    .rlfe-feed-status[data-state=stale]{color:#8a5100;background:#fff1cc}
    .rlfe-feed-preview{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;color:var(--text-caption,#8f959e)}
  `;document.head.append(style);
  const text=(e,value)=>{if(e.textContent!==value)e.textContent=value;};
  const attr=(e,key,value)=>{if(e.getAttribute(key)!==value)e.setAttribute(key,value);};
  function hide(state,node){if(!state.originals.has(node)){state.originals.add(node);node.setAttribute('data-rlfe-original','');}}
  function restore(row,state){for(const e of state.originals)e.removeAttribute('data-rlfe-original');state.headline.remove();state.preview?.remove();mounted.delete(row);}
  const readAttempts=new Set();
  // Only the opened chat with Feishu's committed zero-unread preview
  // qualifies. An unknown native structure, background row or older message
  // must never acknowledge a RemoteLab result.
  function nativePreview(row) {
    let f=row[Object.keys(row).find(k=>/^__react(?:Fiber|InternalInstance)/.test(k))];
    const rootOf=n=>{while(n?.return)n=n.return;return n;};
    const root=rootOf(f),alt=rootOf(f?.alternate);
    if(root?.stateNode?.current&&root.stateNode.current!==root&&alt?.stateNode?.current===alt)f=f.alternate;
    for(let n=0;f&&n<35;n++,f=f.return){
      const p=f.memoizedProps;
      for(const v of [p?.value,p?.preview,p])if(String(v?.id||'')===row.dataset.feedId&&Number.isFinite(v?.unreadCount)&&v.unreadCount===0)return v;
    }
    return null;
  }
  function acknowledgeRead() {
    if(!alive||!data.sourceConnected||!data.readSyncEnabled||document.visibilityState!=='visible')return;
    const entry=entries.get(data.nativeContext?.threadId);
    if(!entry||entry.status!=='review'||!entry.resultAt||entry.sourceStale)return;
    const key=entry.sessionId+':'+entry.resultAt;if(readAttempts.has(key))return;
    const row=[...document.querySelectorAll('.feed-main-list [data-feed-id]')].find(r=>r.dataset.feedId===entry.webThreadId),p=row&&nativePreview(row);
    const nativeTime=Number(p?.displayTime)*1000;
    if(!p||!Number.isFinite(nativeTime)||nativeTime<=0||nativeTime<Date.parse(entry.resultAt)||typeof globalThis.__RLFE_ACK_REVIEW__!=='function')return;
    readAttempts.add(key);if(readAttempts.size>128)readAttempts.delete(readAttempts.values().next().value);
    // Capture the observed timestamp before making the asynchronous request.
    Promise.resolve(globalThis.__RLFE_ACK_REVIEW__({webThreadId:entry.webThreadId,resultAt:entry.resultAt})).catch(error=>{
      const badge=row.querySelector('.rlfe-feed-status');if(badge)badge.title='已读同步失败：'+error.message+'；重新打开话题可重试';
    });
  }
  const onRead=e=>{
    if(!e.isTrusted)return;
    const row=e.target.closest?.('.feed-main-list [data-feed-id]'),entry=row&&entries.get(row.dataset.feedId);
    if(entry)readAttempts.delete(entry.sessionId+':'+entry.resultAt);
    queueMicrotask(acknowledgeRead);
  };
  document.addEventListener('click',onRead,true);
  function render(){
    if(!alive)return;
    for(const [row,state]of mounted)if(!row.isConnected||row.dataset.feedId!==state.id||!entries.has(state.id))restore(row,state);
    for(const row of document.querySelectorAll('.feed-main-list [data-feed-id]')){
      const id=row.dataset.feedId,entry=entries.get(id);if(!entry)continue;
      const main=row.querySelector('.a11y_feed_card_main'),name=main?.querySelector('._9f5c521');
      // Both supported native versions expose two direct rows: title + digest.
      // An unknown structure retains official text rather than guessing a slot.
      const titleRow=main?.children[0],detailRow=main?.children[1];
      let state=mounted.get(row);
      if(!name||!titleRow?.contains(name)||!detailRow){if(state)restore(row,state);continue;}
      if(state)for(const node of state.originals)if(!node.isConnected)state.originals.delete(node);
      if(state&&(state.name!==name||!state.headline.isConnected||state.detailRow!==detailRow)){restore(row,state);state=null;}
      if(!state){
        const headline=make('div','rlfe-feed-headline');headline.append(make('span','rlfe-feed-status'),make('span','rlfe-feed-name'));
        name.before(headline);state={id,name,detailRow,headline,preview:null,originals:new Set()};mounted.set(row,state);hide(state,name);
      }
      const {headline}=state,stale=data.sourceConnected===false||!!entry.sourceStale;
      attr(headline,'data-session-id',String(entry.sessionId||''));attr(headline,'data-stale',String(stale));
      const label=headline.lastElementChild;const title=String(entry.name||name.textContent||'');text(label,title);attr(label,'title',title);
      const badge=headline.firstElementChild,value=stale?'未同步':String(entry.label||entry.status||(entry.sessionId?'状态未知':''));
      text(badge,value);attr(badge,'data-state',stale?'stale':String(entry.status||''));if(badge.hidden!==!value)badge.hidden=!value;
      attr(badge,'title',stale?'同步中断，当前状态未知':entry.status==='review'&&!data.readSyncEnabled?'RemoteLab 结果未读；在设置中重新连接状态同步以启用飞书已读同步':'RemoteLab 当前会话状态');
      const summary=String(entry.summary||'').replace(/\s+/g,' ').trim();
      // The left digest slot owns the preview. Keep native right-side actions,
      // unread indicators, timestamps and completion controls in their slots.
      const digest=detailRow.firstElementChild;
      if(summary&&digest){
        if(!state.preview||state.preview.parentElement!==digest){state.preview?.remove();state.preview=make('div','rlfe-feed-preview');digest.prepend(state.preview);}
        for(const node of digest.children)if(node!==state.preview)hide(state,node);
        text(state.preview,summary);attr(state.preview,'title',summary);
      }else if(state.preview){
        state.preview.remove();state.preview=null;
        for(const node of [...state.originals])if(node!==name){node.removeAttribute('data-rlfe-original');state.originals.delete(node);}
      }
    }
  }
  const storeOff=globalThis.__feedStore?.subscribe?.(()=>queueMicrotask(acknowledgeRead));
  const observer=new MutationObserver(records=>{
    if(records.every(r=>(r.target.nodeType===3?r.target.parentElement:r.target).closest?.('.rlfe-feed-headline,.rlfe-feed-preview,#rlfe-native-sidebar,#rlfe-host')))return;
    // Restore recycled rows in this microtask, before paint; decorate on RAF.
    for(const [row,state]of mounted)if(!row.isConnected||row.dataset.feedId!==state.id)restore(row,state);
    if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;render();acknowledgeRead();});}
  });observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-feed-id','class','aria-selected']});
  globalThis.__RLFE_SET_TOPICS__=projection=>{data=projection;entries.clear();for(const e of data.entries||[])if(e.webThreadId)entries.set(e.webThreadId,e);render();acknowledgeRead();globalThis.__RLFE_SET_USAGE__?.(projection);window.dispatchEvent(new CustomEvent('rlfe:topics',{detail:projection}));};
  globalThis.__RLFE_TOPICS_CLEANUP__=()=>{alive=false;readAttempts.clear();storeOff?.();document.removeEventListener('click',onRead,true);observer.disconnect();for(const [row,state]of mounted)restore(row,state);style.remove();delete globalThis.__RLFE_SET_TOPICS__;delete globalThis.__RLFE_TOPICS_CLEANUP__;};
})();

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
    .rlfe-feed-status{flex:none!important;font:11px/18px system-ui,sans-serif!important;white-space:nowrap;padding:0 5px;border-radius:3px;color:#646a73;background:#f2f3f5}
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
      const badge=headline.firstElementChild,value=stale?'未同步':['running','waiting','review'].includes(entry.status)?entry.status:'';
      text(badge,value);attr(badge,'data-state',stale?'stale':String(entry.status||''));if(badge.hidden!==!value)badge.hidden=!value;
      attr(badge,'title',stale?'同步中断，当前状态未知':'RemoteLab 当前会话状态');
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
  const observer=new MutationObserver(records=>{
    if(records.every(r=>(r.target.nodeType===3?r.target.parentElement:r.target).closest?.('.rlfe-feed-headline,.rlfe-feed-preview,#rlfe-native-toolbar,#rlfe-host')))return;
    // Restore recycled rows in this microtask, before paint; decorate on RAF.
    for(const [row,state]of mounted)if(!row.isConnected||row.dataset.feedId!==state.id)restore(row,state);
    if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;render();});}
  });observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-feed-id']});
  globalThis.__RLFE_SET_TOPICS__=projection=>{data=projection;entries.clear();for(const e of data.entries||[])if(e.webThreadId)entries.set(e.webThreadId,e);render();globalThis.__RLFE_SET_USAGE__?.(projection);window.dispatchEvent(new CustomEvent('rlfe:topics',{detail:projection}));};
  globalThis.__RLFE_TOPICS_CLEANUP__=()=>{alive=false;observer.disconnect();for(const [row,state]of mounted)restore(row,state);style.remove();delete globalThis.__RLFE_SET_TOPICS__;delete globalThis.__RLFE_TOPICS_CLEANUP__;};
})();

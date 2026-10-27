// Width preferences are local to this device; native groups and rows stay intact.
(() => {
  globalThis.__RLFE_RESIZE_CLEANUP__?.();
  let settings={},drag=null,frame,alive=true,saving=Promise.resolve();
  const originals=new Map(),handles=new Map(),naturalFeedWidths=new Map();
  const properties=['width','min-width','max-width','flex-basis','flex-grow','flex-shrink'];
  function sameColumn(element){
    const rect=element.getBoundingClientRect();let candidate=element;
    for(let p=element.parentElement,n=0;p&&n<24;n++,p=p.parentElement){const r=p.getBoundingClientRect();
      if(Math.abs(r.left-rect.left)<10&&Math.abs(r.width-rect.width)<20)candidate=p;
      else if(r.width>rect.width+40)break;
    }return candidate;
  }
  function container(kind){
    if(kind==='nav')return document.querySelector('.appNavbar');
    const el=document.querySelector(kind==='group'?'.a11y_feed_filter_list,.feed-left-menu-list':'.feed-main-list');
    if(!el)return null;
    // When groups open, Feishu nests both columns inside one fixed-width shell.
    // The list's own column is narrower than that shell and must be sized separately.
    return kind==='feed'?(el.closest('._01cd2079')||sameColumn(el)):sameColumn(el);
  }
  const visible=node=>node&&node.getBoundingClientRect().width>0;
  function bounds(kind,node){const min=kind==='feed'?240:96;return {min,max:Math.max(min,Math.min(kind==='feed'?720:300,innerWidth-node.getBoundingClientRect().left-360))};}
  function remember(node){if(!originals.has(node))originals.set(node,Object.fromEntries(properties.map(k=>[k,[node.style.getPropertyValue(k),node.style.getPropertyPriority(k)]])));}
  function restore(node){const old=originals.get(node);if(old){for(const [k,[v,p]]of Object.entries(old))v?node.style.setProperty(k,v,p):node.style.removeProperty(k);originals.delete(node);delete node.dataset.rlfeColumn;}}
  function writeWidth(node,width,kind){remember(node);if(kind)node.dataset.rlfeColumn=kind;for(const key of properties.slice(0,4))node.style.setProperty(key,width+'px','important');node.style.setProperty('flex-grow','0','important');node.style.setProperty('flex-shrink','0','important');}
  function clamp(kind,node,value){const b=bounds(kind,node);return Math.round(Math.max(b.min,Math.min(b.max,value)));}
  function layout(){
    const nav=container('nav'),group=container('group'),feed=container('feed');
    const shell=feed?.closest('.page-view-messenger');
    const groupVisible=visible(group),key=groupVisible?'expanded':'collapsed';
    if(feed&&!naturalFeedWidths.has(key))naturalFeedWidths.set(key,feed.getBoundingClientRect().width);
    const enabled=innerWidth>=760;
    if(nav){if(enabled&&settings.navWidth>0)writeWidth(nav,clamp('nav',nav,settings.navWidth),'nav');else restore(nav);}
    if(group){if(enabled&&groupVisible&&settings.groupWidth>0)writeWidth(group,clamp('group',group,settings.groupWidth),'group');else restore(group);}
    const customized=enabled&&(settings.feedWidth>0||(groupVisible&&settings.groupWidth>0));
    if(feed){
      if(customized){const width=clamp('feed',feed,settings.feedWidth||naturalFeedWidths.get(key));writeWidth(feed,width,'feed');
        if(shell)writeWidth(shell,width+(groupVisible?group.getBoundingClientRect().width:0));
      }else{restore(feed);if(shell)restore(shell);}
    }
    for(const kind of ['nav','group','feed']){const node=container(kind),h=handles.get(kind);if(!h)continue;h.hidden=!enabled||!visible(node);if(!h.hidden)position(h,node,kind);}
    window.dispatchEvent(new CustomEvent('rlfe:layout'));
  }
  function change(kind,value){settings={...settings,[kind+'Width']:value};layout();saving=saving.then(()=>globalThis.__RLFE_UPDATE_SETTINGS__?.({[kind+'Width']:value})).catch(()=>{});}
  function refresh(){frame=null;if(!alive)return;
    for(const kind of ['nav','group','feed']){if(handles.has(kind)||!container(kind))continue;
      const h=document.createElement('div');h.className='rlfe-column-resize';h.tabIndex=0;h.setAttribute('role','separator');h.setAttribute('aria-orientation','vertical');h.setAttribute('aria-label',kind==='nav'?'调整左侧导航宽度':kind==='group'?'调整分组栏宽度':'调整消息列表宽度');h.title='拖动调整宽度；双击恢复。方向键微调';
      h.onpointerdown=e=>{const node=container(kind);if(e.button!==0||!node)return;e.preventDefault();drag={kind,start:e.clientX,width:node.getBoundingClientRect().width};h.setPointerCapture(e.pointerId);};
      h.onpointermove=e=>{const node=container(kind);if(!drag||drag.kind!==kind||!node)return;settings={...settings,[kind+'Width']:clamp(kind,node,drag.width+e.clientX-drag.start)};layout();};
      const end=e=>{if(!drag||drag.kind!==kind)return;drag=null;if(h.hasPointerCapture(e.pointerId))h.releasePointerCapture(e.pointerId);change(kind,settings[kind+'Width']||0);};h.onpointerup=end;h.onpointercancel=end;
      h.ondblclick=()=>change(kind,0);
      h.onkeydown=e=>{const node=container(kind);if(!node||!['ArrowLeft','ArrowRight','Home'].includes(e.key))return;e.preventDefault();change(kind,e.key==='Home'?0:clamp(kind,node,node.getBoundingClientRect().width+(e.key==='ArrowLeft'?-16:16)));};
      handles.set(kind,h);document.body.append(h);
    }layout();
  }
  function position(h,node,kind){const r=node.getBoundingClientRect(),b=bounds(kind,node);h.style.cssText=`left:${r.right-3}px;top:${r.top}px;height:${r.height}px`;h.setAttribute('aria-valuenow',Math.round(r.width));h.setAttribute('aria-valuemin',b.min);h.setAttribute('aria-valuemax',b.max);}
  function schedule(){if(frame==null)frame=requestAnimationFrame(refresh);}
  const style=document.createElement('style');style.textContent='[data-rlfe-column=group] .a11y_feed_left_menu,[data-rlfe-column=group] .a11y_feed_filter_list{width:100%!important;max-width:none!important}[data-rlfe-column=nav] .appNavbar-navbarMenu{width:100%!important;box-sizing:border-box}[data-rlfe-column=nav] .navbarMenu{width:100%!important;box-sizing:border-box}[data-rlfe-column=nav] .navbarMenu-content{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rlfe-column-resize{position:fixed;z-index:10002;width:6px;cursor:col-resize;touch-action:none;background:transparent}.rlfe-column-resize:hover,.rlfe-column-resize:focus-visible{background:#3370ff66;outline:0}.rlfe-column-resize[hidden]{display:none}';document.head.append(style);
  const onSettings=e=>{if(!drag)settings=e.detail;schedule();};window.addEventListener('rlfe:settings',onSettings);window.addEventListener('resize',schedule);
  const observer=new MutationObserver(records=>{if(records.some(r=>![...handles.values()].includes(r.target)))schedule();});observer.observe(document.body,{childList:true,subtree:true});
  globalThis.__RLFE_RESIZE_CLEANUP__=()=>{alive=false;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('rlfe:settings',onSettings);window.removeEventListener('resize',schedule);for(const node of [...originals.keys()])restore(node);for(const h of handles.values())h.remove();style.remove();delete globalThis.__RLFE_RESIZE_CLEANUP__;};schedule();
})();

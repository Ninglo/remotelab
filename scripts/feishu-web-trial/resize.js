// Column widths are device settings; do not write Feishu's native layout state.
(() => {
  globalThis.__RLFE_RESIZE_CLEANUP__?.();
  let settings={},drag=null,frame,alive=true,saving=Promise.resolve();
  const originals=new Map(),handles=new Map();
  function container(kind){
    if(kind==='nav')return document.querySelector('.appNavbar');
    const feed=document.querySelector('.feed-main-list');if(!feed)return null;
    const rect=feed.getBoundingClientRect();let candidate=feed;
    // Match the existing feed column by geometry, stopping before the chat pane.
    for(let p=feed.parentElement,n=0;p&&n<24;n++,p=p.parentElement){const r=p.getBoundingClientRect();
      if(Math.abs(r.left-rect.left)<10&&Math.abs(r.width-rect.width)<20)candidate=p;else if(r.width>rect.width+40)break;
    }return candidate;
  }
  function bounds(kind,node){return {min:kind==='nav'?96:240,max:Math.max(kind==='nav'?96:240,Math.min(kind==='nav'?300:720,innerWidth-node.getBoundingClientRect().left-360))};}
  function remember(node){if(!originals.has(node))originals.set(node,Object.fromEntries(['width','min-width','max-width','flex-basis','flex-grow','flex-shrink'].map(k=>[k,[node.style.getPropertyValue(k),node.style.getPropertyPriority(k)]])));}
  function restore(node){const old=originals.get(node);if(old){for(const [k,[v,p]]of Object.entries(old))v?node.style.setProperty(k,v,p):node.style.removeProperty(k);originals.delete(node);}}
  function size(kind,node,value){remember(node);const b=bounds(kind,node),width=Math.round(Math.max(b.min,Math.min(b.max,value)));for(const key of ['width','min-width','max-width','flex-basis'])node.style.setProperty(key,width+'px','important');node.style.setProperty('flex-grow','0','important');node.style.setProperty('flex-shrink','0','important');return width;}
  function save(kind,width){saving=saving.then(()=>globalThis.__RLFE_UPDATE_SETTINGS__?.({[kind==='nav'?'navWidth':'feedWidth']:width})).catch(()=>{});}
  function refresh(){frame=null;if(!alive)return;
    for(const kind of ['nav','feed']){const node=container(kind);let h=handles.get(kind);if(!node||node.getBoundingClientRect().width===0){if(h)h.hidden=true;continue;}
      if(!h){h=document.createElement('div');h.className='rlfe-column-resize';h.tabIndex=0;h.setAttribute('role','separator');h.setAttribute('aria-orientation','vertical');h.setAttribute('aria-label',kind==='nav'?'调整左侧导航宽度':'调整消息列表宽度');h.title='拖动调整宽度；双击恢复。方向键微调';
        h.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();drag={kind,node,start:e.clientX,width:node.getBoundingClientRect().width,id:e.pointerId};h.setPointerCapture(e.pointerId);};
        h.onpointermove=e=>{if(!drag||drag.kind!==kind)return;size(kind,node,drag.width+e.clientX-drag.start);position(h,node);window.dispatchEvent(new CustomEvent('rlfe:layout'));};
        const end=e=>{if(!drag||drag.kind!==kind)return;const width=node.getBoundingClientRect().width;drag=null;if(h.hasPointerCapture(e.pointerId))h.releasePointerCapture(e.pointerId);save(kind,width);schedule();};h.onpointerup=end;h.onpointercancel=end;
        h.ondblclick=()=>{restore(node);save(kind,0);schedule();};h.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home'].includes(e.key))return;e.preventDefault();if(e.key==='Home'){restore(node);save(kind,0);}else save(kind,size(kind,node,node.getBoundingClientRect().width+(e.key==='ArrowLeft'?-16:16)));schedule();};
        handles.set(kind,h);document.body.append(h);
      }
      const desired=settings[kind==='nav'?'navWidth':'feedWidth'];if(!drag){if(desired>0&&innerWidth>=760)size(kind,node,desired);else restore(node);}h.hidden=innerWidth<760;position(h,node);
    }
    window.dispatchEvent(new CustomEvent('rlfe:layout'));
  }
  function position(h,node){const r=node.getBoundingClientRect(),kind=handles.get('nav')===h?'nav':'feed',b=bounds(kind,node);h.style.cssText=`left:${r.right-3}px;top:${r.top}px;height:${r.height}px`;h.setAttribute('aria-valuenow',Math.round(r.width));h.setAttribute('aria-valuemin',b.min);h.setAttribute('aria-valuemax',b.max);}
  function schedule(){if(frame==null)frame=requestAnimationFrame(refresh);}
  const style=document.createElement('style');style.textContent='.rlfe-column-resize{position:fixed;z-index:10002;width:6px;cursor:col-resize;touch-action:none;background:transparent}.rlfe-column-resize:hover,.rlfe-column-resize:focus-visible{background:#3370ff66;outline:0}.rlfe-column-resize[hidden]{display:none}';document.head.append(style);
  const onSettings=e=>{settings=e.detail;schedule();};window.addEventListener('rlfe:settings',onSettings);window.addEventListener('resize',schedule);
  const observer=new MutationObserver(records=>{if(records.some(r=>![...handles.values()].includes(r.target)))schedule();});observer.observe(document.body,{childList:true,subtree:true});
  globalThis.__RLFE_RESIZE_CLEANUP__=()=>{alive=false;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('rlfe:settings',onSettings);window.removeEventListener('resize',schedule);for(const node of [...originals.keys()])restore(node);for(const h of handles.values())h.remove();style.remove();delete globalThis.__RLFE_RESIZE_CLEANUP__;};schedule();
})();

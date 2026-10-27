// Keep Feishu's group navigation; put our existing shortcuts below its rows.
(() => {
  globalThis.__RLFE_SIDEBAR_CLEANUP__?.();
  let root, nav, queued = false, alive = true;
  const nativeMenuStyles=new Map();
  const navObserver=new ResizeObserver(()=>layoutNav());
  const toolbar = document.createElement('section');
  toolbar.id = 'rlfe-web-sidebar';
  toolbar.setAttribute('aria-label', '工作入口');
  toolbar.innerHTML = '<div id="rlfe-web-shortcuts"></div>';
  const style = document.createElement('style');
  style.textContent = `
    [data-rlfe-web-groups]{display:flex!important;flex-direction:column!important;min-height:0!important}
    [data-rlfe-web-groups]>:not(#rlfe-web-sidebar){flex:1 1 auto!important;min-height:0!important;overflow:auto}
    #rlfe-web-sidebar{flex:0 0 auto;max-height:42%;min-height:0;overflow:auto;box-sizing:border-box;padding:6px;border-top:1px solid var(--rlfe-border,#dee0e3)}
    #rlfe-web-shortcuts{width:100%;min-width:0}
    .appNavbar[data-rlfe-narrow] .navbarMenu{flex-direction:column!important;justify-content:center!important;gap:3px!important;height:54px!important;padding:5px 4px!important}
    .appNavbar[data-rlfe-narrow] .navbarMenu-content{flex:none!important;width:100%;font-size:11px!important;line-height:14px!important;text-align:center;white-space:nowrap!important;overflow:hidden;text-overflow:ellipsis}
    .appNavbar[data-rlfe-narrow] .navbarMenu-icon{flex:none!important;margin:0!important}
    .appNavbar[data-rlfe-narrow] .appNavbar-search-input{justify-content:center!important}
    .appNavbar[data-rlfe-narrow] .search-input-box-desc,.appNavbar[data-rlfe-narrow] .search-input-box-shortcut{display:none!important}
  `;
  document.head.append(style);
  const compactCss = `:host{display:block!important;width:100%!important;margin:0!important}div,#entries{display:grid!important;gap:2px!important}button,a,:host([data-compact=true]) button,:host([data-compact=true]) a{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;gap:4px!important;min-width:0!important;width:100%!important;height:32px!important;padding:0 6px!important;font:12px/1.5 var(--rlfe-ui-font,system-ui),sans-serif!important;overflow:hidden!important}svg{display:none!important}small.trial{display:inline!important;flex:none!important;font:inherit!important}span{min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important}`;
  function layoutNav(){
    if(!nav)return;
    nav.toggleAttribute('data-rlfe-narrow',nav.getBoundingClientRect().width<128);
    const menu=nav.querySelector('.appNavbar-navbarMenu');if(!menu)return;
    if(!nativeMenuStyles.has(menu))nativeMenuStyles.set(menu,{maxHeight:menu.style.maxHeight,overflowY:menu.style.overflowY});
    const top=menu.getBoundingClientRect().top;
    const footers=[...nav.querySelectorAll('.navItem-userAuthList,.navItem-download'),document.getElementById('rlfe-host')?.shadowRoot?.getElementById('launcher')].filter(Boolean).map(e=>e.getBoundingClientRect()).filter(r=>r.height>0&&r.top>top);
    const max=Math.max(80,Math.min(innerHeight,...footers.map(r=>r.top))-top-8);
    if(menu.style.maxHeight!==max+'px')menu.style.maxHeight=max+'px';menu.style.overflowY='auto';
    for(const item of menu.querySelectorAll('.navbarMenu'))if(!item.title)item.title=item.querySelector('.navbarMenu-content')?.textContent||'';
  }
  function mount() {
    queued = false;
    if (!alive) return;
    const appNav=document.querySelector('.appNavbar');
    if(nav!==appNav){nav?.removeAttribute('data-rlfe-narrow');navObserver.disconnect();nav=appNav;if(nav)navObserver.observe(nav);}layoutNav();
    const next = document.querySelector('.a11y_feed_filter_list,.feed-left-menu-list');
    if (next !== root) { root?.removeAttribute('data-rlfe-web-groups'); root = next; root?.setAttribute('data-rlfe-web-groups', ''); }
    if (root && toolbar.parentElement !== root) root.append(toolbar);
    if (!root) toolbar.remove();
    for (const id of ['rlfe-personal-nav', 'rlfe-resource-nav-host']) {
      const shadow = document.getElementById(id)?.shadowRoot;
      if (shadow && !shadow.getElementById('rlfe-shortcut-style')) {
        const css = document.createElement('style'); css.id = 'rlfe-shortcut-style'; css.textContent = compactCss; shadow.append(css);
        for (const el of shadow.querySelectorAll('button,a')) if (!el.title) el.title = el.getAttribute('aria-label') || el.textContent;
      }
    }
  }
  function schedule() { if (!queued && alive) { queued = true; queueMicrotask(mount); } }
  window.addEventListener('rlfe:layout',layoutNav);window.addEventListener('resize',layoutNav);
  const observer = new MutationObserver(schedule); observer.observe(document.body, {childList:true,subtree:true});
  globalThis.__RLFE_SIDEBAR_CLEANUP__ = () => { alive=false;observer.disconnect();navObserver.disconnect();nav?.removeAttribute('data-rlfe-narrow');window.removeEventListener('rlfe:layout',layoutNav);window.removeEventListener('resize',layoutNav);for(const [el,old]of nativeMenuStyles){el.style.maxHeight=old.maxHeight;el.style.overflowY=old.overflowY;}root?.removeAttribute('data-rlfe-web-groups');toolbar.remove();style.remove();delete globalThis.__RLFE_SIDEBAR_CLEANUP__; };
  mount();
})();

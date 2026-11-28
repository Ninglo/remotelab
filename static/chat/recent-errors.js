"use strict";
(() => {
  const template = document.getElementById('monitorRecentErrorsTemplate');
  const root = template?.content.firstElementChild.cloneNode(true) || document.getElementById('monitorRecentErrors');
  if (!root) return;
  const endpoint = '/api/monitoring/recent-errors';
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (title, action) => {
    const el = node('button', title);
    el.type = 'button';
    el.onclick = action;
    return el;
  };
  const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const time = at => Number.isFinite(Date.parse(at || '')) ? formatter.format(new Date(at)) : '时间未知';
  async function request(query) {
    const response = await fetch(`${endpoint}?${new URLSearchParams(query)}`, { credentials:'same-origin', signal:AbortSignal.timeout(8000) });
    if (!response.ok) throw Object.assign(Error('Read failed'),{status:response.status});
    return response.json();
  }
  const disclosure = node('details');
  disclosure.className = 'recent-errors-disclosure';
  const entry = node('summary'), count = node('span');
  entry.append(node('strong','近期报错'),count);
  const coverage = node('details'), coverageList = node('ul');
  coverage.append(node('summary','采集范围与缺口'),coverageList);
  const list = node('div'), listNext = node('div'), notice = node('p'), repairList=node('ul');
  const repairLabel={observing:'修复观察中',closed:'已验证关闭',recurring:'复发'};
  notice.setAttribute('role','status');
  disclosure.append(entry, notice, repairList, list, listNext, button('刷新报错',()=>load()), coverage);
  root.append(disclosure);
  let loaded=false, unavailable=false, loading=false;
  const labels = new Map();

  function rowView(row) {
    const box=node('details'); box.className='recent-error-cluster'; box.dataset.cluster=row.id;
    const label=node('summary');
    label.append(node('strong',row.label),node('span',`${labels.get(row.source)||row.source} · 近 7 天 ${row.recentRecords} 条 · 最近 ${time(row.lastAt)}`));
    if (row.repair && repairLabel[row.repair.state]) label.append(node('span',` · ${repairLabel[row.repair.state]}`));
    const records=node('ul'); records.className='recent-error-records';
    const controls=node('div');
    box.append(label,records,controls);
    function renderEvents(events, next) {
      for(const item of events) {
        const line=node('li'), stamp=node('time',`${time(item.at)}（北京时间）`);
        if(Number.isFinite(Date.parse(item.at||''))) stamp.dateTime=item.at;
        line.append(stamp);
        const text=node('pre',item.excerpt||'原文未留存或当前不可查看。');
        text.className='recent-error-excerpt'; text.setAttribute('aria-label','报错原文');
        line.append(text);
        if(item.sessionId) {
          const link=node('a','查看原会话');
          link.href=`/?tab=sessions&session=${encodeURIComponent(item.sessionId)}`;
          line.append(link);
        }
        records.append(line);
      }
      controls.replaceChildren();
      if(next) controls.append(button('更多记录',()=>loadEvents(next)));
    }
    async function loadEvents(before=0) {
      controls.replaceChildren(node('p','正在读取更多记录…'));
      try {
        const page=await request({cluster:row.id,...(before?{before}:{})});
        if(!before) records.replaceChildren();
        renderEvents(page.events,page.next);
        if(!records.childElementCount) controls.append(node('p','暂无保留的明细。'));
      } catch {
        controls.replaceChildren(node('p','报错明细暂未读到。'),button('重试',()=>loadEvents(before)));
      }
    }
    if(row.events?.length) {
      renderEvents(row.events,row.eventsNext);
      // Legacy sources with surviving evidence can be resolved on demand.
      if(row.source==='run-result' && row.events.some(e=>!e.excerpt && e.reference && e.sessionId)) {
        controls.replaceChildren(button('查原执行结果及更多记录',()=>loadEvents()));
      }
    } else controls.append(node('p','暂无保留的明细。'));
    return box;
  }

  async function load(before=0) {
    if(loading)return;
    loading=true;
    try {
      const data=await request({samples:'1',...(before?{before}:{})});
      if(!before) {
        const opened=new Set([...list.querySelectorAll('details[open]')].map(el=>el.dataset.cluster));
        labels.clear();
        for(const source of data.sources)labels.set(source.id,source.label);
        coverageList.replaceChildren(...data.sources.map(source=>node('li',`${source.label}：${source.firstObservedAt?`最早取到 ${time(source.firstObservedAt)}`:'暂无报错样本（不是健康确认）'}`)),
          node('li','未接入的业务服务、普通工具命令退出及未结构化日志不在此处；旧记录原文不一定可恢复。'));
        count.textContent=`近 ${data.windowDays} 天`;
        repairList.replaceChildren(...(data.repairs||[]).map(r=>node('li',`${r.label||'报错'} · ${repairLabel[r.state]} · ${r.signature.slice(0,12)}`)),
          ...(data.invalidRepairs||[]).map(r=>node('li',`回执无效：${r.reason}`)));
        list.replaceChildren(...data.rows.map(row=>{const box=rowView(row);box.open=opened.has(row.id);return box;}));
        if(!data.rows.length)list.append(node('p','暂无近期报错记录。'));
      } else {
        const seen=new Set([...list.children].map(el=>el.dataset.cluster));
        list.append(...data.rows.filter(row=>!seen.has(row.id)).map(rowView));
      }
      notice.textContent=''; listNext.replaceChildren();
      if(data.next)listNext.append(button('更多同类报错',()=>load(data.next)));
      loaded=true;
    } catch(error) {
      if([403,404].includes(error.status)){unavailable=true;root.hidden=true;}
      else {count.textContent='暂不可用';notice.textContent='报错记录暂不可用，可点击刷新重试。';}
    } finally {loading=false;}
  }
  const updateView=()=>{
    if(template){
      const effect=document.getElementById('effect-block');
      if(!effect)return;
      if(root.parentElement!==effect)effect.append(root);
    }
    root.hidden=unavailable;
    if(!unavailable&&!loaded)void load();
  };
  if(template){
    const content=document.getElementById('content');
    if(content)new MutationObserver(updateView).observe(content,{childList:true});
  }
  updateView();
})();

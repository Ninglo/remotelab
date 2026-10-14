'use strict';
(function (g) {
  const root = document.getElementById('monitoringSessions');
  if (!root) return;
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
  let data = null, error = '', pending = null, serial = 0, days = 1, loadedAt = 0;
  const dashboardState = {};
  function render() {
    root.querySelectorAll('[data-agent-fold]').forEach(fold => { dashboardState[fold.dataset.agentFold] = fold.open; });
    root.replaceChildren(); root.append(el('h2', '会话概览'));
    if (data?.agentDashboard) {
      const dashboard = el('div'); root.append(dashboard);
      g.RemoteLabAgentDashboard?.render(dashboard, data.agentDashboard, { state: dashboardState });
    } else if (!error) root.append(el('p', pending ? '正在读取会话数据…' : '暂无会话统计。', 'monitoring-note'));
    if (error) {
      root.append(el('p', `${data ? '当前显示上次读取的数据。' : ''}会话数据读取失败：${error}`, 'monitoring-note'));
      const retry = el('button', '重试', 'monitoring-action'); retry.type = 'button'; retry.addEventListener('click', () => load(days, true)); root.append(retry);
    }
  }
  async function load(nextDays = 1, force = false) {
    if (pending && days === nextDays) return pending.promise;
    if (!force && data && days === nextDays && Date.now() - loadedAt < 15000) return;
    if (pending) pending.controller.abort();
    if (days !== nextDays) data = null;
    days = nextDays; error = ''; const id = ++serial, controller = new AbortController();
    const task = { controller }; pending = task; render();
    const timeout = setTimeout(() => controller.abort(), 15000);
    task.promise = (async () => {
      try {
        const r = await fetch(`/api/monitoring/sessions?days=${days}&compact=1&dashboard=1`, { credentials: 'same-origin', signal: controller.signal });
        if (r.status === 401 || r.status === 403) { data = null; throw Error('登录已失效，请重新登录'); }
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        const value = await r.json(); if (!value.agentDashboard) throw Error('未取得会话统计');
        if (id === serial) { data = value; loadedAt = Date.now(); }
      } catch (e) { if (id === serial) error = e.name === 'AbortError' ? '超过 15 秒，请重试' : e.message; }
      finally { clearTimeout(timeout); if (id === serial) { pending = null; render(); } }
    })();
    return task.promise;
  }
  g.RemoteLabSessionMonitoring = { load };
})(window);

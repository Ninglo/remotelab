"use strict";
(() => {
  const root = document.getElementById('monitorRecentErrors');
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
  const time = at => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—';
  function request(query = '', options) {
    return fetch(endpoint + query, { credentials: 'same-origin', signal: AbortSignal.timeout(10_000), ...options });
  }
  const headline = node('h2','近期报错');
  const summary = node('p');
  const coverage = node('details');
  const coverageList = node('ul');
  coverage.append(node('summary','采集范围与缺口'), coverageList);
  const list = node('div');
  const listNext = node('div');
  const notice = node('p');
  notice.setAttribute('role','status');
  root.append(headline, summary, button('刷新报错', () => load()), coverage, notice, list, listNext);
  let loaded = false, unavailable = false, loading = false;
  const labels = new Map();

  function repairForm(row, detail, clusterBox) {
    const form = node('form');
    const commitLabel = node('label','修复提交（完整 SHA）');
    const sha = node('input');
    sha.required = true; sha.pattern = '[a-f0-9]{40}'; sha.maxLength = 40;
    commitLabel.append(sha);
    const proofLabel = node('label','验证结果（何时、在哪里、怎样复验；不填敏感内容）');
    const proof = node('textarea');
    proof.required = true; proof.maxLength = 600; proof.rows = 2;
    proofLabel.append(proof);
    const submit = node('button','登记验证并标为已修');
    const status = node('p'); status.setAttribute('role','status');
    form.append(commitLabel, proofLabel, submit, status);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true;
      try {
        const saved = await request('/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cluster: row.id, version: detail.cluster.version, commit: sha.value, verification: proof.value }) });
        if (saved.status === 409) { status.textContent = '刚有新记录或状态变化，请重新打开详情核对。'; return; }
        if (!saved.ok) throw Error('Save failed');
        await load();
        const updated = [...list.children].find(el => el.dataset.cluster === row.id);
        if (updated) { updated.open = true; updated.querySelector('summary').focus(); }
        else { clusterBox.open = false; notice.textContent = '已登记修复验证。'; }
      } catch { status.textContent = '保存失败，请核对权限及网络后再试。'; }
      finally { submit.disabled = false; }
    };
    return form;
  }

  function rowView(row) {
    const box = node('details');
    box.className = 'recent-error-cluster'; box.dataset.cluster = row.id;
    const line = node('summary');
    const state = row.status === 'pending' ? '待修' : row.status === 'fixed' ? '已修' : row.identifiable ? '已记录' : '证据不足';
    const badge = node('small', state); badge.dataset.state = row.status;
    line.append(node('strong', row.label), badge,
      node('span', `${labels.get(row.source) || row.source} · ${row.recentOccurrences} 次独立发生／${row.recentRecords} 条记录 · ${time(row.lastAt)}`));
    const body = node('div');
    box.append(line, body);
    async function detail(before) {
      const next = node('div');
      const query = new URLSearchParams({ cluster: row.id, ...(before ? { before } : {}) });
      try {
        const response = await request(`?${query}`);
        if (!response.ok) throw Error('Detail unavailable');
        const data = await response.json();
        if (!before) {
          body.replaceChildren(node('p', `编号 ${row.id.slice(0, 10)} · 首次 ${time(data.cluster.firstAt)} · 近 24 小时 ${data.cluster.occurrences24h} 次`));
          if (data.repair) body.append(node('p', `上次修复 ${time(data.repair.at)} · ${data.repair.commitSha.slice(0, 12)}：${data.repair.verification}`));
        }
        const records = node('ul');
        for (const item of data.events) {
          const entry = node('li', `${time(item.at)} · 记录 #${item.seq}${item.reference ? ' · '+item.reference : ''}`);
          if (item.sessionId) {
            const link = node('a','查看原会话');
            link.href = `/?tab=sessions&session=${encodeURIComponent(item.sessionId)}`;
            entry.append(' · ', link);
          }
          records.append(entry);
        }
        if (!records.childElementCount) records.append(node('li','没有保留下来的明细。'));
        next.append(records);
        if (data.next) {
          const more = button('更多记录', async () => { more.disabled = true; if (await detail(data.next)) more.remove(); else more.disabled = false; });
          next.append(more);
        }
        if (!before && data.cluster.status === 'pending') body.append(repairForm(row, data, box));
        body.append(next);
        return true;
      } catch { body.append(node('p','报错明细暂不可用。')); return false; }
    }
    box.ontoggle = () => {
      if (box.open) { body.replaceChildren(node('p','正在读取记录…')); void detail(); }
    };
    return box;
  }
  async function load(before = 0) {
    if (loading) return;
    loading = true;
    try {
      const response = await request(before ? `?before=${before}` : '');
      if ([403, 404].includes(response.status)) { unavailable = true; root.hidden = true; return; }
      if (!response.ok) throw Error('List unavailable');
      const data = await response.json();
      if (!before) {
        const opened = new Set([...list.querySelectorAll('details[open]')].map(el => el.dataset.cluster));
        list.replaceChildren();
        labels.clear();
        for (const source of data.sources) labels.set(source.id, source.label);
        coverageList.replaceChildren(...data.sources.map(source => node('li', `${source.label}：${source.firstObservedAt ? `最早取到 ${time(source.firstObservedAt)}` : '暂无报错样本（不是健康确认）'}`)),
          node('li', '不含未接入的业务服务、普通工具命令退出和未结构化日志；除已有服务异常退出证据外，不回填旧记录。'));
        summary.textContent = `近 ${data.windowDays} 天 · ${data.pending} 类待修。滚动 ${data.escalationHours} 小时内第 ${data.threshold} 次独立发生标为待修；重试记录保留，不重复计入升级。`;
        if (!data.rows.length) list.append(node('p','接入来源暂无近期报错记录。'));
        for (const row of data.rows) { const box = rowView(row); box.open = opened.has(row.id); list.append(box); }
      } else list.append(...data.rows.filter(row => ![...list.children].some(el => el.dataset.cluster === row.id)).map(rowView));
      notice.textContent = '';
      listNext.replaceChildren();
      if (data.next) listNext.append(button('更多错误簇', () => load(data.next)));
      loaded = true;
    } catch { notice.textContent = '报错记录暂不可用，不能据此判断无故障。'; }
    finally { loading = false; }
  }

  const portal = root.hasAttribute('data-portal');
  const updateView = () => {
    const current = document.querySelector('#tabs [aria-current="page"]')?.dataset.tab;
    const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
    root.hidden = unavailable || (portal && (current || params.get('tab') || 'overview') !== 'overview');
    if (!root.hidden && !loaded) void load();
  };
  if (portal) {
    const tabs = document.getElementById('tabs');
    if (tabs) new MutationObserver(updateView).observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] });
    window.addEventListener('popstate', updateView);
  }
  updateView();
})();

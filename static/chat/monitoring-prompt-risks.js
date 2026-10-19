// Read-only view of the existing authenticated Prompt review store.
(() => {
  const labels = { critical: '严重', high: '高', medium: '中', low: '低', none: '未发现具体风险' };
  const categories = { injection: '外部内容被当成指令', authority: '越权或权限扩大', disclosure: '信息泄露', destructive: '破坏性操作', third_party: '影响他人或外部系统' };
  const kinds = { manifest: '运行准备文本', 'native-input': '后续提交文本', background: '后台辅助提示' };
  const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未记录';
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; };
  const link = (text, href) => { const e = node('a', text); e.href = href; e.target = '_blank'; e.rel = 'noopener noreferrer'; return e; };
  const endpoint = new URL('/api/monitoring/prompt-review', location.origin);
  const state = { severity: 'critical', offset: 0, data: null, folds: new Map(), sequence: 0, host: null };
  async function read(url) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error([401, 403].includes(response.status) ? '请登录 RemoteLab 后查看风险原文。' : '风险明细暂时无法读取，请重试。');
    return response.json();
  }
  function toolbar(data) {
    const bar = node('div', null, 'prompt-risk-toolbar'), label = node('label', '风险级别 '), select = node('select');
    select.setAttribute('aria-label', 'Prompt 风险级别');
    for (const value of ['critical', 'high', 'medium', 'low', 'none', '']) {
      const option = node('option', value ? `${labels[value]} · ${data?.risks?.[value] ?? '—'} 段` : '全部级别'); option.value = value; select.append(option);
    }
    select.value = state.severity;
    select.addEventListener('change', () => { state.severity = select.value; state.offset = 0; state.data = null; void load(); });
    label.append(select); bar.append(label);
    const refresh = node('button', '刷新风险明细'); refresh.type = 'button'; refresh.addEventListener('click', () => void load()); bar.append(refresh);
    return bar;
  }
  async function showContext(row, button, box) {
    if (box.dataset.loaded) { box.hidden = !box.hidden; return; }
    button.disabled = true; box.hidden = false; box.replaceChildren(node('p', '正在读取脱敏上下文…'));
    try {
      const url = new URL(endpoint); url.pathname += '/source'; url.searchParams.set('id', row.source.id);
      const original = await read(url);
      if (original.error) throw Error(original.error);
      if (typeof original.text !== 'string') throw Error('没有取得可核对的原文。');
      const lines = original.text.split('\n'), ranges = row.findings.map(f => ({
        start: row.source.startLine + f.startLine - 1, end: row.source.startLine + f.endLine - 1,
      }));
      const selected = new Set(); let truncated = false;
      for (const r of ranges) {
        const end = Math.min(lines.length, r.end + 3), boundedEnd = Math.min(end, r.start + 59);
        if (boundedEnd < end) truncated = true;
        for (let n = Math.max(1, r.start - 3); n <= boundedEnd; n++) selected.add(n);
      }
      box.replaceChildren(node('p', '以下为保存时的脱敏原文；标红行对应这次模型判断。', 'meta'));
      const pre = node('pre', null, 'prompt-risk-context'); let previous = 0;
      for (const number of [...selected].sort((a, b) => a - b)) {
        if (previous && number !== previous + 1) pre.append(node('span', '…\n'));
        const marked = ranges.some(r => number >= r.start && number <= r.end);
        pre.append(node(marked ? 'mark' : 'span', `${number}  ${lines[number - 1].slice(0, 1500)}\n`)); previous = number;
      }
      box.append(pre);
      if (truncated) box.append(node('p', '较长范围仅展开前60行，完整内容见脱敏原文。', 'meta'));
      box.append(link('查看完整脱敏原文', url.href)); box.dataset.loaded = 'true';
    } catch (error) { box.replaceChildren(node('p', error.message, 'notice')); }
    finally { button.disabled = false; }
  }
  function entry(row, index) {
    const details = node('details', null, 'prompt-risk-item'); details.dataset.riskId = row.id;
    details.open = state.folds.get(row.id) ?? index < 2;
    details.addEventListener('toggle', () => state.folds.set(row.id, details.open));
    const summary = node('summary'), severity = node('span', labels[row.severity] || '待核', 'badge ' + (['critical', 'high'].includes(row.severity) ? 'bad' : 'warn'));
    summary.append(severity, node('strong', [...new Set(row.findings.map(f => categories[f.category] || f.category))].join('、') || '本段未发现具体风险'));
    summary.append(node('span', row.findings[0]?.reason || '只说明该片段的模型审阅结果，不代表已验证安全。', 'prompt-risk-preview'));
    details.append(summary);
    const body = node('div', null, 'prompt-risk-body');
    body.append(node('p', `审阅 ${stamp(row.reviewedAt)} · ${kinds[row.source.kind] || row.source.kind} · 同文段关联 ${row.occurrences} 个来源`, 'meta'));
    body.append(node('p', '模型标记，尚未核实实际后果；原文中的历史操作或已授权行为也可能被标记。', 'meta'));
    for (const finding of row.findings) {
      const article = node('article', null, 'prompt-risk-finding'); article.dataset.severity = finding.severity;
      const from = row.source.startLine + finding.startLine - 1, to = row.source.startLine + finding.endLine - 1;
      article.append(node('h4', `${labels[finding.severity]} · ${categories[finding.category] || finding.category} · 原文第 ${from}–${to} 行`));
      article.append(node('pre', finding.evidence, 'prompt-risk-evidence'));
      const why = node('p'); why.append(node('strong', '为什么标记：'), document.createTextNode(finding.reason)); article.append(why);
      const next = node('p'); next.append(node('strong', '建议核对：'), document.createTextNode(finding.recommendation)); article.append(next);
      body.append(article);
    }
    const actions = node('div', null, 'prompt-risk-toolbar');
    if (row.findings.length) {
      const button = node('button', '展开上下文与标红行'), box = node('div'); button.type = 'button'; box.hidden = true;
      button.addEventListener('click', () => void showContext(row, button, box)); actions.append(button); body.append(box);
    }
    if (row.source.sessionId) actions.append(link('回原会话核对授权与结果', '/?session=' + encodeURIComponent(row.source.sessionId)));
    body.append(actions); details.append(body); return details;
  }
  function render(data, error = '') {
    const host = state.host; if (!host?.isConnected) return;
    host.replaceChildren(toolbar(data));
    if (error) host.append(node('p', error, 'notice'));
    if (!data) { if (!error) host.append(node('p', '正在读取已保存的风险明细…', 'meta')); return; }
    host.append(node('p', `结果更新 ${stamp(data.updatedAt)} · 审阅模型 ${data.model} · 规则 ${data.ruleVersion}。只读取已有结果，不启动模型审阅。`, 'meta'));
    host.append(node('p', '同一文本按指纹去重；关联来源数不等于独立事件数。处置结果尚未关联，旧标记不代表风险仍在发生。', 'meta'));
    const paging = () => {
      const bar = node('div', null, 'prompt-risk-toolbar');
      for (const [text, offset, disabled] of [['上一页', Math.max(0, state.offset - 50), state.offset === 0], ['下一页', state.offset + 50, state.offset + 50 >= data.total]]) {
        const button = node('button', text); button.type = 'button'; button.disabled = disabled;
        button.addEventListener('click', () => { state.offset = offset; state.data = null; void load(); }); bar.append(button);
      }
      bar.append(node('span', `${data.total} 段 · 第 ${Math.floor(state.offset / 50) + 1} 页`)); return bar;
    };
    host.append(paging());
    (data.rows || []).forEach((row, i) => host.append(entry(row, i)));
    if (!data.rows?.length) host.append(node('p', '当前筛选没有记录；其他级别和未审内容请分别查看。', 'empty'));
    host.append(paging());
  }
  async function load() {
    const sequence = ++state.sequence;
    render(state.data);
    try {
      const url = new URL(endpoint); url.search = new URLSearchParams({ severity: state.severity, state: 'reviewed', offset: state.offset });
      const data = await read(url);
      if (sequence !== state.sequence) return;
      state.data = data; render(data);
    } catch (error) { if (sequence === state.sequence) render(state.data, error.message + (state.data ? ' 下方保留上次结果。' : '')); }
  }
  window.RemoteLabPromptRisks = { mount(host) { state.host = host; void load(); } };
})();

(() => {
  const panel = document.getElementById('settings-personal-antigravity');
  if (!panel) return;
  const field = id => document.getElementById('personalAntigravity' + id);
  const status = field('Status');
  let busy = false;
  const historyButton = field('HistoryButton');
  const historyDialog = field('History');
  const historyForm = document.getElementById('indexHistorySearch');
  const historyKind = document.getElementById('indexHistoryKind');
  const historyQuery = document.getElementById('indexHistoryQuery');
  const historyStatus = document.getElementById('indexHistoryStatus');
  const historyResults = document.getElementById('indexHistoryResults');
  let historyRequest = null;
  let historySession = '';

  function syncHistoryButton() {
    historyButton.hidden = panel.hidden || selectedTool !== 'antigravity-personal';
    if (historyButton.hidden && historyDialog.open) historyDialog.close();
  }

  function addHistoryExcerpt(match, url) {
    if (historyButton.hidden || historySession !== resolveActiveComposerSessionId() || msgInput.disabled) {
      historyDialog.close();
      return;
    }
    const heading = '\n\nIndex 上下文引用（仅作参考。请区分已有记录和当前事实，并引用来源链接）';
    const quote = match.excerpt.split('\n').map(line => '> ' + line).join('\n');
    const label = match.kind === 'project-memory' ? '项目记忆' : match.kind === 'work-summary' ? '工作摘要'
      : match.role === 'assistant' ? '历史回复' : '历史提问';
    const addition = '\n\n' + label + ' · ' + (match.linkLabel || '来源') + ' ' + url + '\n' + quote;
    if (!msgInput.value.includes(addition)) {
      msgInput.value = msgInput.value.trimEnd() + (msgInput.value.includes(heading) ? '' : heading) + addition;
      msgInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    historyDialog.close();
    msgInput.focus();
  }

  function renderReferences(references) {
    let count = 0;
    for (const match of references) {
      const url = new URL(match.url, location.href);
      if (!['https:', 'http:'].includes(url.protocol)) continue;
      const section = document.createElement('article');
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = match.linkLabel ? match.title + ' · ' + match.linkLabel : match.title;
      const excerpt = document.createElement('p');
      excerpt.textContent = match.excerpt;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'modal-btn';
      add.textContent = '加入草稿';
      add.addEventListener('click', () => addHistoryExcerpt(match, url.href));
      section.append(link, excerpt, add);
      historyResults.append(section);
      count += 1;
    }
    return count;
  }

  function resetResults() {
    historyRequest?.abort();
    historyResults.replaceChildren();
    historyStatus.textContent = '';
  }

  historyKind.addEventListener('change', resetResults);
  historyButton.addEventListener('click', () => {
    if (msgInput.disabled) return;
    historySession = resolveActiveComposerSessionId();
    historyQuery.value = '';
    resetResults();
    historyDialog.showModal();
    historyQuery.focus();
  });
  historyDialog.addEventListener('close', resetResults);
  historyForm.addEventListener('submit', async event => {
    event.preventDefault();
    const query = historyQuery.value.trim();
    if (!query) return;
    resetResults();
    const controller = new AbortController();
    historyRequest = controller;
    historyStatus.textContent = '正在搜索…';
    try {
      const kind = historyKind.value;
      const searchingHistory = kind === 'history';
      const params = new URLSearchParams({ q: query, ...(searchingHistory ? { scope: 'personal-context' } : { kind }) });
      const endpoint = searchingHistory ? '/api/sessions/search' : '/api/personal-antigravity/context';
      const result = await fetchJsonOrRedirect(endpoint + '?' + params, { revalidate: false, signal: controller.signal });
      if (controller.signal.aborted) return;
      const references = searchingHistory ? result.sessions.flatMap(session => (session.matches || []).map(match => ({
        ...match, title: session.title, url: session.sessionUrl || ('/?session=' + encodeURIComponent(session.id)),
      }))) : result.references;
      const count = renderReferences(references);
      historyStatus.textContent = result.incomplete ? '部分来源暂时无法读取。'
        : count ? '' : '没有找到可引用的片段。可以换个关键词。';
    } catch {
      if (!controller.signal.aborted) historyStatus.textContent = '无法读取所选来源，请稍后重试。';
    }
  });

  async function update(action, method = 'GET') {
    if (panel.hidden || busy) return;
    busy = true;
    try {
      const data = await fetchJsonOrRedirect('/api/personal-antigravity/' + action, {
        method, revalidate: false, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      if (action === 'pair') {
        field('Code').textContent = data.code;
        const base = new URL(panel.querySelector('a[download]').href);
        base.pathname = base.pathname.replace(/\/api\/personal-antigravity\/worker$/, '');
        field('ConnectCommand').textContent = 'node personal-antigravity-device.mjs ' + base.href;
        field('Login').hidden = false;
        status.textContent = '等待在本机输入连接码';
      } else {
        field('Disconnect').hidden = !data.connected;
        status.textContent = data.connected ? '已连接本机 Antigravity' : '未连接';
        if (data.connected || action === 'disconnect') {
          field('Code').textContent = '';
          field('Login').hidden = true;
        }
      }
    } catch (error) {
      status.textContent = error.message || '读取连接状态失败';
    } finally {
      busy = false;
    }
  }

  field('Pair').addEventListener('click', () => update('pair', 'POST'));
  field('Refresh').addEventListener('click', () => update('status'));
  field('Disconnect').addEventListener('click', () => update('disconnect', 'POST'));
  window.remotelabPersonalAntigravity = {
    init(auth) {
      panel.hidden = auth?.features?.personalAntigravityBinding !== true;
      field('Nav').hidden = panel.hidden;
      syncHistoryButton();
    },
    syncHistoryButton,
    shown() { void update('status'); },
  };
})();

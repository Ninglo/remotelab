(() => {
  const panel = document.getElementById('settings-personal-antigravity');
  if (!panel) return;
  const field = id => document.getElementById('personalAntigravity' + id);
  const status = field('Status');
  let busy = false;
  const historyButton = field('HistoryButton');
  const historyDialog = field('History');
  const historyForm = document.getElementById('indexHistorySearch');
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
    const heading = '\n\nIndex 历史引用（仅作参考。请区分历史记录和当前事实，并引用来源链接）';
    const quote = match.excerpt.split('\n').map(line => '> ' + line).join('\n');
    const role = match.role === 'assistant' ? '历史回复' : '历史提问';
    const addition = '\n\n' + role + ' · 来源 ' + url + '\n' + quote;
    if (!msgInput.value.includes(addition)) {
      msgInput.value = msgInput.value.trimEnd() + (msgInput.value.includes(heading) ? '' : heading) + addition;
      msgInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    historyDialog.close();
    msgInput.focus();
  }

  function renderHistory(sessions) {
    let count = 0;
    for (const session of sessions) {
      const url = new URL(session.sessionUrl || ('/?session=' + encodeURIComponent(session.id)), location.href);
      if (!['https:', 'http:'].includes(url.protocol)) continue;
      for (const match of session.matches || []) {
        const section = document.createElement('article');
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = session.title;
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
    }
    return count;
  }

  historyButton.addEventListener('click', () => {
    if (msgInput.disabled) return;
    historySession = resolveActiveComposerSessionId();
    historyQuery.value = '';
    historyStatus.textContent = '';
    historyResults.replaceChildren();
    historyDialog.showModal();
    historyQuery.focus();
  });
  historyDialog.addEventListener('close', () => {
    historyRequest?.abort();
    historyResults.replaceChildren();
  });
  historyForm.addEventListener('submit', async event => {
    event.preventDefault();
    const query = historyQuery.value.trim();
    if (!query) return;
    historyRequest?.abort();
    const controller = new AbortController();
    historyRequest = controller;
    historyResults.replaceChildren();
    historyStatus.textContent = '正在搜索…';
    try {
      const params = new URLSearchParams({ q: query, scope: 'personal-context' });
      const result = await fetchJsonOrRedirect('/api/sessions/search?' + params, {
        revalidate: false, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const count = renderHistory(result.sessions);
      historyStatus.textContent = result.incomplete ? '部分历史暂时无法读取。'
        : count ? '' : '没有找到可引用的片段。可以换个关键词。';
    } catch {
      if (!controller.signal.aborted) historyStatus.textContent = '无法读取会话历史，请稍后重试。';
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

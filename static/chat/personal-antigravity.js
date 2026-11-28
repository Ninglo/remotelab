(() => {
  const panel = document.getElementById('settings-personal-antigravity');
  if (!panel) return;
  const field = id => document.getElementById('personalAntigravity' + id);
  const status = field('Status');
  let busy = false;

  function showSetup(open) {
    if (open) {
      const base = new URL(panel.querySelector('a[download]').href);
      base.pathname = base.pathname.replace(/\/api\/personal-antigravity\/worker$/, '');
      field('ConnectCommand').textContent = 'node personal-antigravity-device.mjs ' + base.href;
    }
    field('Login').hidden = !open;
    field('Setup').setAttribute('aria-expanded', String(open));
  }

  async function update(action, method = 'GET') {
    if (panel.hidden || busy) return;
    busy = true;
    try {
      const data = await fetchJsonOrRedirect('/api/personal-antigravity/' + action, {
        method, revalidate: false, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      if (action === 'pair') {
        field('Code').textContent = data.code;
        status.textContent = '等待本机连接';
      } else {
        field('Disconnect').hidden = !data.connected;
        field('Setup').hidden = data.connected;
        const mode = data.dailyMode ? '日常模式' : '逐条确认';
        status.textContent = data.connected ? '已连接 · ' + mode : '未连接';
        if (data.connected || action === 'disconnect') {
          field('Code').textContent = '';
          showSetup(false);
        }
      }
    } catch (error) {
      status.textContent = error.message || '读取连接状态失败';
    } finally {
      busy = false;
    }
  }

  field('Setup').addEventListener('click', () => showSetup(field('Login').hidden));
  field('Pair').addEventListener('click', () => update('pair', 'POST'));
  field('Refresh').addEventListener('click', () => update('status'));
  field('Disconnect').addEventListener('click', () => update('disconnect', 'POST'));
  window.remotelabPersonalAntigravity = {
    init(auth) {
      panel.hidden = auth?.features?.personalAntigravityBinding !== true;
      const provider = panel.closest('.settings-account-provider');
      if (provider) provider.hidden = panel.hidden && provider.dataset.hasSources !== 'true';
      else if (field('Nav')) field('Nav').hidden = panel.hidden;
      if (!panel.hidden && location.hash === '#settings-personal-antigravity') window.remotelabOpenSettingsTarget?.(panel.id);
    },
    shown() { void update('status'); },
  };
})();

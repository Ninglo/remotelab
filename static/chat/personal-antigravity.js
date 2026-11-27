(() => {
  const panel = document.getElementById('settings-personal-antigravity');
  if (!panel) return;
  const field = id => document.getElementById('personalAntigravity' + id);
  const status = field('Status');
  let busy = false;

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
    },
    shown() { void update('status'); },
  };
})();

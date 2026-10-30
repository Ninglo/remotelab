// Shared device authorization controller. The workbench mounts it in its own
// login card; employee websites keep the standalone /site-login entry.
(() => {
  function create({ status, authorize, retry, onConnected, onBusy = () => {}, openAuthorization = false, messages = {} }) {
    const message = (key, fallback) => messages[key] || fallback;
    let timer, deadline = 0, generation = 0, pending = false, polling = false, popup;
    async function api(action, method = 'GET') {
      const response = await fetch(`/api/site-login/${action}`, { method, credentials: 'same-origin', cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '登录服务暂时不可用');
      return value;
    }
    function closePopup() {
      try { if (popup && !popup.closed) popup.close(); } catch {}
      popup = null;
    }
    async function connected(id) {
      if (id !== generation) return;
      pending = false; clearTimeout(timer); authorize.hidden = true; retry.hidden = true;
      status.textContent = message('connected', '已登录');
      // Only leave the card after the application has accepted this identity.
      const destination = await onConnected();
      closePopup();
      if (destination) location.replace(destination);
    }
    function failed(error, id) {
      if (id !== generation) return;
      pending = false; clearTimeout(timer); closePopup(); onBusy(false);
      status.textContent = error; retry.hidden = false; authorize.hidden = true;
    }
    function schedule(seconds, id) {
      clearTimeout(timer);
      timer = setTimeout(() => poll(id), Math.max(1, seconds || 5) * 1000);
    }
    async function poll(id) {
      if (id !== generation || !pending || polling) return;
      if (Date.now() >= deadline) { failed(message('expired', '本次确认已过期，请重新连接。'), id); return; }
      polling = true;
      try {
        const value = await api('poll');
        if (id !== generation) return;
        if (value.state === 'connected') { await connected(id); return; }
        if (value.state !== 'pending') {
          failed(value.state === 'wrong_company' ? message('wrongCompany', '请使用本公司的飞书账号。') : message('incomplete', '本次确认未完成，请重新连接。'), id); return;
        }
        schedule(value.interval, id);
      } catch (error) { failed(error.message, id); }
      finally { polling = false; }
    }
    async function start() {
      const id = ++generation; pending = false; clearTimeout(timer); closePopup();
      retry.hidden = true; authorize.hidden = true; status.hidden = false; onBusy(true);
      status.textContent = message('checking', '正在检查登录状态…');
      // Reserve the tab during the click, before awaiting network requests.
      // A blocked popup still leaves a normal link on the same login card.
      if (openAuthorization) {
        try { popup = window.open('about:blank', '_blank'); } catch {}
      }
      try {
        let known = false;
        try { await api('me'); known = true; } catch {}
        if (!known) {
          // Upgrade the old path-scoped research cookie without reauthorization.
          const legacy = await fetch('/api/qianyan/internal/auth/me', { credentials: 'same-origin', cache: 'no-store' });
          if (legacy.ok) { try { await api('me'); known = true; } catch {} }
        }
        if (id !== generation) return;
        if (known) { await connected(id); return; }
        const value = await api('start', 'POST');
        if (id !== generation) return;
        if (value.state === 'connected') { await connected(id); return; }
        const url = new URL(value.verification_url);
        if (url.origin !== 'https://accounts.feishu.cn') throw new Error('登录入口无效');
        authorize.href = url.href; authorize.hidden = false; deadline = value.expires_at; pending = true;
        status.textContent = message('waiting', '确认身份后，回到此页会自动继续。');
        try { if (popup && !popup.closed) popup.location.replace(url.href); } catch {}
        schedule(value.interval, id);
      } catch (error) { failed(error.message, id); }
    }
    retry.addEventListener('click', start);
    // Returning from Feishu can complete immediately. The server still enforces
    // the provider's next-poll time and prevents overlapping provider requests.
    window.addEventListener('focus', () => poll(generation));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(generation); });
    return { start };
  }
  window.RemoteLabSiteLogin = { create };
  const status = document.getElementById('status');
  const authorize = document.getElementById('authorize');
  const retry = document.getElementById('retry');
  if (!status || !authorize || !retry) return;
  const requested = new URL(location.href).searchParams.get('returnTo') || '/site-login';
  let destination = '/site-login';
  try {
    const target = new URL(requested, location.origin);
    if (requested.startsWith('/') && target.origin === location.origin) destination = target.pathname + target.search + target.hash;
  } catch {}
  create({ status, authorize, retry, onConnected: async () => destination !== '/site-login' ? destination : null }).start();
})();

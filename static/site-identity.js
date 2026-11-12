(() => {
  'use strict';
  if (window.RemoteLabSiteIdentity || window.top !== window.self) return;
  const bar = document.createElement('aside');
  bar.id = 'remotelab-site-identity';
  bar.setAttribute('aria-label', '当前网站登录身份');
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  const login = document.createElement('a');
  login.textContent = '重新登录';
  login.href = '/site-login?returnTo=' + encodeURIComponent(location.pathname + location.search + location.hash);
  login.hidden = true;
  bar.append(label, login);
  document.body.append(bar);
  document.body.style.setProperty('--remotelab-original-margin-top', getComputedStyle(document.body).marginTop);
  document.body.classList.add('remotelab-has-site-identity');
  let pending = null;
  async function refresh() {
    if (pending) return pending;
    label.textContent = '正在核验身份'; login.hidden = true;
    pending = (async () => {
      try {
        const response = await fetch('/api/site-login/me', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        if (response.status === 401) {
          label.textContent = '飞书认证已失效'; login.hidden = false; bar.dataset.state = 'signed-out'; return;
        }
        if (!response.ok) throw Error('Identity unavailable');
        const { person } = await response.json();
        if (!person?.id || typeof person.name !== 'string') throw Error('Missing identity');
        const feishu = person.auth_kind === 'feishu' || person.feishu_verified === true;
        label.textContent = `${feishu ? '飞书认证' : '账号认证'}：${person.name}`;
        bar.dataset.state = 'authenticated';
      } catch {
        label.textContent = '身份暂未核验'; bar.dataset.state = 'unavailable';
      }
    })();
    try { await pending; } finally { pending = null; }
  }
  // Revalidate when returning to a page; never retain an old success from BFCache.
  window.addEventListener('pageshow', refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.RemoteLabSiteIdentity = Object.freeze({ refresh });
  void refresh();
})();

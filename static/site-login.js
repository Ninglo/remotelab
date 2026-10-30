const status = document.getElementById('status');
const authorize = document.getElementById('authorize');
const retry = document.getElementById('retry');
const requested = new URL(location.href).searchParams.get('returnTo') || '/site-login';
const destination = (() => {
  try {
    const target = new URL(requested, location.origin);
    if (requested.startsWith('/') && target.origin === location.origin) return target.pathname + target.search + target.hash;
  } catch {}
  return '/site-login';
})();
let timer;
let deadline = 0;
let generation = 0;
async function api(action, method = 'GET') {
  const response = await fetch(`/api/site-login/${action}`, { method, credentials: 'same-origin', cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '登录服务暂时不可用');
  return value;
}
function connected() {
  clearTimeout(timer); authorize.hidden = true; retry.hidden = true;
  status.textContent = '已登录';
  if (destination !== '/site-login') location.replace(destination);
}
function failed(message) {
  clearTimeout(timer); status.textContent = message; retry.hidden = false; authorize.hidden = true;
}
function schedule(seconds, id) {
  timer = setTimeout(async () => {
    if (id !== generation) return;
    if (Date.now() >= deadline) { failed('本次确认已过期，请重新连接。'); return; }
    try {
      const value = await api('poll');
      if (id !== generation) return;
      if (value.state === 'connected') { connected(); return; }
      if (value.state !== 'pending') {
        failed(value.state === 'wrong_company' ? '请使用本公司的飞书账号。' : '本次确认未完成，请重新连接。'); return;
      }
      schedule(value.interval || seconds, id);
    } catch (error) { failed(error.message); }
  }, Math.max(1, seconds) * 1000);
}
async function start() {
  const id = ++generation; clearTimeout(timer); retry.hidden = true; authorize.hidden = true;
  status.textContent = '正在检查登录状态…';
  try {
    try { await api('me'); connected(); return; } catch {}
    // The old research cookie is scoped to this API. A successful read upgrades
    // it to the shared cookie without asking the employee to authorize again.
    const legacy = await fetch('/api/qianyan/internal/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (legacy.ok) {
      try { await api('me'); connected(); return; } catch {}
    }
    const value = await api('start', 'POST');
    if (value.state === 'connected') { connected(); return; }
    const url = new URL(value.verification_url);
    if (url.origin !== 'https://accounts.feishu.cn') throw new Error('登录入口无效');
    authorize.href = url.href; authorize.hidden = false; deadline = value.expires_at;
    status.textContent = '确认身份后，回到此页会自动继续。';
    schedule(value.interval, id);
  } catch (error) { failed(error.message); }
}
retry.addEventListener('click', start);
start();

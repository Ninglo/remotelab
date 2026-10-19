// This window may receive one explicit click from the configured public site.
// Merely opening this URL (including after login) never starts a Session.
(() => {
  const button = document.getElementById('resolve');
  const status = document.getElementById('status');
  const { origin, report, item } = button.dataset;
  let busy = false;
  async function resolve() {
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = '正在保存上下文并提交…';
    try {
      const response = await fetch('/api/monitoring-resolution', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({report,item}) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '提交失败');
      status.textContent = result.accepted ? '已交给 Session 处理。' : '已有处理 Session，正在打开。';
      location.replace(result.session.url);
    } catch (error) { status.textContent = error.message; busy = false; button.disabled = false; }
  }
  button.addEventListener('click', resolve);
  if (window.opener) {
    window.addEventListener('message', event => {
      if (event.source !== window.opener || event.origin !== origin ||
          event.data?.type !== 'monitoring-resolve-click' || event.data.report !== report || event.data.item !== item) return;
      resolve();
    });
    window.opener.postMessage({type:'monitoring-resolve-ready',report,item}, origin);
  }
})();

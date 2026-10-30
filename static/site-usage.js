(() => {
  'use strict';
  if (window.RemoteLabSiteUsage || window.top !== window.self
      || !/^\/(?:public-pages\/[^/]+(?:\/|$)|preview\/[^/]+(?:\/|$)|sites\/?$)/.test(location.pathname)
      || typeof crypto.randomUUID !== 'function') return;

  const endpoint = '/api/site-usage/events';
  const actions = new Set(['open', 'download', 'preview']);
  let visitId = crypto.randomUUID(), entered = false, stopped = false, inFlight = null, queue = [];

  function track(event, value, leaving = false) {
    if (stopped || queue.length >= 50) return;
    const input = { event, eventId: crypto.randomUUID(), visitId };
    if (event === 'ui_action') input.action = value;
    if (event === 'page_visibility') input.state = value;
    queue.push(input);
    void flush(leaving);
  }
  async function flush(leaving = false) {
    if (inFlight && !leaving) return inFlight;
    if (stopped || !queue.length) return true;
    const batch = queue.splice(0, 50);
    const task = (async () => {
      try {
        const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin',
          mode: 'same-origin', redirect: 'error', referrerPolicy: 'same-origin', keepalive: true,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
        if ([400, 401, 403, 404, 405, 413].includes(response.status)) { stopped = true; queue = []; return false; }
        if (response.status !== 202) throw new Error('Collection unavailable');
        return true;
      } catch { if (!stopped) queue = batch.concat(queue).slice(0, 50); return false; }
    })();
    inFlight = task;
    const recorded = await task;
    if (inFlight === task) inFlight = null;
    if (recorded && queue.length) return flush();
    return recorded;
  }
  function enter() {
    if (entered || document.visibilityState !== 'visible') return;
    entered = true;
    track('page_enter');
  }
  document.addEventListener('visibilitychange', () => {
    enter();
    if (entered) track('page_visibility', document.visibilityState === 'visible' ? 'foreground' : 'background');
  });
  document.addEventListener('click', event => {
    if (!event.isTrusted || document.visibilityState !== 'visible') return;
    const element = event.target?.closest?.('[data-site-usage-action]');
    const action = element?.getAttribute('data-site-usage-action');
    if (actions.has(action)) track('ui_action', action);
  }, { capture: true, passive: true });
  window.addEventListener('pagehide', () => { if (entered) track('page_visibility', 'leave', true); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { visitId = crypto.randomUUID(); entered = false; enter(); }
  });
  // No cookies, storage, DOM text, hrefs, page URLs or browser IDs are read.
  window.RemoteLabSiteUsage = Object.freeze({ flush });
  enter();
})();

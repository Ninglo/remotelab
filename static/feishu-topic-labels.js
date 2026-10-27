// Built with RemoteLab's sidebar styles by scripts/build-feishu-topic-labels.mjs.
(() => {
  globalThis.__RLFE_TOPICS_CLEANUP__?.();
  const sharedCss = /*__REMOTELAB_TOPIC_CSS__*/ "";
  const entries = new Map(), originals = new Set();
  let data = {}, frame = null;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const style = node('style', ''); style.id = 'rlfe-sidebar-style';
  style.textContent = sharedCss + `
    .feed-main-list [data-rlfe-original]{display:none!important}
    .rlfe-feed-headline{flex:1;width:100%;font-family:var(--rlfe-ui-font,system-ui),sans-serif}
    .rlfe-feed-status[hidden]{display:none!important}
    .rlfe-feed-headline[data-stale="true"]{opacity:.75}
    .rlfe-feed-preview{font:12px/20px var(--rlfe-ui-font,system-ui),sans-serif;color:var(--rlfe-muted,#8f959e);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
  `;
  document.head.append(style);
  function hide(element) {
    if (!element) return;
    element.setAttribute('data-rlfe-original', ''); originals.add(element);
  }
  function restore(row) {
    for (const element of row.querySelectorAll('[data-rlfe-original]')) {
      element.removeAttribute('data-rlfe-original'); originals.delete(element);
    }
    row.querySelectorAll('.rlfe-feed-headline,.rlfe-feed-preview').forEach(element => element.remove());
  }
  function render() {
    for (const row of document.querySelectorAll('.feed-main-list [data-feed-id]')) {
      const entry = entries.get(row.dataset.feedId);
      if (!entry) { restore(row); continue; }
      const main = row.querySelector('.a11y_feed_card_main');
      const originalName = main?.querySelector('._2b17aec6'), originalPreview = main?.querySelector('._5d806a78');
      if (!main || !originalName || !originalPreview) continue;
      hide(originalName); hide(originalPreview); hide(main.querySelector('._3766bee7'));
      let headline = main.querySelector('.rlfe-feed-headline');
      if (!headline) {
        headline = node('div', 'rlfe-feed-headline');
        const badge = node('span', 'rlfe-feed-status'), dot = node('span', 'rlfe-status-dot');
        dot.setAttribute('aria-hidden', 'true');
        badge.append(dot, node('span', 'rlfe-status-label'));
        headline.append(badge, node('div', 'rlfe-feed-name')); originalName.before(headline);
      }
      const stale = data.sourceConnected === false || !!entry.sourceStale;
      headline.dataset.sessionId = entry.sessionId; headline.dataset.stale = String(stale);
      const name = headline.querySelector('.rlfe-feed-name'), text = entry.displayName ?? entry.name ?? '';
      if (name.textContent !== text) name.textContent = text;
      name.title = text;
      // No local read-state override: show the same row status as RemoteLab.
      const status = Object.hasOwn(entry, 'rowStatus') ? entry.rowStatus :
        (entry.label ? { key: entry.status, label: entry.label, className: 'status-' + (entry.status === 'review' ? 'unread' : entry.status) } : null);
      const badge = headline.querySelector('.rlfe-feed-status'), label = headline.querySelector('.rlfe-status-label');
      const value = stale ? '未同步' : status?.label || '';
      badge.className = 'rlfe-feed-status' + (!stale && status?.className ? ' ' + status.className : '');
      badge.dataset.state = stale ? 'stale' : entry.status;
      badge.hidden = !value || (!stale && status?.key === 'idle');
      if (label.textContent !== value) label.textContent = value;
      badge.title = stale ? '同步中断，当前状态未知' : status?.title || value;
      let preview = main.querySelector('.rlfe-feed-preview');
      if (!preview) { preview = node('div', 'rlfe-feed-preview'); originalPreview.before(preview); }
      const summary = String(entry.summary || '').replace(/\s+/g, ' ').trim();
      if (preview.textContent !== summary) preview.textContent = summary;
      preview.title = summary;
    }
  }
  const observer = new MutationObserver(records => {
    if (records.every(record => record.target.closest?.('.rlfe-feed-headline,.rlfe-feed-preview,#rlfe-host'))) return;
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; render(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-feed-id'] });
  globalThis.__RLFE_SET_TOPICS__ = projection => {
    data = projection; entries.clear();
    for (const entry of data.entries || []) if (entry.webThreadId) entries.set(entry.webThreadId, entry);
    render(); globalThis.__RLFE_SET_USAGE__?.(projection);
    window.dispatchEvent(new CustomEvent('rlfe:topics', { detail: projection }));
  };
  globalThis.__RLFE_TOPICS_CLEANUP__ = () => {
    observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); style.remove();
    for (const element of originals) element.removeAttribute('data-rlfe-original');
    document.querySelectorAll('.rlfe-feed-headline,.rlfe-feed-preview,.rlfe-feed-process').forEach(element => element.remove());
    delete globalThis.__RLFE_SET_TOPICS__; delete globalThis.__RLFE_TOPICS_CLEANUP__;
  };
})();

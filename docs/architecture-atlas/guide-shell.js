import { renderGuideShell } from './guide-shell-template.js?v=20261003l';

async function initializeGuide() {
  const route = document.body.dataset.guidePage;
  if (!route) return;
  if (!document.querySelector('.guide-masthead')) {
    const response = await fetch(new URL('./project.json?v=20261003l', import.meta.url));
    if (!response.ok) throw new Error('说明目录暂时不可读取');
    const catalog = await response.json();
    const page = catalog.pages.find(item => item.route === route);
    if (!page) return;
    document.body.insertAdjacentHTML('afterbegin', renderGuideShell(catalog, page, new URL('./', import.meta.url).href));
  }
  const main = document.querySelector('main');
  if (main && !document.getElementById('guide-main')) {
    const anchor = document.createElement('span');
    anchor.id = 'guide-main'; anchor.tabIndex = -1;
    main.prepend(anchor);
  }
  const technical = 'details[data-technical], details.guide-technical, details.journey-code';
  const controls = document.querySelectorAll('[data-guide-depth]');
  let depth = 'reading';
  try { if (sessionStorage.getItem('remotelab.guide.depth') === 'technical') depth = 'technical'; } catch {}
  const applyDepth = () => {
    document.body.dataset.guideDepth = depth;
    document.querySelectorAll(technical).forEach(detail => { detail.open = depth === 'technical'; });
    controls.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.guideDepth === depth)));
    const legacy = document.getElementById('expand-details');
    if (legacy) legacy.setAttribute('aria-expanded', String(depth === 'technical'));
  };
  controls.forEach(button => button.addEventListener('click', () => {
    depth = button.dataset.guideDepth;
    try { sessionStorage.setItem('remotelab.guide.depth', depth); } catch {}
    applyDepth();
  }));
  document.querySelectorAll('.aside-note,.comparison-appendix,.graph-relations').forEach(detail => detail.classList.add('guide-technical'));
  // Newly rendered step details follow the selected depth without changing
  // unrelated examples, private readbacks or their request behavior.
  if (main) new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      for (const detail of [node, ...node.querySelectorAll(technical)]) {
        if (detail.matches(technical)) detail.open = depth === 'technical';
      }
    }
  }).observe(main, { childList: true, subtree: true });
  const navigation = document.querySelector('.guide-navigation');
  const narrow = matchMedia('(max-width: 900px)');
  const setNavigation = () => { navigation.open = !narrow.matches; };
  setNavigation(); narrow.addEventListener('change', setNavigation);
  const revealAnchor = () => {
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  };
  document.querySelectorAll('.guide-local-toc a').forEach(link => link.addEventListener('click', () => {
    if (narrow.matches) navigation.open = false;
  }));
  window.addEventListener('hashchange', revealAnchor);
  applyDepth(); revealAnchor();
  const synchronizeView = () => {
    document.querySelectorAll('.guide-views button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.view === document.body.dataset.currentView));
    });
  };
  new MutationObserver(synchronizeView).observe(document.body, { attributes: true, attributeFilter: ['data-current-view'] });
  synchronizeView();
  const sections = document.querySelectorAll('main section[id],main header[id]');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      document.querySelectorAll('.guide-local-toc a').forEach(link => {
        if (link.hash === '#' + visible.target.id) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-90px 0px -65% 0px' });
    sections.forEach(section => observer.observe(section));
  }
}

initializeGuide().catch(error => {
  // The published shell is static and keeps working if enhancement fails.
  console.error('Guide navigation:', error.message);
});

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// This template is shared by the static assembler and the source-page preview.
// It contains navigation only. Chapter facts remain in their original sources.
export function renderGuideShell(catalog, page, prefix) {
  const link = route => `${prefix}${route}?v=${catalog.edition}`;
  const chapters = [{ id: 'guide', route: catalog.entry, title: '消息全程' }, ...catalog.chapters];
  const navigation = chapters.map((chapter, index) => `<a href="${escape(link(chapter.route))}"${page.chapter === chapter.id ? ' aria-current="page"' : ''}><span>${String(index).padStart(2, '0')}</span>${escape(chapter.navTitle || chapter.title)}</a>`).join('');
  const sections = page.sections.map(([id, title]) => `<a href="#${escape(id)}">${escape(title)}</a>`).join('');
  const tools = page.chapter === 'system' ? '<div class="guide-views" aria-label="系统查阅方式"><button type="button" data-view="experience">事件与状态</button><button type="button" data-view="paths">输入路径</button><button type="button" data-view="map">机制索引</button><button type="button" data-view="evidence">资源与证据</button></div>' : '';
  return `<a class="guide-skip" href="#guide-main">跳到正文</a><header class="guide-masthead"><a class="guide-wordmark" href="${escape(link(catalog.entry))}">RemoteLab<span>系统说明</span></a><div class="guide-header-links"><a href="${escape(link(catalog.entry))}#mechanisms">消息全程</a><a href="${escape(prefix + page.reference)}">参考文本</a></div></header>
<aside class="guide-rail" aria-label="整站目录"><details class="guide-navigation" open><summary>目录与实现细节</summary><nav class="guide-chapters" aria-label="章节目录">${navigation}</nav><div class="guide-mode" role="group" aria-label="技术细节展开方式"><button type="button" data-guide-depth="reading" aria-pressed="true">逐节阅读</button><button type="button" data-guide-depth="technical" aria-pressed="false">展开研发细节</button></div>${tools}<div class="guide-local-label">本章目录</div><nav class="guide-local-toc" aria-label="本章目录">${sections}</nav></details></aside>`;
}

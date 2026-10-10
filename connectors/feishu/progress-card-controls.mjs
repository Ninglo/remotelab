import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';
import { progressHistoryPages } from '../../lib/progress-card-history.mjs';

export function replyProgressCardPanel(cycle, latest) {
  const mode = cycle.messageReplyPolicy?.progress;
  if (mode !== 'card_all') return ['messages', 'card_latest'].includes(mode)
    ? [{ tag: 'markdown', content: '**最新进展**' }, ...latest] : progressCardPanel(cycle, latest);
  const history = (cycle.progressHistory || []).filter(item => item.seq <= cycle.latestSeq);
  const pages = progressHistoryPages(history), page = Math.min(cycle.cardDisclosure?.page || 0, pages.length - 1);
  const expanded = cycle.cardDisclosure?.mode === 'expanded';
  const button = (content, mode, targetPage = page, intent) => ({ tag: 'button', type: 'default',
    text: { tag: 'plain_text', content }, behaviors: [{ type: 'callback', value: {
      namespace: 'progress-card', sessionId: cycle.sessionId, anchorSeq: cycle.anchorSeq,
      revision: cycle.cardDisclosure?.revision || 0, mode, page: targetPage, ...(intent ? { intent } : {}),
    } }] });
  const current = latest.length ? latest : [{ tag: 'markdown', content: cycle.progress?.content || '暂无进度更新' }];
  const summary = current.map(element => ({ ...element, ...(element.content?.length > 180
    ? { content: `${element.content.slice(0, 180)}…（展开全部进展查看）` } : {}) }));
  return [{ tag: 'markdown', content: '**最新进展**' }, ...summary,
    { tag: 'markdown', content: `**全部进展 · ${history.length} 条${expanded ? ` · 第 ${page + 1}/${pages.length} 页` : ''}**` },
    button(expanded ? '折叠全部进展' : '展开全部进展', expanded ? 'collapsed' : 'expanded'),
    ...(expanded ? [{ tag: 'markdown', content: pages[page] },
      ...(page > 0 ? [button('上一页', 'expanded', page - 1, 'page')] : []),
      ...(page < pages.length - 1 ? [button('下一页', 'expanded', page + 1, 'page')] : [])] : [])];
}

// Native folds reset on full-card updates and do not report clicks. A callback
// disclosure keeps the shared card choice durable while the latest stays visible.
export function progressCardPanel(cycle = {}, latest = []) {
  const history = (cycle.progressHistory || []).filter(progress => progress.seq <= cycle.latestSeq);
  const url = cycle.sessionId ? buildSessionNavigationHref(cycle.sessionId, { requireAbsolute: true }) : '';
  const current = latest.length ? latest : [{ tag: 'markdown', content: cycle.progress?.content || '暂无进度更新' }];
  const expanded = cycle.cardDisclosure?.mode === 'expanded';
  const summary = current.map(element => ({ ...element, ...(element.content?.length > 180
    ? { content: `${element.content.slice(0, 180)}…（点击显示进展查看）` } : {}) }));
  const elements = [{ tag: 'markdown', content: '**最新进展**' }, ...summary];
  if (cycle.sessionId && Number.isSafeInteger(cycle.anchorSeq)) elements.push({
    tag: 'button', type: 'default', text: { tag: 'plain_text', content: expanded ? '点击折叠进展' : '点击显示进展' },
    behaviors: [{ type: 'callback', value: { namespace: 'progress-card', sessionId: cycle.sessionId,
      anchorSeq: cycle.anchorSeq, revision: cycle.cardDisclosure?.revision || 0,
      mode: expanded ? 'collapsed' : 'expanded' } }],
  });
  if (expanded) elements.push(
    { tag: 'markdown', content: '**工作过程**' },
    ...history.slice(-10).map((progress, index) => ({ tag: 'markdown',
      content: `**进展 ${Math.max(0, history.length - 10) + index + 1}**\n${progress.content.length > 600
        ? `${progress.content.slice(0, 600)}…（完整内容见会话历史）` : progress.content}` })),
    ...(url ? [{ tag: 'markdown', content: `[查看完整工作过程](${url})` }] : []));
  return elements;
}

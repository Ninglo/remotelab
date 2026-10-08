import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

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

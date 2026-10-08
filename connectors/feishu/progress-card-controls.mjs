import { sessionProgressMode } from '../../lib/session-progress-policy.mjs';
import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

// Feishu handles expand/collapse directly in the client. Ordinary progress,
// including the latest update, lives inside this one panel rather than buttons
// that change which transport publishes it.
export function progressCardPanel(cycle = {}, latest = []) {
  const past = (cycle.progressHistory || []).filter(progress => progress.seq <= cycle.latestSeq
    && progress.seq !== cycle.progress?.seq);
  const url = cycle.sessionId ? buildSessionNavigationHref(cycle.sessionId, { requireAbsolute: true }) : '';
  const current = latest.length ? latest : [{ tag: 'markdown', content: cycle.progress?.content || '暂无进度更新' }];
  return [{ tag: 'collapsible_panel', expanded: sessionProgressMode(cycle.progressPolicy) === 'expanded',
    header: { title: { tag: 'plain_text', content: `工作过程${past.length ? `（${past.length + 1} 条进展）` : ''} · 点击显示 / 折叠进展` } },
    elements: [
      ...past.slice(-10).map((progress, index) => ({ tag: 'markdown', content: `**进展 ${Math.max(0, past.length - 10) + index + 1}**\n${progress.content.length > 600
        ? `${progress.content.slice(0, 600)}…（完整内容见会话历史）` : progress.content}` })),
      { tag: 'markdown', content: '**最新进展**' },
      ...current,
      ...(url ? [{ tag: 'markdown', content: `[查看完整工作过程](${url})` }] : []),
    ],
  }];
}

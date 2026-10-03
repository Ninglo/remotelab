import { describeSessionProgressPolicy, sessionProgressMode } from '../../lib/session-progress-policy.mjs';
import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';

export function progressCardControls(cycle = {}) {
  if (!cycle.sessionId) return [];
  const policy = cycle.progressPolicy || {};
  const current = sessionProgressMode(policy);
  const modes = [{ mode: 'messages', label: '卡片＋新消息' }, { mode: 'card', label: '只更新卡片' },
    ...(policy.feishuProgressMode ? [{ mode: 'default', label: '恢复默认' }] : [])];
  return [
    { tag: 'markdown', content: `${describeSessionProgressPolicy(policy)} · 仅当前会话\n需要你回复的问题和最终结果仍发消息。` },
    { tag: 'column_set', flex_mode: 'flow', columns: modes.map(({ mode, label }) => ({
      tag: 'column', width: 'auto', elements: [{ tag: 'button',
        text: { tag: 'plain_text', content: label }, type: mode === current ? 'primary' : 'default',
        behaviors: [{ type: 'callback', value: { namespace: 'session-progress', sessionId: cycle.sessionId,
          mode, revision: policy.feishuProgressRevision || 0 } }],
      }],
    })) },
  ];
}

export function progressCardHistory(cycle = {}) {
  const past = (cycle.progressHistory || []).filter(progress => progress.seq <= cycle.latestSeq
    && progress.seq !== cycle.progress?.seq);
  if (!past.length) return [];
  const url = buildSessionNavigationHref(cycle.sessionId, { requireAbsolute: true });
  return [{ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `此前进展（${past.length} 条${past.length > 10 ? '，显示最近 10 条' : ''}）` } },
    elements: [
      ...past.slice(-10).map((progress, index) => ({ tag: 'markdown', content: `**进展 ${Math.max(0, past.length - 10) + index + 1}**\n${progress.content.length > 600
        ? `${progress.content.slice(0, 600)}…（完整内容见会话历史）` : progress.content}` })),
      ...(url ? [{ tag: 'markdown', content: `[查看完整会话历史](${url})` }] : []),
    ],
  }];
}

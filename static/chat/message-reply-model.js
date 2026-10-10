// Shared deterministic configuration and preview. No messages or model calls.
export const DEFAULT_REPLY_DRAFT = Object.freeze({ opening: true, checklist: true, progress: 'messages', groups: [] });

// Version 1 text progress keeps its accepted behavior. Version 2 gives each
// enabled progress mode a card, independently of an acceptance checklist.
export function replyProgressUsesCard(policy) {
  return ['card', 'card_latest', 'card_all'].includes(policy?.progress)
    || policy?.version >= 2 && policy.progress === 'messages';
}

export function validateReplyDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['opening', 'checklist', 'progress', 'groups', 'strictStartCheck'].includes(key))
      || value.strictStartCheck !== undefined && typeof value.strictStartCheck !== 'boolean'
      || typeof value.opening !== 'boolean' || typeof value.checklist !== 'boolean'
      || !['none', 'messages', 'card_latest', 'card_all', 'card'].includes(value.progress) || !Array.isArray(value.groups)
      || value.groups.length > 64) throw new Error('消息回复配置无效。');
  const groups = value.groups.map(group => {
    if (!group || Object.keys(group).some(key => !['sourceRouteId', 'chatId'].includes(key))
        || !/^[a-zA-Z0-9_-]{1,100}$/.test(group.sourceRouteId || '')
        || !/^oc_[a-zA-Z0-9]{1,100}$/.test(group.chatId || '')) throw new Error('请选择明确的飞书群。');
    return { sourceRouteId: group.sourceRouteId, chatId: group.chatId };
  });
  return { opening: value.opening, checklist: value.checklist, progress: value.progress,
    ...(value.strictStartCheck !== undefined ? { strictStartCheck: value.strictStartCheck } : {}),
    groups: [...new Map(groups.map(group => [`${group.sourceRouteId}:${group.chatId}`, group])).values()] };
}

export function buildReplyPreview(draft, locale = 'zh') {
  const value = validateReplyDraft(draft);
  const en = locale.startsWith('en');
  const steps = [];
  if (value.strictStartCheck) steps.push({ kind: 'start_check', title: en ? 'Strict work-start check' : '开工严格检查',
    text: en ? 'Check ownership, the existing mechanism and related work before starting. Decide work placement, reply destination and display separately.'
      : '先核对事项归属、现行机制和相关工作，再决定接续还是另开；回复位置与清单、进展展示分别判断。' });
  if (value.opening) steps.push({ kind: 'opening', title: en ? 'First reply · text' : '首条回复 · 文字',
    text: en ? 'I will check the report against its sources and identify the items that need correction.'
      : '我先对照原始资料检查这份报告，找出需要更正的内容。' });
  if (value.checklist) steps.push({ kind: 'checklist', title: en ? 'Task checklist · one original card' : '任务清单 · 一张原卡',
    text: en ? '○ Verify facts — Important claims match their sources.\n○ Deliver corrections — Changes and remaining questions are explained.'
      : '○ 核对事实 — 重要结论能对应原始资料。\n○ 交付修改结果 — 说明更正内容和仍待确认的问题。' });
  if (value.progress !== 'none') {
    const history = en ? ['I found two figures that disagree with the source.',
      'The first figure has been corrected.', 'Both figures have been checked; I am confirming one date.']
      : ['发现两处数字与原始资料不一致。', '已更正第一处数字。', '两处数字已核对，正在确认一处日期。'];
    const titles = en ? { messages: 'Card + separate text progress',
      card_latest: 'Card · latest progress', card_all: 'Card · all progress (collapsed by default)', card: 'Previously saved card progress' }
      : { messages: '卡片＋单独文字进展', card_latest: '卡片展示最新进展',
        card_all: '卡片展示全部进展（默认折叠）', card: '原已保存的卡片进展' };
    steps.push({ kind: 'progress', title: titles[value.progress], text: history.at(-1),
      card: true, combined: value.checklist, collapsed: ['card', 'card_all'].includes(value.progress),
      history, textMessages: value.progress === 'messages' ? history : [] });
  }
  steps.push({ kind: 'question', title: en ? 'When needed · separate question' : '需要时 · 单独提问',
    text: en ? 'Should this paragraph use last month’s data or the latest data?'
      : '这一段采用上个月的数据，还是最新的数据？' });
  steps.push({ kind: 'final', title: en ? 'Final reply · always sent' : '最终回复 · 始终发送',
    text: en ? 'The report review is complete. Two figures were corrected; one date still needs your confirmation.'
      : '报告核对完成，已更正两处数字；还有一处日期需要你确认。' });
  return steps;
}

// Shared presentation and append-only semantic history. Observations alone do
// not create entries or new notifications; timestamps never form the key.
export const alertText = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function alertTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '原记录未注明';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export function appendAlertHistory(owner, entry) {
  owner.history ||= [];
  const { at, ...semantic } = entry;
  const previous = owner.history.at(-1);
  if (previous) {
    const { at: previousAt, ...before } = previous;
    if (JSON.stringify(before) === JSON.stringify(semantic)) return false;
  }
  owner.history.push(structuredClone(entry));
  return true;
}
export function alertHistoryPanel(history = []) {
  if (!history.length) return [];
  return [{ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `历史执行记录 · ${history.length}条` } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content:
      (history.length > 20 ? '此处展示最近20条，完整过程见原始处理对话。\n\n' : '')
      + history.slice(-20).map(e => `**${alertTime(e.at)}｜${alertText(e.label)}**\n${alertText(e.summary)}`).join('\n\n')
      + '\n\n时间：北京时间' } }] }];
}
export function alertEvidenceImage(item) {
  const image = item.evidenceImage;
  return /^img_[\w-]+$/.test(image?.imageKey || '') ? [{ tag: 'img', img_key: image.imageKey,
    alt: { tag: 'plain_text', content: image.caption || '预警触发时的数据记录' }, mode: 'fit_horizontal', preview: true }] : [];
}
export function alertSessionUrl(sessionId, base) {
  try { const u = new URL(base); return sessionId && ['http:', 'https:'].includes(u.protocol)
    ? new URL(`/?session=${encodeURIComponent(sessionId)}&tab=sessions`, u).href : ''; } catch { return ''; }
}
// A request for help or a completed run does not establish who solved it.
export function resolutionAttribution(recovery) {
  const resolution = recovery?.resolution;
  if (!resolution?.evidence?.length) return '已复查恢复；处理归属尚未核实';
  return ({ agent: 'Agent 已自行处理', collaborative: 'Agent 与人工已完成协作处理',
    spontaneous: '指标自行恢复，Agent 已复查' })[resolution.method] || '已复查恢复；处理归属尚未核实';
}

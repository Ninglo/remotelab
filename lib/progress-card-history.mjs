// Keep every record in sequence order. Page the complete text rather than
// truncating older updates or long records to fit a provider message.
export function progressHistoryPages(history = [], latestSeq = Infinity) {
  const text = history.filter(item => item.seq <= latestSeq).sort((a, b) => a.seq - b.seq)
    .map((item, index) => `**进展 ${index + 1}**\n${item.content}`).join('\n\n') || '暂无进度更新';
  const chars = Array.from(text), pages = [];
  let page = '';
  for (let cursor = 0; cursor < chars.length;) {
    const chunk = chars.slice(cursor, cursor + 512).join('');
    // content is JSON inside a JSON request body; include both escaping layers.
    if (page && Buffer.byteLength(JSON.stringify(JSON.stringify(page + chunk))) > 6000) {
      pages.push(page); page = '';
    } else { page += chunk; cursor += 512; }
  }
  if (page) pages.push(page);
  return pages;
}

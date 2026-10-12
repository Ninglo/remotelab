import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let parserPromise;
function markdownParser() {
  // Reuse the shipped GFM parser; a line/pipe regex mistakes code for tables.
  parserPromise ||= readFile(new URL('../../static/marked.min.js', import.meta.url), 'utf8')
    .then(source => {
      const context = vm.createContext({});
      vm.runInContext(source, context);
      return context.marked;
    }).catch(error => { parserPromise = null; throw error; });
  return parserPromise;
}

function plainText(tokens = []) {
  return tokens.map(token => token.tokens ? plainText(token.tokens)
    : token.type === 'html' ? '' : token.text ?? token.raw ?? '').join('');
}

function cardMentions(text, parser) {
  // Post and card mentions use different attributes. Do not edit code examples.
  return parser.Lexer.lexInline(text).map(token => {
    if (token.type === 'codespan') return token.raw;
    if (token.tokens) return token.raw.replace(token.text, cardMentions(token.text, parser));
    return token.type === 'html' ? token.raw.replace(/^<at user_id=/, '<at id=') : token.raw;
  }).join('');
}

function columnWidths(table) {
  const sizes = table.header.map((header, index) => {
    const cells = [header, ...table.rows.map(row => row[index])];
    const length = Math.max(...cells.map(cell => Array.from(plainText(cell?.tokens))
      .reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 2 : 1), 0)));
    return Math.max(100, Math.min(480, length * 7 + 24));
  });
  // Small tables fill the card. Wider tables retain readable columns and scroll.
  if (sizes.length > 4) return sizes.map(size => `${size}px`);
  const total = sizes.reduce((a, b) => a + b, 0);
  let used = 0;
  return sizes.map((size, index) => {
    const percent = index === sizes.length - 1 ? 100 - used : Math.round(size / total * 100);
    used += percent;
    return `${percent}%`;
  });
}

function nativeTable(table, parser) {
  const widths = columnWidths(table);
  return {
    tag: 'table', page_size: 10, row_height: 'auto', row_max_height: '999px',
    header_style: { bold: true, background_style: 'grey', lines: 2 },
    columns: table.header.map((cell, index) => ({
      name: `column_${index}`, display_name: plainText(cell.tokens),
      data_type: 'markdown', width: widths[index], vertical_align: 'top',
      horizontal_align: table.align[index] || 'left',
    })),
    rows: table.rows.map(row => Object.fromEntries(table.header.map((_, index) => [
      `column_${index}`, cardMentions(row[index]?.text || '', parser),
    ]))),
  };
}

/** Convert an already-rendered post, retaining formula/image/code ordering.
 * Return null when conversion cannot retain all content within card limits.
 * Contract: https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table
 */
export async function buildFeishuTableCard(postContent) {
  const rows = JSON.parse(postContent).zh_cn?.content || [];
  if (!rows.some(row => row.some(item => item.tag === 'md' && /\|/.test(item.text)))) return null;
  const parser = await markdownParser();
  const elements = [];
  let tableCount = 0;
  const markdown = content => {
    if (!content.trim()) return;
    if (elements.at(-1)?.tag === 'markdown') elements.at(-1).content += `\n\n${content}`;
    else elements.push({ tag: 'markdown', content });
  };
  for (const row of rows) {
    if (row.length !== 1) return null;
    const item = row[0];
    if (item.tag === 'md') {
      const tokens = parser.lexer(item.text, { gfm: true });
      // Reference definitions cannot resolve across independent card components.
      if (Object.keys(tokens.links || {}).length) return null;
      let pending = '';
      for (const token of tokens) {
        if (token.type !== 'table') {
          pending += token.type === 'code' ? token.raw : cardMentions(token.raw, parser);
          continue;
        }
        if (++tableCount > 5 || token.header.length > 50 || !token.rows.length) return null;
        markdown(pending); pending = '';
        elements.push(nativeTable(token, parser));
      }
      markdown(pending);
    } else if (item.tag === 'img') {
      elements.push({ tag: 'img', img_key: item.image_key, alt: { tag: 'plain_text', content: '图片' } });
    } else if (item.tag === 'code_block') {
      const fence = '`'.repeat(Math.max(3, ...Array.from(item.text.matchAll(/`+/g), match => match[0].length + 1)));
      markdown(`${fence}${(item.language || '').toLowerCase()}\n${item.text}\n${fence}`);
    } else if (item.tag === 'text') {
      markdown(item.text.replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, '\\$&'));
    } else return null;
  }
  if (!tableCount || elements.length > 100) return null;
  const content = JSON.stringify({ schema: '2.0', config: { width_mode: 'fill' }, body: { elements } });
  // Leave headroom under the IM card payload limit; never truncate a reply.
  return Buffer.byteLength(content) <= 28_000 ? content : null;
}

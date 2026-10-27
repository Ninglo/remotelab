import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function rule(css, selector) {
  const start = css.indexOf(selector + ' {');
  if (start < 0) throw Error('Missing sidebar rule: ' + selector);
  const open = css.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; end < css.length && depth; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
  }
  if (depth) throw Error('Incomplete sidebar rule: ' + selector);
  return css.slice(start, end);
}

export async function buildTopicLabels() {
  const [base, sidebar, template] = await Promise.all([
    readFile(new URL('../static/chat/chat-base.css', import.meta.url), 'utf8'),
    readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8'),
    readFile(new URL('../static/feishu-topic-labels.js', import.meta.url), 'utf8'),
  ]);
  const variables = selector => [...rule(base, selector).matchAll(/--(?:text|text-muted|success|waiting|warning):[^;]+;/g)].map(match => match[0]).join('\n');
  const selectors = ['.session-item-title-row', '.session-item-name', '.session-row-status', '.session-status-dot',
    '.session-row-status.status-running', '.session-row-status.status-running .session-status-dot',
    '.session-row-status.status-waiting', '.session-row-status.status-waiting .session-status-dot',
    '.session-row-status.status-unread', '.session-row-status.status-unread .session-status-dot'];
  let css = `.rlfe-feed-headline{${variables(':root')}}\n` +
    `@media (prefers-color-scheme: dark){.rlfe-feed-headline{${variables(':root:not([data-theme="light"])')}}}\n` +
    selectors.map(selector => rule(sidebar, selector)).join('\n') + '\n' + rule(base, '@keyframes pulse');
  for (const [from, to] of [['session-item-title-row', 'rlfe-feed-headline'], ['session-item-name', 'rlfe-feed-name'],
    ['session-row-status', 'rlfe-feed-status'], ['session-status-dot', 'rlfe-status-dot']]) css = css.replaceAll(from, to);
  css = css.replaceAll('--text', '--rlfe-web-text').replaceAll('--success', '--rlfe-web-success')
    .replaceAll('--waiting', '--rlfe-web-waiting').replaceAll('--warning', '--rlfe-web-warning').replaceAll('pulse', 'rlfe-web-pulse');
  return template.replace('/*__REMOTELAB_TOPIC_CSS__*/ ""', JSON.stringify(css));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw Error('Pass output topic-labels.js path');
  await writeFile(process.argv[2], await buildTopicLabels());
}

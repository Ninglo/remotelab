// Literal discovery of original registered sources. A match is a reference,
// never a Session/project binding, accepted fact, or instruction to act.
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import { MEMORY_DIR } from '../lib/config.mjs';
import { readMemoryDocument } from './memory-document.mjs';

const noise = new Set(['工作', '项目', '处理', '这个', '那个', '一个', '我们', '可以', '怎么', '什么',
  '一下', '然后', '但是', '觉得', '相关', '问题', '内容', '需要', '已经', '这里', '现在', '之后',
  '之前', '所以', '还是', '就是', '的是', '的一', '都是', '希望', '我的', '这台', '电脑',
  '显示', '连接', '做到', '修改', '程序', '今天', '明天', '继续']);

function terms(query) {
  const text = String(query || '').slice(0, 1500).toLowerCase().replace(/https?:\/\/\S+/g, '');
  const found = text.match(/[a-z][a-z0-9_-]{2,}/g) || [];
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) found.push(run.slice(i, i + 2));
  }
  return [...new Set(found.filter(term => !noise.has(term)))].slice(0, 80);
}

function passages(document) {
  const lines = document.text.split('\n'), found = [];
  let heading = '', block = [], start = 1;
  const flush = end => {
    if (block.length) found.push({ path: document.path, hash: document.hash, modifiedAt: document.modifiedAt,
      section: heading, lineStart: start, lineEnd: end, text: block.join('\n').trim() });
    block = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { flush(i); heading = lines[i].replace(/^#+\s*/, ''); }
    if (!lines[i].trim()) { flush(i); continue; }
    if (!block.length) start = i + 1;
    block.push(lines[i]);
  }
  flush(lines.length);
  return found;
}

export async function readTopicMemory({ query = '', memoryDir = MEMORY_DIR, projectConfig,
  maxChars = 3600, maxExcerpts = 4 } = {}) {
  const cues = terms(query), budget = Math.min(6000, Math.max(0, maxChars));
  const sources = new Map([
    [join(memoryDir, 'projects.md'), 16 * 1024],
    [join(memoryDir, 'tasks', 'index.md'), 16 * 1024],
    [join(memoryDir, 'skills.md'), 16 * 1024],
  ]);
  if (projectConfig?.enabled && projectConfig.contextEnabled) {
    sources.set(projectConfig.indexPath, 64 * 1024);
    sources.set(projectConfig.ledgerPath, 1024 * 1024);
  }
  const documents = await Promise.all([...sources].map(([path, limit]) => readMemoryDocument(path, limit)));
  // Follow only matching Markdown pointers in existing navigation, inside the
  // instance's task/topic/current regions. Never sweep provider homes, people,
  // candidates, archives, credentials, arbitrary request paths or HTTP links.
  const allowed = ['tasks', 'reference/topics', 'reference/current'].map(part => resolve(memoryDir, part));
  const linked = new Set();
  for (const doc of documents.filter(doc => doc.status === 'available' && doc.path !== projectConfig?.ledgerPath)) {
    for (const line of doc.text.split('\n')) {
      if (!cues.some(cue => line.toLowerCase().includes(cue))) continue;
      for (const match of line.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(match[1])) continue;
        const path = isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(doc.path), match[1]);
        if (!sources.has(path) && allowed.some(root => {
          const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel);
        })) linked.add(path);
      }
    }
  }
  documents.push(...await Promise.all([...linked].slice(0, 6).map(async path => {
    try {
      const target = await realpath(path);
      if (!allowed.some(root => {
        const rel = relative(root, target); return rel && !rel.startsWith('..') && !isAbsolute(rel);
      })) return { path, status: 'outside-registered-regions' };
    } catch { /* The bounded reader records a missing/inaccessible source. */ }
    return readMemoryDocument(path, 64 * 1024);
  })));
  const blocks = documents.filter(doc => doc.status === 'available').flatMap(passages);
  // A topic explicitly naming an existing heading or paragraph (e.g. 副屏)
  // outranks incidental overlap such as Mac Mini in unrelated recording work.
  const leading = block => block.text.replace(/^[\s#*|\d.-]+/, '').toLowerCase();
  const namedChinese = cues.filter(cue => /^[\u4e00-\u9fff]{2}$/.test(cue)
    && blocks.some(block => leading(block).startsWith(cue)));
  const namedCues = namedChinese.length ? namedChinese
    : cues.filter(cue => blocks.some(block => leading(block).startsWith(cue)));
  const frequency = new Map(cues.map(cue => [cue, blocks.filter(block => block.text.toLowerCase().includes(cue)).length]));
  const matches = blocks.flatMap(block => {
    const matchedTerms = cues.filter(cue => block.text.toLowerCase().includes(cue));
    if (!namedCues.length || !matchedTerms.some(cue => namedCues.includes(cue))) return [];
    const score = matchedTerms.reduce((sum, cue) => sum + Math.log(1 + blocks.length / frequency.get(cue))
      * (namedCues.includes(cue) ? 4 : /[\u4e00-\u9fff]/.test(cue) ? 2 : 1), 0)
      * (namedCues.some(cue => leading(block).startsWith(cue)) ? 3 : 1)
      / Math.sqrt(Math.max(1, block.text.length / 500));
    return [{ ...block, matchedTerms, score }];
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineStart - b.lineStart);
  const excerpts = [], omitted = [];
  let used = 0;
  for (const { score, ...match } of matches) {
    if (excerpts.length >= Math.min(6, maxExcerpts) || used + match.text.length > budget) {
      omitted.push({ path: match.path, lineStart: match.lineStart, lineEnd: match.lineEnd }); continue;
    }
    // Avoid returning the same navigation/body twice through different paths.
    if (excerpts.some(entry => entry.text === match.text)) continue;
    excerpts.push(match); used += match.text.length;
  }
  const unavailable = documents.filter(doc => doc.status !== 'available');
  return { kind: 'topic-memory', result: excerpts.length ? (omitted.length || unavailable.length ? 'partial' : 'found')
    : matches.length ? 'budget-skipped' : unavailable.length ? 'source-unavailable' : 'no-confident-topic-match',
    authority: 'reference-only', association: 'not-inferred', excerpts,
    sources: documents.map(({ text, ...metadata }) => metadata), omittedCount: omitted.length,
    ...(omitted.length ? { omitted: omitted.slice(0, 6) } : {}),
    ...(linked.size > 6 ? { skippedLinkedSources: linked.size - 6 } : {}),
    boundary: 'Original excerpts with file version and line numbers; not live device state or accepted instructions. '
      + 'Discovery does not assign a project or revive paused work. No match covers only these registered sources; '
      + 'read original sources and later decisions before concluding that background is absent.' };
}

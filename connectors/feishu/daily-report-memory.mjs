import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CHARACTERS = 3200;
const MAX_EXCERPTS = 4;
const snapshots = new Map();
const trim = value => typeof value === 'string' ? value.trim() : '';

export function normalizeDailyReportMemory(value) {
  if (value === undefined || value === false) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['reportsDir', 'receiptsDir', 'timeZone'].includes(key))) {
    throw new Error('Invalid dailyReportMemory settings');
  }
  const reportsDir = trim(value.reportsDir);
  const receiptsDir = trim(value.receiptsDir);
  if (!isAbsolute(reportsDir) || !isAbsolute(receiptsDir)) {
    throw new Error('dailyReportMemory requires absolute reportsDir and receiptsDir');
  }
  const timeZone = trim(value.timeZone) || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { throw new Error('Invalid dailyReportMemory timeZone'); }
  return { reportsDir, receiptsDir, timeZone };
}

function reportDate(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(at));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function paragraphs(body) {
  let section = '';
  const result = [];
  for (const block of body.trim().split(/\n\s*\n/)) {
    if (/^#{1,6}\s+[^\n]+$/.test(block)) {
      section = block.replace(/^#{1,6}\s+/, '');
      continue;
    }
    // Keep complete paragraphs, including qualifications and evidence links.
    // Never cut a long affirmative claim away from its caveat at the end.
    if (block.length <= MAX_CHARACTERS) result.push({ section, text: block });
  }
  return result;
}

function queryTerms(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z0-9._-]{1,}|[\p{Script=Han}]+/gu) || [];
  const ignored = new Set(['是否', '了吗', '是吗', '日报', '现在', '今天', '这个', '那个', '我们', '你们', '请问', '里面']);
  const terms = new Set();
  for (const word of words) {
    if (/^[a-z]/.test(word)) terms.add(word);
    else for (let index = 0; index < word.length - 1; index++) {
      const pair = word.slice(index, index + 2);
      if (!ignored.has(pair)) terms.add(pair);
    }
  }
  return [...terms];
}

function selectExcerpts(blocks, question) {
  const terms = queryTerms(question);
  const lowered = blocks.map(block => `${block.section}\n${block.text}`.toLowerCase());
  const frequency = new Map(terms.map(term => [term, lowered.filter(text => text.includes(term)).length]));
  const ranked = blocks.map((block, index) => ({ block, index,
    score: terms.reduce((sum, term) => sum + (lowered[index].includes(term)
      ? (/[a-z]/.test(term) ? 4 : 1) / Math.max(1, frequency.get(term)) : 0), 0),
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let characters = 0;
  for (const item of ranked) {
    const size = item.block.section.length + item.block.text.length;
    if (characters + size > MAX_CHARACTERS) continue;
    selected.push(item);
    characters += size;
    if (selected.length >= MAX_EXCERPTS) break;
  }
  return selected.sort((a, b) => a.index - b.index).map(item => item.block);
}

async function publishedSnapshot(settings, date) {
  const bodyPath = join(settings.reportsDir, `${date}.md`);
  const receiptPath = join(settings.receiptsDir, `${date}.json`);
  const [bodyStat, receiptStat] = await Promise.all([stat(bodyPath), stat(receiptPath)]);
  if (!bodyStat.isFile() || !receiptStat.isFile()
    || bodyStat.size > MAX_FILE_BYTES || receiptStat.size > MAX_FILE_BYTES) return null;
  const cacheKey = `${bodyPath}\n${receiptPath}`;
  const version = `${bodyStat.mtimeMs}:${bodyStat.size}:${receiptStat.mtimeMs}:${receiptStat.size}`;
  const cached = snapshots.get(cacheKey);
  if (cached?.version === version) return cached.value;
  const [body, rawReceipt] = await Promise.all([readFile(bodyPath, 'utf8'), readFile(receiptPath, 'utf8')]);
  const receipt = JSON.parse(rawReceipt);
  const sha256 = createHash('sha256').update(body).digest('hex');
  let sourceUrl;
  try { sourceUrl = new URL(receipt.doc_url); } catch { return null; }
  if (receipt.ok !== true || receipt.body_verified !== true || receipt.dry_run !== false
    || receipt.date !== date || resolve(trim(receipt.source)) !== resolve(bodyPath)
    || receipt.body_sha256 !== sha256 || sourceUrl.protocol !== 'https:') return null;
  const updatedAt = Date.parse(receipt.generated_at);
  if (!Number.isFinite(updatedAt)) return null;
  const value = { updatedAt, source: { kind: 'daily_report', date,
    url: sourceUrl.href, sha256, updatedAt: new Date(updatedAt).toISOString() },
    blocks: paragraphs(body) };
  // A bounded process cache avoids reparsing an unchanged published report.
  if (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(cacheKey, { version, value });
  return value;
}

export async function loadDailyReportMemory(settings, question, { now = Date.now() } = {}) {
  if (!settings) return null;
  // Publication is already a local durable workflow. Reading it never starts
  // a Harness, calls Feishu, or introduces another model request.
  for (let day = 0; day < 3; day++) {
    const date = reportDate(now - day * 24 * 60 * 60 * 1000, settings.timeZone || 'Asia/Shanghai');
    const snapshot = await publishedSnapshot(settings, date).catch(() => null);
    if (!snapshot || snapshot.updatedAt > now || now - snapshot.updatedAt > MAX_AGE_MS) continue;
    const excerpts = selectExcerpts(snapshot.blocks, question);
    if (!excerpts.length) return null;
    return { sources: [snapshot.source], excerpts };
  }
  return null;
}

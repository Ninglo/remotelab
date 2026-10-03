// Receives projected evidence only. No production paths, credentials or model calls.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const idPattern = /^[a-z0-9_-]{1,80}$/;
const job = JSON.parse(await readFile('/input/corpus.json', 'utf8'));
if (job.schemaVersion !== 1 || job.stage !== 'isolated-test' || !Array.isArray(job.projects)
    || !Array.isArray(job.sources) || !Array.isArray(job.records) || job.records.length > 20000
    || job.projects.length > 128 || job.sources.length > 256) throw new Error('Invalid or oversized corpus.');
const projects = new Map();
for (const p of job.projects) {
  if (!idPattern.test(p.id) || projects.has(p.id) || typeof p.title !== 'string') throw new Error('Invalid project registry.');
  projects.set(p.id, p);
}
const sources = new Map();
for (const s of job.sources) {
  if (!idPattern.test(s.id) || sources.has(s.id) || !Array.isArray(s.projectIds)
      || s.projectIds.some(id => !projects.has(id)) || typeof s.coverage !== 'string') throw new Error('Invalid source coverage.');
  sources.set(s.id, s);
}
const output = '/output';
const lock = join(output, '.update-lock');
await mkdir(lock, { mode: 0o700 });
try {
  let previous = { revision: 0, fingerprint: '', entries: [] };
  let name;
  try { name = (await readFile(join(output, 'CURRENT'), 'utf8')).trim(); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (name !== undefined) {
    if (!/^generation-[0-9]+-[a-f0-9-]+$/.test(name)) throw new Error('Invalid current generation.');
    previous = JSON.parse(await readFile(join(output, name, 'state.json'), 'utf8'));
    if (!Number.isSafeInteger(previous.revision) || !Array.isArray(previous.entries)) throw new Error('Corrupt current state.');
  }
  if (job.expectedRevision !== undefined && job.expectedRevision !== previous.revision) throw new Error('Stale expected revision.');
  const items = new Map();
  let duplicates = 0;
  const oldByKey = new Map(previous.entries.map(e => [e.evidenceKey, e]));
  const seenKeys = new Map();
  for (const record of job.records) {
    if (!sources.has(record.sourceId) || typeof record.evidenceKey !== 'string' || !record.evidenceKey
        || typeof record.text !== 'string' || record.text.length > 40000 || !Array.isArray(record.projectIds)) throw new Error('Invalid evidence record.');
    const hash = sha(record.text);
    if (seenKeys.has(record.evidenceKey) && seenKeys.get(record.evidenceKey) !== hash) throw new Error('Conflicting representations of one evidence key; resolve in capture.');
    seenKeys.set(record.evidenceKey, hash);
    const id = sha(record.evidenceKey + '\n' + hash).slice(0, 32);
    const projectIds = [...new Set(record.projectIds.filter(p => projects.has(p)))].sort();
    if (items.has(id)) {
      duplicates++;
      const item = items.get(id);
      item.projectIds = [...new Set([...item.projectIds, ...projectIds])].sort();
      item.sourceIds = [...new Set([...item.sourceIds, record.sourceId])].sort();
      continue;
    }
    const old = oldByKey.get(record.evidenceKey);
    const unchanged = old?.contentHash === hash;
    const version = unchanged ? old.version : (old?.version || 0) + 1;
    const item = {
      id, evidenceKey: record.evidenceKey, contentHash: hash, version,
      projectIds, sourceIds: [record.sourceId], text: record.text,
      kind: record.kind || 'source-report', actor: record.actor || '身份待核',
      occurredAt: record.occurredAt || null, observedAt: record.observedAt || null,
      sourceRef: record.sourceRef || null, representation: record.representation || 'original-text',
      lineageKey: record.lineageKey || record.evidenceKey,
      associationStatus: record.associationStatus || 'registered-source',
      confirmation: 'pending', businessState: 'unclassified',
      supersedes: unchanged ? old.supersedes : old ? [old.id] : [],
    };
    items.set(id, item);
  }
  const entries = [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
  const unassigned = entries.filter(e => !e.projectIds.length).map(e => e.id);
  const fingerprint = sha(JSON.stringify({ projects: job.projects, sources: job.sources, entries, inventory: job.inventory || {}, workerHash: job.workerHash || null }));
  if (fingerprint === previous.fingerprint) {
    console.log(JSON.stringify({ ok: true, unchanged: true, revision: previous.revision, entries: entries.length, duplicates }));
  } else {
    const revision = previous.revision + 1;
    const generation = 'generation-' + revision + '-' + randomUUID();
    const dir = join(output, generation);
    await mkdir(dir, { mode: 0o700 });
    const state = { schemaVersion: 1, revision, fingerprint, projects: job.projects, sources: job.sources, entries, unassigned,
      inventory: job.inventory || {}, capturedAt: job.capturedAt, workerHash: job.workerHash || null, phase: 'isolated-test', humanAccepted: false };
    await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    let report = '# 项目记忆治理 · 测试日报\n\n';
    report += '这是测试信息底稿，尚未获得职责认可，不代表正式共识。原始说法、既有主账报告和 Agent 判断保留各自性质；本工具不判定业务已完成。\n\n';
    report += `本轮登记 ${projects.size} 个项目／子项／保留主题，读取 ${sources.size} 个来源投影，去重后 ${entries.length} 条材料。登记范围不等于已证明全组织完整；缺口如下。\n\n`;
    report += '## 覆盖与缺口\n\n';
    for (const s of job.sources) report += `- ${s.title || s.id}：${s.coverage}；截止 ${s.cutoff || '未知'}。选入 ${s.selected ?? '未知'} 条，窗口外／无可读正文／超长遗漏 ${s.omitted ?? '未知'} 条。${s.gap || ''}\n`;
    report += `\n待归属条目 ${unassigned.length} 条；元数据清点 ${JSON.stringify(job.inventory || {})}。\n\n`;
    for (const p of job.projects) {
      const relevant = entries.filter(e => e.projectIds.includes(p.id));
      report += `## ${p.title}\n\n登记性质：${p.category || '待核'}；范围依据：${p.basis || '待核'}；职责：${p.roles || '负责人、相关个人与验收人待登记'}。\n\n`;
      report += `当前汇入 ${relevant.length} 条材料。\n\n`;
      const ledger = relevant.filter(e => e.kind === 'existing-ledger');
      for (const e of ledger) report += `### 既有认识（转引，未独立复验）\n\n${e.text}\n\n来源条目 ${e.id} / v${e.version}；${e.sourceRef || e.evidenceKey}。\n\n`;
      if (!ledger.length) report += '暂无独立维护的项目认识；不能据此判断项目没有推进。\n\n';
      const latest = relevant.filter(e => e.kind !== 'existing-ledger').sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, 5);
      report += '### 最近来源片段（供核对，未自动转成结论）\n\n';
      for (const e of latest) report += `- ${e.actor} / ${e.occurredAt || '事件时间待核'} / ${e.kind}：${e.text.slice(0, 1000).replace(/\n/g,' ')}${e.text.length > 1000 ? '〔展示节选；完整文本在原条目〕' : ''}〔${e.id} / v${e.version}〕\n`;
      report += '\n';
    }
    report += '## 组织观察\n\n方法候选、重复工作和优先级建议由 Harness 基于原始材料核对后提出；原始材料数量不代表贡献或项目进度。当前底稿不自动排名、不推送、不执行任务。\n';
    await writeFile(join(dir, 'report.md'), report, { mode: 0o600, flag: 'wx' });
    const next = join(output, 'CURRENT.' + randomUUID() + '.next');
    await writeFile(next, generation + '\n', { mode: 0o600, flag: 'wx' });
    await rename(next, join(output, 'CURRENT'));
    console.log(JSON.stringify({ ok: true, unchanged: false, revision, projects: projects.size, sources: sources.size, entries: entries.length, duplicates, unassigned: unassigned.length, generation, humanAccepted: false }));
  }
} finally { await rm(lock, { recursive: true, force: true }); }

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const START = '<!-- remotelab-learning:start -->';
const END = '<!-- remotelab-learning:end -->';
const POINTER = /<!-- remotelab-handbook-store:([a-f0-9-]{36}) -->/;
const ARRAYS = ['evidence', 'history', 'counterexamples', 'outcomes'];
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function regular(path, maxBytes = Infinity) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Handbook must be a bounded regular file');
  return readFile(path, 'utf8');
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory()) throw new Error(`Handbook directory is not a regular directory: ${path}`);
}

async function atomic(path, raw) {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, raw, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

// One atomic current record is the commit point for one method. Its archive is
// immutable and written first. Old readers may finish using the previous head.
// No archived version is deleted, and routine reads never traverse the archive.
async function immutable(path, raw) {
  try { await writeFile(path, raw, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await regular(path) !== raw) throw new Error('Handbook immutable object mismatch');
  }
}

function envelope(raw) {
  const match = raw.match(POINTER);
  if (!match) return null;
  const start = raw.indexOf(START), end = raw.indexOf(END);
  if (start < 0 || end < start || match.index < start || match.index > end
    || raw.indexOf(START, start + START.length) >= 0 || raw.indexOf(END, end + END.length) >= 0
    || raw.match(/remotelab-handbook-store:/g)?.length !== 1) throw new Error('Malformed handbook store pointer');
  return { prefix: raw.slice(0, start), suffix: raw.slice(end + END.length), generation: match[1] };
}

async function storeFor(path, generation, create = false) {
  const base = `${path}.store`;
  await directory(base, create);
  const root = join(base, generation);
  await directory(root, create);
  for (const part of ['current', 'objects']) await directory(join(root, part), create);
  return root;
}

function currentPath(root, id) {
  if (!/^mem_[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw new Error('Invalid handbook entry ID');
  return join(root, 'current', `${id}.json`);
}

function objectPath(root, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid handbook archive reference');
  return join(root, 'objects', `${digest}.json`);
}

function summary(entry, head) {
  const { history, evidence, counterexamples, outcomes, ...fields } = entry;
  return { format: 2, head, entry: { ...fields,
    evidence: (evidence || []).slice(-4), counterexamples: (counterexamples || []).slice(-2),
    history: [], outcomes: [],
    archiveCounts: Object.fromEntries(ARRAYS.map(key => [key, (entry[key] || []).length])),
    independentSessions: new Set((evidence || []).map(e => e.sessionId)).size } };
}

async function readCurrent(root, id) {
  const raw = await regular(currentPath(root, id), 256 * 1024);
  const record = JSON.parse(raw);
  if (record.format !== 2 || record.entry?.id !== id || !/^[a-f0-9]{64}$/.test(record.head || '')
    || !Number.isInteger(record.entry.version)) throw new Error('Invalid handbook current record');
  return record;
}

async function hydrate(root, record) {
  const chain = [], visited = new Set();
  let digest = record.head;
  while (digest) {
    if (visited.has(digest)) throw new Error('Cyclic handbook archive');
    visited.add(digest);
    const raw = await regular(objectPath(root, digest));
    if (hash(raw) !== digest) throw new Error('Handbook archive checksum mismatch');
    const node = JSON.parse(raw);
    if (node.format !== 2) throw new Error('Unsupported handbook archive');
    chain.push(node);
    digest = node.parent;
  }
  let entry;
  for (const node of chain.reverse()) {
    if (node.value) entry = node.value;
    else {
      if (!entry || !node.fields || !node.arrays) throw new Error('Incomplete handbook archive');
      const next = { ...node.fields };
      for (const key of ARRAYS) {
        const delta = node.arrays[key];
        if (delta?.append) {
          next[key] = entry[key] || [];
          for (const item of delta.append) next[key].push(item);
        }
        else if (delta && Object.hasOwn(delta, 'replace')) next[key] = delta.replace;
      }
      entry = next;
    }
  }
  if (!entry || !equal(summary(entry, record.head), record)) throw new Error('Handbook current/archive mismatch');
  return entry;
}

function revision(entry, previous, parent) {
  if (!previous) return { format: 2, parent: null, value: entry };
  const fields = { ...entry }, arrays = {};
  for (const key of ARRAYS) {
    delete fields[key];
    if (!Object.hasOwn(entry, key)) continue;
    const before = previous[key], after = entry[key];
    arrays[key] = Array.isArray(before) && Array.isArray(after) && before.length <= after.length
      && before.every((item, i) => equal(item, after[i]))
      ? { append: after.slice(before.length) } : { replace: after };
  }
  return { format: 2, parent, fields, arrays };
}

async function saveEntry(root, entry, previous, parent) {
  const raw = JSON.stringify(revision(entry, previous, parent));
  const head = hash(raw);
  await immutable(objectPath(root, head), raw);
  await atomic(currentPath(root, entry.id), JSON.stringify(summary(entry, head)));
}

export async function readHandbook(path, { parseLegacy, details = false, entryId, key, legacyLimit = 2 * 1024 * 1024 } = {}) {
  let raw;
  try { raw = await regular(path, legacyLimit); }
  catch (error) { if (error.code === 'ENOENT') raw = ''; else throw error; }
  const pointer = envelope(raw);
  if (!pointer) {
    const document = parseLegacy(raw);
    if (key) document.entries = document.entries.filter(e => e.key === key || e.id === key);
    return { ...document, raw };
  }
  const root = await storeFor(path, pointer.generation);
  const ids = entryId ? [entryId] : (await readdir(join(root, 'current')))
    .filter(name => name.endsWith('.json')).sort().map(name => name.slice(0, -5));
  const entries = [], records = new Map(), originals = new Map();
  let currentBytes = 0;
  // Read in filesystem batches; archive hydration is only requested by inspect,
  // export or mutation of the one target. There is no aggregate 2 MiB ceiling.
  for (let offset = 0; offset < ids.length; offset += 64) {
    const batch = await Promise.all(ids.slice(offset, offset + 64).map(async id => {
      try { return await readCurrent(root, id); }
      catch (error) { if (entryId && error.code === 'ENOENT') return null; throw error; }
    }));
    for (const record of batch.filter(Boolean)) {
      if (key && record.entry.key !== key && record.entry.id !== key) continue;
      records.set(record.entry.id, record);
      currentBytes += Buffer.byteLength(JSON.stringify(record));
      const entry = details || entryId ? await hydrate(root, record) : record.entry;
      if (entryId) originals.set(entry.id, structuredClone(entry));
      entries.push(entry);
    }
  }
  return { ...pointer, managed: true, entries, raw, storage: { format: 2,
    entries: records.size, currentBytes, selectedKey: key || entryId || null,
    archiveCounts: Object.fromEntries(ARRAYS.map(name => [name,
      [...records.values()].reduce((count, record) => count + (record.entry.archiveCounts[name] || 0), 0)])) },
  store: { root, records, originals } };
}

export async function commitHandbook(path, document, entry) {
  const oldRecord = document.store.records.get(entry.id);
  // The caller holds the shared learning lock. Also detect unsupported external
  // edits instead of replacing them silently.
  if (await regular(path, 2 * 1024 * 1024) !== document.raw) throw new Error('Memory changed concurrently; retry from current version');
  if (oldRecord && !equal(await readCurrent(document.store.root, entry.id), oldRecord)) {
    throw new Error('Handbook changed concurrently; retry from current version');
  }
  if (!oldRecord) {
    try {
      await lstat(currentPath(document.store.root, entry.id));
      throw new Error('Handbook entry appeared concurrently; retry from current version');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const previous = document.store.originals.get(entry.id);
  if (oldRecord && !previous) throw new Error('Handbook update requires the original target entry');
  await saveEntry(document.store.root, entry, previous, oldRecord?.head);
}

// Called under the same cross-process learning lock as normal updates. The only
// relaxed legacy limit belongs to this explicit, one-time conversion operation.
export async function migrateHandbook(path, { parseLegacy, maxLegacyBytes = 64 * 1024 * 1024 } = {}) {
  const raw = await regular(path, maxLegacyBytes);
  const existing = envelope(raw);
  if (existing) return { changed: false, path, format: 2, generation: existing.generation };
  const document = parseLegacy(raw);
  const ids = new Set();
  for (const entry of document.entries) {
    if (entry.kind !== 'method' || ids.has(entry.id)) throw new Error('Invalid or duplicate method in legacy handbook');
    ids.add(entry.id);
  }
  const generation = randomUUID();
  const root = await storeFor(path, generation, true);
  await immutable(join(root, 'legacy.md'), raw);
  for (const entry of document.entries) await saveEntry(root, entry);
  // Verify every original entry before publishing the directory pointer.
  for (const entry of document.entries) {
    if (!equal(await hydrate(root, await readCurrent(root, entry.id)), entry)) throw new Error('Handbook migration round-trip mismatch');
  }
  if (await regular(path, maxLegacyBytes) !== raw) throw new Error('Memory changed concurrently; retry migration');
  const intro = `${document.prefix}${document.managed ? '' : '\n\n'}${START}
## Agent 行动手册

当前方法按条目保存在相邻的 \`agent-handbook.md.store/${generation}/current/\`；历史和原始证据保存在同目录的 \`objects/\`。受管理文件请通过 memory 命令维护。

- 按场景读取：\`remotelab memory context --query <任务关键词> --json\`
- 浏览当前条目：\`remotelab memory inspect --summary --json\`
- 追溯一个方法：\`remotelab memory inspect --key <key或ID> --json\`
- 完整导出：\`remotelab memory handbook-export --file <新文件.md> --json\`

原文件逐字备份在 \`${root}/legacy.md\`。撤销、反例、条件与版本继续沿用原语义；检索交付不代表实际采用或效果。

<!-- remotelab-handbook-store:${generation} -->
${END}${document.suffix || '\n'}`;
  if (Buffer.byteLength(intro) > 2 * 1024 * 1024) throw new Error('Handbook manual text exceeds the entry-point limit; original preserved');
  await atomic(path, intro);
  return { changed: true, path, format: 2, generation, entries: ids.size,
    backup: join(root, 'legacy.md'), sourceSha256: hash(raw), sourceBytes: Buffer.byteLength(raw) };
}

export async function exportHandbook(path, { parseLegacy, renderLegacy, file, rollback = false } = {}) {
  const document = await readHandbook(path, { parseLegacy, details: true });
  const raw = document.store ? renderLegacy(document) : document.raw;
  if (rollback) {
    if (await regular(path, 2 * 1024 * 1024) !== document.raw) throw new Error('Memory changed concurrently; retry export');
    await atomic(path, raw);
  } else {
    if (!file || file === path) throw new Error('Export requires a new destination file');
    await writeFile(file, raw, { mode: 0o600, flag: 'wx' });
  }
  return { path: rollback ? path : file, entries: document.entries.length, bytes: Buffer.byteLength(raw),
    sha256: hash(raw), format: 1, ...(rollback ? { warning: 'Legacy readers still have their original size limit. Store and backup retained.' } : {}) };
}

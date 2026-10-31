import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { appendFile, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createKeyedTaskQueue } from '../chat/fs-utils.mjs';

const DAY = 86400_000;
const queue = createKeyedTaskQueue();
const initialized = new Map(), cleaned = new Map();
const day = time => new Date(time).toISOString().slice(0, 10);
const datedPath = (path, date, legacy = false) => path.replace(/\.jsonl$/, '') + `.${date}${legacy ? '.legacy' : ''}.jsonl`;

// The deployment migration runs with the old writer stopped. Ordinary startup
// never parses the old unbounded log; an unmigrated writer fails explicitly.
export function initializeFeishuEventLog(pathname) {
  if (!initialized.has(pathname)) initialized.set(pathname, stat(pathname).then(() => {
    throw new Error(`Migrate legacy event log before starting the connector: ${pathname}`);
  }, error => { if (error.code !== 'ENOENT') throw error; }).catch(error => {
    initialized.delete(pathname); throw error;
  }));
  return initialized.get(pathname);
}

export async function migrateFeishuEventLog(pathname, now = Date.now()) {
  let source;
  try { source = await open(pathname, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return { migrated: false }; throw error; }
  const original = await source.stat(), shards = new Map();
  const cutoff = day(now - 29 * DAY);
  let retained = 0, expired = 0, unparsed = 0;
  try {
    const lines = createInterface({ input: source.createReadStream({ autoClose: false }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        let date = day(now);
        try {
          const received = Date.parse(JSON.parse(line).receivedAt);
          if (Number.isFinite(received)) date = day(received); else unparsed++;
        } catch { unparsed++; } // Preserve undated/torn evidence in today's shard.
        if (date < cutoff) { expired++; continue; }
        if (!shards.has(date)) {
          const target = datedPath(pathname, date, true);
          const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
          shards.set(date, { target, temporary, file: await open(temporary, 'wx', 0o600) });
        }
        await shards.get(date).file.write(line + '\n'); retained++;
      }
    } finally { lines.close(); }
    const after = await stat(pathname);
    if (after.ino !== original.ino || after.size !== original.size || after.mtimeMs !== original.mtimeMs)
      throw new Error('Legacy event log changed during migration; stop its writer before retrying');
    for (const shard of shards.values()) { await shard.file.sync(); await shard.file.close(); }
    for (const shard of shards.values()) await rename(shard.temporary, shard.target);
    const directory = await open(dirname(pathname), 'r');
    try { await directory.sync(); await unlink(pathname); await directory.sync(); }
    finally { await directory.close(); }
    initialized.delete(pathname);
    return { migrated: true, retained, expired, unparsed, days: shards.size };
  } finally {
    await source.close();
    for (const shard of shards.values()) {
      await shard.file.close().catch(() => {});
      await unlink(shard.temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

export async function pruneFeishuEventLog(pathname, now = Date.now()) {
  const prefix = basename(pathname).replace(/\.jsonl$/, '') + '.';
  let names;
  try { names = await readdir(dirname(pathname)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const cutoff = day(now - 29 * DAY);
  for (const name of names) {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    if (/^\d{4}-\d{2}-\d{2}(\.legacy)?\.jsonl$/.test(suffix) && suffix.slice(0, 10) < cutoff)
      await unlink(join(dirname(pathname), name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function appendFeishuEvent(pathname, value, { now = Date.now() } = {}) {
  return queue(pathname, async () => {
    await mkdir(dirname(pathname), { recursive: true });
    await initializeFeishuEventLog(pathname);
    await appendFile(datedPath(pathname, day(now)), JSON.stringify(value) + '\n', { mode: 0o600 });
    if (cleaned.get(pathname) !== day(now)) {
      await pruneFeishuEventLog(pathname, now); cleaned.set(pathname, day(now));
    }
  });
}

// One chunk plus one line in memory. Decode only complete UTF-8 lines.
async function* reverseLines(pathname, onFile) {
  let file;
  try { file = await open(pathname, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  onFile?.(pathname);
  let tail = Buffer.alloc(0), position = (await file.stat()).size;
  try {
    while (position > 0) {
      const size = Math.min(position, 64 * 1024); position -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await file.read(chunk, 0, size, position);
      const buffer = Buffer.concat([chunk.subarray(0, bytesRead), tail]);
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i--) if (buffer[i] === 10) {
        if (i + 1 < end) yield buffer.subarray(i + 1, end).toString('utf8');
        end = i;
      }
      tail = Buffer.from(buffer.subarray(0, end));
    }
    if (tail.length) yield tail.toString('utf8');
  } finally { await file.close(); }
}

// Startup defaults to today/yesterday. Explicit historical replay can request
// the retained 30 days. Readers never enumerate the history directory.
export async function* readFeishuEvents(pathname, { now = Date.now(), days = 2, since = now - 2 * DAY, onInvalidLine = () => {}, onFile = () => {} } = {}) {
  const files = [];
  for (let i = 0; i < days; i++) files.push(datedPath(pathname, day(now - i * DAY)), datedPath(pathname, day(now - i * DAY), true));
  files.push(pathname); // read-only compatibility before the first writer upgrade
  for (const file of files) for await (const line of reverseLines(file, onFile)) {
    let record;
    try { record = JSON.parse(line); } catch { onInvalidLine(file); continue; } // tolerate a torn final append
    const received = Date.parse(record.receivedAt);
    if (Number.isFinite(received) && received < since) break;
    yield record;
  }
}

export async function readFeishuEventWindow(pathname, options) {
  const records = [];
  for await (const record of readFeishuEvents(pathname, options)) records.push(record);
  return records.reverse();
}

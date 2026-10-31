import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { initializeConnectorMessageIndex, findConnectorMessageIndexRecord, upsertConnectorMessageIndexRecord } from '../lib/connector-message-index.mjs';

const root = await mkdtemp(join(tmpdir(), 'index-migration-'));
const pathname = join(root, 'index.json');
const record = { connector: 'feishu', accountId: 'a', messageId: 'm', sessionId: 's', text: '汉字\\"\n', createdAt: 'old' };
const json = JSON.stringify({ records: { 'feishu:a:m': record } });
try {
  await writeFile(pathname, json);
  const script = `import { initializeConnectorMessageIndex } from ${JSON.stringify(new URL('../lib/connector-message-index.mjs', import.meta.url).href)}; await initializeConnectorMessageIndex(process.argv[1]);`;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, pathname]);
  await Promise.all([run(), run()]);
  assert.equal(await readFile(`${pathname}.readonly-backup`, 'utf8'), json);
  assert.equal((await stat(`${pathname}.readonly-backup`)).mode & 0o222, 0);
  assert.equal((await initializeConnectorMessageIndex(pathname)).count, 1);
  assert.deepEqual(await findConnectorMessageIndexRecord(pathname, record), record);
  const changed = await upsertConnectorMessageIndexRecord(pathname, { ...record, sessionId: 'new', createdAt: 'overwrite' });
  assert.equal(changed.createdAt, 'old'); assert.equal(changed.text, record.text);
  assert.equal(changed.sessionId, 'new');
  const db = new DatabaseSync(`${pathname}.sqlite`, { readOnly: true });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n, 1);
  assert.match(db.prepare("EXPLAIN QUERY PLAN SELECT value FROM records WHERE trim(coalesce(json_extract(value,'$.connector'),''))=? AND trim(coalesce(json_extract(value,'$.messageId'),''))=?").get('feishu', 'm').detail, /idx_connector_messageId/);
  db.close();
  const writer = `import { upsertConnectorMessageIndexRecord } from ${JSON.stringify(new URL('../lib/connector-message-index.mjs', import.meta.url).href)}; for (let i=0;i<20;i++) await upsertConnectorMessageIndexRecord(process.argv[1], {connector:'feishu',messageId:process.argv[2]+i,sessionId:'parallel'});`;
  await Promise.all(['a','b'].map(prefix => promisify(execFile)(process.execPath, ['--input-type=module','-e',writer,pathname,prefix])));
  for (const prefix of ['a','b']) for (let i=0;i<20;i++) assert.equal((await findConnectorMessageIndexRecord(pathname, {connector:'feishu',messageId:prefix+i})).sessionId,'parallel');
  const bad = join(root, 'corrupt.json');
  await writeFile(bad, json.slice(0, -1));
  await assert.rejects(initializeConnectorMessageIndex(bad), SyntaxError);
  const incomplete = new DatabaseSync(`${bad}.sqlite`);
  assert.equal(incomplete.prepare('SELECT count(*) AS n FROM records').get().n, 0, 'partial import rolls back');
  incomplete.close();
  assert.equal(await readFile(bad, 'utf8'), json.slice(0, -1));
  // Simulate interruption after rename, before SQLite commit: recover from backup.
  const interrupted = join(root, 'interrupted.json');
  await writeFile(`${interrupted}.readonly-backup`, json); await chmod(`${interrupted}.readonly-backup`, 0o444);
  assert.equal((await initializeConnectorMessageIndex(interrupted)).count, 1);
  // Simulate commit before rename from an earlier migration attempt.
  const committed = join(root, 'committed.json');
  // The source may still be in WAL, so use the normal backup API for a coherent copy.
  const { backup } = await import('node:sqlite');
  const source = new DatabaseSync(`${interrupted}.sqlite`); await backup(source, `${committed}.sqlite`); source.close();
  await writeFile(committed, json);
  assert.equal((await initializeConnectorMessageIndex(committed)).count, 1);
  assert.equal(await readFile(`${committed}.readonly-backup`, 'utf8'), json);
  console.log('PASS: concurrent migration, readonly original, indexed lookup, rollback, interrupted migration recovery, merge preservation');
} finally { await rm(root, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-context-memory-'));
setIsolatedTestHome(home);
try {
  const pathname = join(home, 'index.json');
  const records = {};
  for (let i = 0; i < 2048; i++) records[`feishu:tenant:message-${i}`] = {
    connector: 'feishu', accountId: 'tenant', messageId: `message-${i}`,
    sessionId: i % 2 ? 'current' : 'old', chatId: 'private', padding: 'x'.repeat(4096),
  };
  await writeFile(pathname, JSON.stringify({ records }));
  // Reproduce a long private history with an 8 MiB index under a 96 MiB heap.
  // Per-message parallel reads exceed this heap before the filter can finish.
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { filterPrivateConversationContext as filter } from ${JSON.stringify(new URL('../connectors/feishu/private-conversations.mjs', import.meta.url).href)};
    const pathname = process.argv[1];
    let reads = 0;
    const read = fs.readFile;
    fs.readFile = function(path, ...args) { if (path === pathname) reads++; return read.call(this, path, ...args); };
    syncBuiltinESMExports();
    const messages = Array.from({ length: 200 }, (_, i) => ({ messageId: 'message-' + i, senderType: 'app', timestamp: 2 }));
    messages.push({ messageId: 'before', senderType: 'user', timestamp: 1 },
      { messageId: 'human', senderType: 'user', timestamp: 2 },
      { messageId: 'unindexed', senderType: 'app', timestamp: 2 });
    const result = await filter({ storagePaths: { messageIndexPath: pathname } },
      { tenantKey: 'tenant', chatId: 'private' }, { id: 'current', privateConversationStart: { at: 1 } }, { messages });
    assert.equal(reads, 1, 'one physical index read for the entire history');
    assert.deepEqual(result.messages, [...messages.filter((_, i) => i < 200 && i % 2), ...messages.slice(-2)]);
    console.log(JSON.stringify({ reads, retained: result.messages.length, heapUsed: process.memoryUsage().heapUsed }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--max-old-space-size=96', '--input-type=module', '-e', script, pathname], { timeout: 30_000 });
  assert.equal(JSON.parse(stdout).reads, 1);
  console.log(`ok - private context stays within a 96 MiB heap: ${stdout.trim()}`);
} finally { await rm(home, { recursive: true, force: true }); }

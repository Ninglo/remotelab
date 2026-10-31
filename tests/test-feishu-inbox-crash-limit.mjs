import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

if (process.argv[2] === 'child') {
  const [root, baseUrl] = process.argv.slice(3);
  setIsolatedTestHome(root);
  const { initializeInbox } = await import('../scripts/feishu-connector.mjs');
  const runtime = {
    config: { storageDir: root, sourceRouteId: 'bot-test', chatBaseUrl: baseUrl,
      accessPolicy: { mode: 'all' } },
    storagePaths: { eventsLogPath: join(root, 'events.jsonl'), knownSendersPath: join(root, 'senders.json') },
    authCookie: 'isolated-test',
    personalSettings: { publish: async () => process.kill(process.pid, 'SIGKILL') },
  };
  const inbox = initializeInbox(runtime);
  await inbox.accept('poison', { summary: { sourceKind: 'personal_chat_entered', messageId: 'poison',
    chatId: 'oc_original', chatType: 'p2p', sender: { openId: 'test-human' } } });
  // No timer or production connector starts. Each process recovers one real Inbox.
  await inbox.tick(); await inbox.idle();
} else {
  const root = await mkdtemp(join(tmpdir(), 'feishu-crash-limit-'));
  setIsolatedTestHome(root);
  const { CONFIG_DIR } = await import('../lib/config.mjs');
  const { enqueueSourceDelivery, listSourceDeliveries } = await import('../chat/source-deliveries.mjs');
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(join(CONFIG_DIR, 'monitoring.json'), JSON.stringify({
    alertDelivery: { enabled: true, profile: 'bot-alert', chatId: 'oc_alert' },
  }));
  let requests = 0, loseAcknowledgement = true;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/api/source-deliveries');
      let text = '';
      for await (const chunk of request) text += chunk;
      const delivery = await enqueueSourceDelivery(JSON.parse(text));
      requests++;
      response.setHeader('content-type', 'application/json');
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        response.writeHead(503).end(JSON.stringify({ error: 'lost queue acknowledgement' }));
      } else response.writeHead(202).end(JSON.stringify({ delivery }));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = () => new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['child', root, `http://127.0.0.1:${server.address().port}`],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child timeout: ${output}`)); }, 15_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output }); });
  });
  try {
    assert.equal((await run()).signal, 'SIGKILL');
    assert.equal((await run()).signal, 'SIGKILL');
    const third = await run();
    assert.equal(third.code, 0, third.output);
    assert.equal(requests, 1, `third restart notifies instead of processing poison input: ${third.output}`);
    const active = join(root, 'inbox', 'active');
    const [file] = await readdir(active);
    const pending = JSON.parse(await readFile(join(active, file), 'utf8'));
    assert.equal(pending.attempts, 2);
    assert.equal(pending.crashAttempts, 2);
    assert.equal(pending.receipt.retryExhausted, true);
    // Advance the persisted notification deadline, without sleeping in the test.
    await writeFile(join(active, file), JSON.stringify({ ...pending, nextAttemptAt: 0 }));
    const fourth = await run();
    assert.equal(fourth.code, 0, fourth.output);
    const fifth = await run();
    assert.equal(fifth.code, 0, fifth.output);
    assert.equal(requests, 3, 'lost acknowledgement retries only the idempotent notice; alert queues once');
    const deliveries = await listSourceDeliveries({ connector: 'feishu' });
    assert.equal(deliveries.length, 2, 'one original-conversation notice and one alert in the real outbox');
    assert.deepEqual(deliveries.map(d => d.target.chatId).sort(), ['oc_alert', 'oc_original']);
    assert.equal(deliveries.find(d => d.target.chatId === 'oc_alert').sourceRouteId, 'bot-alert');
    const archived = JSON.parse(await readFile(join(root, 'inbox', 'archive', file), 'utf8'));
    assert.equal(archived.complete, true);
    assert.equal(archived.attempts, 2);
    assert.equal(archived.summary.messageId, 'poison', 'retain original input for manual replay');
    console.log('PASS: two real SIGKILL crashes, no third execution; one conversation notice and one alert, including lost ACK recovery');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

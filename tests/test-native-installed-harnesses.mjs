// Optional real CLI validation with a loopback-only mock model. No provider
// credentials, installed configuration, project hooks, or paid API are used.
// REMOTELAB_NATIVE_PI_BIN=/path/pi REMOTELAB_NATIVE_CLAUDE_BIN=/path/claude
// node scripts/run-with-clean-instance-env.mjs node --test tests/test-native-installed-harnesses.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const originalPath = process.env.PATH;
const binaries = { pi: process.env.REMOTELAB_NATIVE_PI_BIN, claude: process.env.REMOTELAB_NATIVE_CLAUDE_BIN };
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

for (const [family, binary] of Object.entries(binaries)) {
  test(`installed ${family}: native host forwards during inference, records real receipt and drains`, {
    skip: !binary, timeout: 45_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'remotelab-native-installed-'));
    setIsolatedTestHome(home);
    const { runNativeHost } = await import('../chat/native-host.mjs');
    const { submitNativeInput, readNativeInputReceipt } = await import('../chat/native-input-transport.mjs');
    let releaseFirst;
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    let modelStarted;
    const firstStarted = new Promise((resolve) => { modelStarted = resolve; });
    let calls = 0;
    const bodies = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (request.url.includes('count_tokens')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (!request.url.includes('messages')) { response.writeHead(404); response.end(); return; }
      calls += 1;
      const number = calls;
      bodies.push(body);
      if (number === 1) { modelStarted(); await firstReleased; }
      const message = { id: `msg_fixture_${number}`, type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: `fixture response ${number}` }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(message)); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `fixture response ${number}` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const config = join(home, 'provider');
    const directory = join(home, 'run');
    await mkdir(config, { recursive: true });
    await mkdir(directory, { recursive: true });
    const wrapper = join(home, 'harness');
    const flags = family === 'pi'
      ? '--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-tools --offline'
      : "--bare --permission-mode dontAsk --tools ''";
    await writeFile(wrapper, `#!/bin/sh\nexec ${quote(binary)} ${flags} "$@"\n`);
    await chmod(wrapper, 0o700);
    await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl, apiKey: 'dummy-local-fixture' } } }));
    const env = { PATH: originalPath, HOME: home, PI_CODING_AGENT_DIR: config, PI_TELEMETRY: '0',
      CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'dummy-local-fixture' };
    const events = [], stderr = [];
    let child;
    const running = runNativeHost({ directory, command: wrapper, runtimeFamily: family === 'pi' ? 'pi-json' : 'claude-stream-json',
      options: { model: family === 'pi' ? 'anthropic/claude-sonnet-4-6' : 'claude-sonnet-4-6' },
      prompt: 'Respond with a short fixture acknowledgement.', cwd: home, env,
      onStdout: (line) => events.push(JSON.parse(line)), onStderr: (line) => stderr.push(line), onProcess: (proc) => { child = proc; } });
    try {
      await Promise.race([firstStarted, running.then((result) => { throw new Error(`Harness exited before inference: ${result.error?.message}; ${stderr.join('\n')}`); })]);
      const receipt = await submitNativeInput(directory, { id: 'live-followup', text: 'Now also acknowledge the second fixture message.' }, { timeoutMs: 5_000 });
      assert.equal(receipt.accepted, true, stderr.join('\n'));
      assert.equal(calls, 1, 'follow-up acceptance must precede finishing the blocked model response');
      assert.equal((await readNativeInputReceipt(directory, 'live-followup')).state, 'accepted');
      releaseFirst();
      const result = await running;
      assert.equal(result.code, 0, `${result.error?.message || ''}\n${stderr.join('\n')}`);
      assert.equal(calls, 2, 'native agent consumes queued input in its own next model call');
      assert.ok(JSON.stringify(bodies[1].messages).includes('second fixture message'));
      const completions = family === 'pi'
        ? events.filter((event) => event.type === 'agent_settled')
        : events.filter((event) => event.type === 'result' && !event.remotelabNativePending);
      assert.equal(completions.length, 1);
    } finally {
      releaseFirst();
      child?.kill('SIGKILL');
      await running.catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}

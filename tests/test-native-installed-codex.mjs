// Optional installed Codex probe against a loopback-only Responses fixture.
// No real provider credential or model API is used.
// REMOTELAB_NATIVE_CODEX_BIN=/path/codex node scripts/run-with-clean-instance-env.mjs node --test tests/test-native-installed-codex.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const binary = process.env.REMOTELAB_NATIVE_CODEX_BIN;
const originalPath = process.env.PATH;
test('installed Codex: App Server accepts steering during held inference and drains through native host', {
  skip: !binary, timeout: 45_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'remotelab-native-installed-codex-'));
  setIsolatedTestHome(home);
  const { runNativeHost } = await import('../chat/native-host.mjs');
  const { submitNativeInput, readNativeInputReceipt } = await import('../chat/native-input-transport.mjs');
  let releaseFirst, signalStarted;
  const released = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  const bodies = [], paths = [], events = [], stderr = [];
  const server = createServer(async (request, response) => {
    paths.push(`${request.method} ${request.url}`);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.method !== 'POST' || !request.url.startsWith('/v1/responses')) {
      response.writeHead(404); response.end(); return;
    }
    const body = JSON.parse(raw || '{}');
    bodies.push(body);
    const number = bodies.length;
    if (number === 1) { signalStarted(); await released; }
    const text = `local Codex fixture answer ${number}`;
    const item = { id: `msg_${number}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const result = { id: `resp_${number}`, object: 'response', created_at: 1, status: 'completed', output: [item], model: body.model,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emitted = [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ];
    for (const event of emitted) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const codexHome = join(home, '.codex'), directory = join(home, 'run');
  await mkdir(codexHome, { recursive: true }); await mkdir(directory, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\nweb_search = "disabled"\nchatgpt_base_url = "${baseUrl}"\n\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "${baseUrl}/v1"\nenv_key = "CODEX_FIXTURE_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[analytics]\nenabled = false\n\n[feedback]\nenabled = false\n`);
  const env = { PATH: originalPath, HOME: home, CODEX_HOME: codexHome, SHELL: '/bin/sh', CODEX_FIXTURE_API_KEY: 'dummy-local-fixture',
    OTEL_SDK_DISABLED: 'true', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' };
  let child;
  const running = runNativeHost({ directory, command: binary, runtimeFamily: 'codex-json', options: { model: 'gpt-5.4', effort: 'low', disableApps: true },
    prompt: 'Reply with a short local fixture acknowledgement.', cwd: home, env,
    onStdout: line => events.push(JSON.parse(line)), onStderr: line => stderr.push(line), onProcess: proc => { child = proc; } });
  try {
    await Promise.race([started, running.then(result => { throw new Error(`Codex exited before fixture inference: ${result.error?.message}\n${stderr.join('\n')}\n${paths.join('\n')}`); })]);
    const receipt = await submitNativeInput(directory, { id: 'installed-codex-followup', text: 'Also acknowledge the second local fixture message.' }, { timeoutMs: 5000 });
    assert.equal(receipt.accepted, true, stderr.join('\n'));
    assert.equal(receipt.mode, 'steer');
    assert.equal(bodies.length, 1, 'steering acknowledgement precedes the held inference response');
    assert.equal((await readNativeInputReceipt(directory, 'installed-codex-followup')).state, 'accepted');
    releaseFirst();
    const result = await running;
    assert.equal(result.code, 0, `${result.error?.message || ''}\n${stderr.join('\n')}`);
    assert.equal(bodies.length, 2, `Codex consumes the steered message in its next inference; observed ${JSON.stringify(paths)}`);
    assert.ok(JSON.stringify(bodies[1].input).includes('second local fixture message'));
    assert.equal(events.filter(event => event.type === 'turn.completed').length, 1, 'the native turn settles only after consuming the correction');
    assert.ok(events.some(event => event.type === 'item.updated' && event.native_stream === true && event.item?.type === 'agent_message'), 'real App Server streams text deltas into the spool');
    assert.ok(events.some(event => event.type === 'item.completed' && event.item?.text === 'local Codex fixture answer 2'));
  } finally {
    releaseFirst(); child?.kill('SIGKILL'); await running.catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

// Real installed CLIs against local protocol fixtures; no paid model or credentials.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const pathEnv = process.env.PATH;
const binaries = { codex: process.env.REMOTELAB_NATIVE_CODEX_BIN, claude: process.env.REMOTELAB_NATIVE_CLAUDE_BIN };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const cases = Object.entries(binaries).flatMap(([family, binary]) => [
  { family, binary, mode: 'answers' }, { family, binary, mode: 'timeout' },
  ...(family === 'claude' ? [{ family, binary, mode: 'bypass' }] : []),
]);
for (const { family, binary, mode } of cases) {
  test(`installed ${family}: ${mode} returns through native question protocol`, { skip: !binary, timeout: 45_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), `installed-question-${family}-`));
    setIsolatedTestHome(home);
    const { runNativeHost } = await import('../chat/native-host.mjs');
    const { submitNativeInput } = await import('../chat/native-input-transport.mjs');
    const { readNativeQuestion } = await import('../chat/native-user-questions.mjs');
    const config = join(home, 'provider'), directory = join(home, 'run');
    await mkdir(config); await mkdir(directory);
    const bodies = [], events = [], errors = [], rawFrames = [];
    let child, questionReady, expire;
    let clock = 1000;
    const shown = new Promise(resolve => { questionReady = resolve; });
    const questions = [
      { id: 'format', header: 'Format', question: 'Which format?', options: [{ label: 'Brief', description: 'Summary' }, { label: 'Detailed', description: 'Full result' }] },
      { id: 'language', header: 'Language', question: 'Which language?', options: [{ label: 'English', description: 'English' }, { label: 'Chinese', description: 'Chinese' }] },
    ];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return; }
      if (!req.url.includes(family === 'codex' ? 'responses' : 'messages')) { res.writeHead(404); res.end(); return; }
      bodies.push(body);
      const number = bodies.length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (family === 'claude') {
        const block = number === 1 ? { type: 'tool_use', id: 'tool-question', name: 'AskUserQuestion', input: { questions: questions.map(({ id, ...q }) => ({ ...q, multiSelect: false })) } }
          : { type: 'text', text: 'answered' };
        const message = { id: `msg_${number}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
        emit({ type: 'message_start', message });
        emit({ type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } });
        emit({ type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
        emit({ type: 'content_block_stop', index: 0 });
        emit({ type: 'message_delta', delta: { stop_reason: number === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        emit({ type: 'message_stop' });
      } else {
        const item = number === 1 ? { id: 'fc-question', type: 'function_call', call_id: 'tool-question', name: 'request_user_input_async', arguments: JSON.stringify({ questions: questions.map(q => ({ title: q.question, options: q.options.map(o => o.label) })) }) }
          : { id: `msg_${number}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'answered', annotations: [] }] };
        const response = { id: `resp_${number}`, object: 'response', status: 'completed', output: [item], model: body.model,
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
        emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
        emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(number === 1 ? { arguments: '' } : { content: [] }) } });
        if (number === 1) emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
        else {
          emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'answered' });
        }
        emit({ type: 'response.output_item.done', output_index: 0, item });
        emit({ type: 'response.completed', response });
      }
      res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let command = binary;
    const env = { PATH: pathEnv, HOME: home, SHELL: '/bin/sh', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
      CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'local-fixture', CODEX_HOME: config, CODEX_FIXTURE_API_KEY: 'local-fixture', OTEL_SDK_DISABLED: 'true' };
    if (family === 'codex') await writeFile(join(config, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\ncheck_for_update_on_startup = false\nweb_search = "disabled"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "${baseUrl}/v1"\nenv_key = "CODEX_FIXTURE_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
    else {
      command = join(home, 'harness');
      await writeFile(command, `#!/bin/sh\nexec ${quote(binary)} --safe-mode --permission-mode ${mode === 'bypass' ? 'bypassPermissions' : 'manual'} --tools AskUserQuestion "$@"\n`);
      await chmod(command, 0o700);
    }
    const running = runNativeHost({ directory, command, runtimeFamily: family === 'codex' ? 'codex-json' : 'claude-stream-json',
      options: { model: family === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-6', effort: 'low', disableApps: true }, prompt: 'Ask which output format and language to use.', cwd: home, env,
      questionOptions: { now: () => clock,
        ...(mode === 'timeout' ? { timeoutMs: 300_000, setTimer: callback => { expire = callback; return callback; }, clearTimer: () => {} } : {}),
      },
      onProcess: proc => { child = proc; proc.stdout.on('data', chunk => rawFrames.push(String(chunk))); }, onStdout: line => { const event = JSON.parse(line); events.push(event); if (event.type === 'remotelab.user_question' && event.state === 'pending') {
        questionReady(event);
        if (mode === 'timeout') { clock += 300_000; expire(); }
      } }, onStderr: line => errors.push(line) });
    const earlyExit = running.then(result => { throw new Error(`Harness exited before question: ${result.error?.message}\n${errors.join('\n')}\n${JSON.stringify(events.map(e => ({ type: e.type, state: e.state, content: e.content })))}\nRAW: ${rawFrames.join('').split('\n').filter(x => /requestUserInput|request_user_input|control_request|question/.test(x)).join('\n').slice(0,4000)}\nOUTPUT: ${JSON.stringify((bodies[1]?.input || bodies[1]?.messages || []).filter(x => ['function_call_output', 'user'].includes(x.type || x.role))).slice(-3000)}`); });
    try {
      await Promise.race([shown, earlyExit]);
      if (mode !== 'timeout') {
        let next;
        const secondShown = new Promise(resolve => { next = resolve; });
        questionReady = next;
        const firstQuestion = await readNativeQuestion(directory);
        assert.equal(firstQuestion.deadline, null, 'installed native questions do not impose a default deadline');
        clock += 24 * 60 * 60_000;
        const firstId = firstQuestion.id;
        const receipt = await submitNativeInput(directory, { id: 'numbered', text: '2', questionId: firstId });
        assert.equal(receipt.mode, 'question_answer');
        await Promise.race([secondShown, earlyExit]);
        await submitNativeInput(directory, { id: 'custom', text: '请用中文并保留英文术语', questionId: (await readNativeQuestion(directory)).id });
      }
      const result = await running;
      assert.equal(result.code, 0, `${result.error?.message}\n${errors.join('\n')}`);
      const followup = JSON.stringify(bodies.at(-1).input || bodies.at(-1).messages);
      if (mode === 'timeout') {
        assert.match(followup, /Brief/);
        assert.match(followup, /system timeout fallback; not a user response/);
        assert.equal(events.filter(e => e.state === 'timeout').length, 2);
      } else {
        assert.match(followup, /Detailed/);
        assert.match(followup, /请用中文并保留英文术语/);
      }
      if (family === 'claude') assert.equal(bodies.length, 2, 'blocking question answers are tool results, not extra conversational turns');
      else assert.ok(bodies.length >= 2, 'Codex async questions return through its documented user-input contract');
    } finally {
      child?.kill('SIGKILL'); await running.catch(() => {}); await earlyExit.catch(() => {});
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}

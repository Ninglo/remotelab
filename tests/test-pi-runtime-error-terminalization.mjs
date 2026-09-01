#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'remotelab-pi-error-terminalization-'));
const binDir = join(home, 'bin');
const configDir = join(home, '.config', 'remotelab');
mkdirSync(binDir, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakePi = join(binDir, 'fake-pi');
writeFileSync(fakePi, `#!/usr/bin/env node
const { writeSync } = require('fs');
const emit = (value) => writeSync(1, value + '\\n');
const failed = {
  role: 'assistant',
  content: [],
  provider: 'moonshotai',
  model: 'kimi-k3',
  usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
  stopReason: 'error',
  errorMessage: '429: synthetic quota failure',
};
const recovering = process.argv.join(' ').includes('Recover after transient failure');
emit(JSON.stringify({ type: 'agent_start' }));
emit(JSON.stringify({ type: 'turn_start' }));
emit(JSON.stringify({ type: 'message_end', message: failed }));
if (recovering) {
  emit(JSON.stringify({ type: 'agent_end', messages: [failed], willRetry: true }));
  emit(JSON.stringify({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1200,
    errorMessage: failed.errorMessage,
  }));
  setTimeout(() => {
    const recovered = {
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      provider: 'moonshotai',
      model: 'kimi-k3',
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      stopReason: 'stop',
    };
    emit(JSON.stringify({ type: 'agent_start' }));
    emit(JSON.stringify({ type: 'turn_start' }));
    emit(JSON.stringify({ type: 'message_end', message: recovered }));
    emit(JSON.stringify({ type: 'auto_retry_end', success: true, attempt: 1 }));
    emit(JSON.stringify({ type: 'agent_settled' }));
  }, 1200);
} else {
  emit(JSON.stringify({ type: 'agent_settled' }));
}
`, 'utf8');
chmodSync(fakePi, 0o755);

writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
  id: 'fake-pi',
  name: 'Fake Pi',
  command: fakePi,
  runtimeFamily: 'pi-json',
  models: [{ id: 'moonshotai/kimi-k3', label: 'Kimi K3' }],
  reasoning: { kind: 'enum', label: 'Thinking', levels: ['low'], default: 'low' },
}], null, 2));

process.env.HOME = home;
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.REMOTELAB_WORK_ROOT_DIR = join(home, 'workspace');
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.PATH = `${binDir}:${process.env.PATH}`;

const {
  createSession,
  getRunState,
  getSessionReplyPublication,
  killAll,
  sendMessage,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);

async function waitFor(predicate, description, timeoutMs = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(home, 'fake-pi', 'Pi semantic failure', {
    space: 'Tests',
    group: 'Runtime',
    description: 'Pi provider errors must not publish as successful empty replies.',
  });
  const outcome = await sendMessage(session.id, 'Trigger the fake provider error.', [], {
    tool: 'fake-pi',
    model: 'moonshotai/kimi-k3',
    effort: 'low',
  });
  const runId = outcome.run?.id;
  const responseId = outcome.response?.id;
  assert.ok(runId);
  assert.ok(responseId);

  const run = await waitFor(async () => {
    const current = await getRunState(runId);
    return current?.state === 'failed' ? current : null;
  }, 'Pi semantic failure to terminalize as failed');
  assert.match(run.failureReason || '', /429: synthetic quota failure/);
  assert.equal(run.result?.exitCode, 0, 'the fake Pi process exits zero to exercise semantic failure detection');

  const publication = await waitFor(async () => {
    const current = await getSessionReplyPublication(session.id, responseId);
    return current?.state === 'failed' ? current : null;
  }, 'failed reply publication');
  assert.equal(publication.ready, false);
  assert.equal(publication.payload, null);

  const recoveringSession = await createSession(home, 'fake-pi', 'Pi retry recovery', {
    space: 'Tests',
    group: 'Runtime',
    description: 'Transient Pi provider attempts must stay non-terminal until retry settlement.',
  });
  const recoveringOutcome = await sendMessage(
    recoveringSession.id,
    'Recover after transient failure.',
    [],
    {
      tool: 'fake-pi',
      model: 'moonshotai/kimi-k3',
      effort: 'low',
    },
  );
  const recoveringRunId = recoveringOutcome.run?.id;
  const recoveringResponseId = recoveringOutcome.response?.id;
  assert.ok(recoveringRunId);
  assert.ok(recoveringResponseId);

  const retryingRun = await waitFor(async () => {
    const current = await getRunState(recoveringRunId);
    return (current?.normalizedEventCount || 0) > 0 ? current : null;
  }, 'transient Pi attempt to be observed before retry settlement');
  assert.equal(
    ['accepted', 'running'].includes(retryingRun.state),
    true,
    'the first retryable provider error must not release the session or fail its publication',
  );

  const recoveredRun = await waitFor(async () => {
    const current = await getRunState(recoveringRunId);
    return current?.state === 'completed' ? current : null;
  }, 'Pi retry to recover');
  assert.equal(recoveredRun.state, 'completed');

  const recoveredPublication = await waitFor(async () => {
    const current = await getSessionReplyPublication(recoveringSession.id, recoveringResponseId);
    return current?.state === 'ready' ? current : null;
  }, 'recovered reply publication');
  assert.equal(recoveredPublication.ready, true);
  assert.equal(recoveredPublication.payload?.text, 'recovered');
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}

console.log('test-pi-runtime-error-terminalization: ok');

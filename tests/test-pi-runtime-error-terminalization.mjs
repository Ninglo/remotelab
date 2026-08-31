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
const failed = {
  role: 'assistant',
  content: [],
  provider: 'moonshotai',
  model: 'kimi-k3',
  usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
  stopReason: 'error',
  errorMessage: '429: synthetic quota failure',
};
console.log(JSON.stringify({ type: 'agent_start' }));
console.log(JSON.stringify({ type: 'turn_start' }));
console.log(JSON.stringify({ type: 'message_end', message: failed }));
console.log(JSON.stringify({ type: 'agent_settled' }));
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

async function waitFor(predicate, description, timeoutMs = 6000) {
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
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}

console.log('test-pi-runtime-error-terminalization: ok');

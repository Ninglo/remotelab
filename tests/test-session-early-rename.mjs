#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-early-rename-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isTitlePrompt = prompt.includes('You are naming a developer session');
const wantsGrouping = prompt.includes('"space"') && prompt.includes('"group"') && prompt.includes('"description"');
const delayMs = isTitlePrompt ? 50 : 220;
const text = isTitlePrompt
  ? JSON.stringify(
      wantsGrouping
        ? {
            title: 'RemoteLab Rename Flow',
            space: 'Product',
            group: 'RemoteLab',
            description: 'Refactor the naming flow before the first run finishes.',
          }
        : { title: 'RemoteLab Rename Flow' }
    )
  : 'main task finished';

console.log(JSON.stringify({ type: 'thread.started', thread_id: isTitlePrompt ? 'title-thread' : 'run-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, delayMs);
setTimeout(() => process.exit(0), delayMs + 20);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = sessionManager;

async function waitFor(predicate, description, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

const session = await createSession(tempHome, 'fake-codex', '', {
});

await sendMessage(session.id, 'Refactor the naming flow so renaming starts immediately after the user sends a message.', [], {
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  async () => (await getSession(session.id))?.activity?.run?.state === 'running',
  'session should enter running state',
);

await waitFor(
  async () => {
    const current = await getSession(session.id);
    return current?.name === 'Refactor the…'
      && current?.group === 'RemoteLab'
      && current?.description === 'Refactor the naming flow before the first run finishes.'
      && current?.autoRenamePending === true;
  },
  'session should keep the temporary draft title while early grouping lands',
);

assert.equal(
  (await getSession(session.id))?.activity?.run?.state,
  'running',
  'early grouping should land while the main task is still running',
);

await waitFor(
  async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
  'session should finish running',
);

await waitFor(
  async () => {
    const current = await getSession(session.id);
    return current?.name === 'Rename Flow'
      && current?.group === 'RemoteLab'
      && current?.description === 'Refactor the naming flow before the first run finishes.'
      && current?.autoRenamePending === false;
  },
  'session should receive the final AI title after the first turn completes',
);

const finished = await getSession(session.id);
assert.equal(finished?.name, 'Rename Flow', 'finished session should adopt the final AI title after the first turn');
assert.equal(finished?.group, 'RemoteLab', 'finished session should keep the early AI grouping');
assert.equal(
  finished?.description,
  'Refactor the naming flow before the first run finishes.',
  'finished session should keep the AI description',
);
assert.equal(finished?.autoRenamePending, false, 'post-turn rename should clear autoRenamePending');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-early-rename: ok');

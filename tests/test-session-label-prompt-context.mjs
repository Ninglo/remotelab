#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-label-context-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');
const memoryDir = join(tempHome, '.remotelab', 'memory');
const promptLogPath = join(tempHome, 'label-prompt.log');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });

writeFileSync(
  join(memoryDir, 'projects.md'),
  `# Scope Router

## RemoteLab

- Type: code repo
- Path: \`~/code/remotelab/\`
- Triggers: RemoteLab, session rename, sidebar hierarchy, prompt tuning
- First read: \`~/code/remotelab/AGENTS.md\`

## Media Workflow

- Type: recurring non-repo domain
- Paths: \`~/my_docs/Media/\`, \`~/movies/\`
- Triggers: media, rough cut, transcript, review
- First read: \`~/.remotelab/skills/media-review.md\`
`,
  'utf8',
);

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
const isLabelPrompt = prompt.includes('You are naming a developer session');
const wantsTitle = prompt.includes('"title"');
const wantsGrouping = prompt.includes('"group"') && prompt.includes('"description"');
const delayMs = isLabelPrompt ? 50 : 220;

if (isLabelPrompt && process.env.PROMPT_LOG_FILE) {
  fs.appendFileSync(process.env.PROMPT_LOG_FILE, prompt + String.fromCharCode(10) + '---PROMPT---' + String.fromCharCode(10), 'utf8');
}

const text = isLabelPrompt
  ? JSON.stringify(
      wantsTitle
        ? {
            title: 'RemoteLab Prompt Tuning',
            group: 'RemoteLab',
            description: 'Tune the auto-rename prompt using session history and scope hints.',
          }
        : wantsGrouping
          ? {
              group: 'RemoteLab',
              description: 'Tune the auto-rename prompt using session history and scope hints.',
            }
          : {}
    )
  : 'main task finished';

console.log(JSON.stringify({ type: 'thread.started', thread_id: isLabelPrompt ? 'label-thread' : 'run-thread' }));
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
process.env.PROMPT_LOG_FILE = promptLogPath;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const history = await import(
  pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href
);

const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = sessionManager;
const { setContextHead } = history;

async function waitFor(predicate, description, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  await createSession(tempHome, 'fake-codex', 'Naming Flow', {
    group: 'RemoteLab',
    description: 'Refactor session naming and grouping.',
  });
  await createSession(tempHome, 'fake-codex', 'Rough Cut Review', {
    group: 'Video Workflow',
    description: 'Review edit decisions for the current draft.',
  });

  const target = await createSession(tempHome, 'fake-codex', '');
  await setContextHead(target.id, {
    mode: 'summary',
    summary: 'This conversation is about RemoteLab session grouping, rename prompts, and keeping related work under the same top-level project.',
    activeFromSeq: 0,
    compactedThroughSeq: 0,
    updatedAt: new Date().toISOString(),
    source: 'test',
  });

  await sendMessage(target.id, 'Make it feel natural and avoid creating a brand new group every time.', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const current = await getSession(target.id);
      return current?.name === 'Prompt Tuning'
        && current?.group === 'RemoteLab'
        && current?.description === 'Tune the auto-rename prompt using session history and scope hints.';
    },
    'session should use enriched prompt context for early naming',
  );

  const promptLog = readFileSync(promptLogPath, 'utf8');
  assert.match(promptLog, /Treat the display group as a flexible project-like container/);
  assert.match(promptLog, /Earlier session context:/);
  assert.match(promptLog, /Known scope router entries:/);
  assert.match(promptLog, /Current non-archived sessions:/);
  assert.match(promptLog, /RemoteLab session grouping, rename prompts/);
  assert.match(promptLog, /- RemoteLab — code repo/);
  assert.match(promptLog, /\[RemoteLab\] Naming Flow — Refactor session naming and grouping\./);
  assert.match(promptLog, /\[Video Workflow\] Rough Cut Review — Review edit decisions for the current draft\./);

  await waitFor(
    async () => (await getSession(target.id))?.activity?.run?.state === 'idle',
    'session should finish running',
  );

  console.log('test-session-label-prompt-context: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-title-refresh-same-workstream-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isLabelPrompt = prompt.includes('You are naming a developer session');
const isWorkstreamPrompt = prompt.includes('You are RemoteLab\\'s hidden workstream assessor for the CURRENT session');
const wantsTitle = prompt.includes('"title"');
const wantsGrouping = prompt.includes('"space"') && prompt.includes('"group"') && prompt.includes('"description"');
const delayMs = (isLabelPrompt || isWorkstreamPrompt) ? 50 : 220;

function buildPayload(title, group, description) {
  if (wantsTitle && wantsGrouping) return { title, space: 'Product', group, description };
  if (wantsTitle) return { title };
  if (wantsGrouping) return { space: 'Product', group, description };
  return {};
}

let text = 'main task finished';
if (isWorkstreamPrompt) {
  if (prompt.includes('把复用判定再收紧一点')) {
    text = JSON.stringify({
      workstreamRelation: 'same_workstream',
      confidence: 0.98,
      reasoning: '这是当前 dispatch 主线里的实现收紧，不应改写会话身份。',
    });
  } else {
    text = JSON.stringify({
      workstreamRelation: 'same_workstream',
      confidence: 0.98,
      reasoning: '这仍然是当前主线。',
    });
  }
} else if (isLabelPrompt) {
  if (prompt.includes('Refactor the dispatch rules')) {
    text = JSON.stringify(buildPayload(
      'Dispatch Rules',
      'Dispatch Logic',
      'Refactor the session dispatch rules and reuse logic.',
    ));
  } else if (prompt.includes('把复用判定再收紧一点')) {
    text = JSON.stringify(buildPayload(
      'Reuse Thresholds',
      'Reuse Rules',
      'Tighten the reuse thresholds in the dispatch flow.',
    ));
  } else {
    text = JSON.stringify(buildPayload(
      'Fallback Work',
      'Fallback',
      'Fallback session labeling.',
    ));
  }
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: (isLabelPrompt || isWorkstreamPrompt) ? 'label-thread' : 'run-thread' }));
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

async function waitFor(predicate, description, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(tempHome, 'fake-codex', '');

  await sendMessage(session.id, 'Refactor the dispatch rules so reuse decisions are stricter.', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const current = await getSession(session.id);
      return current?.name === 'Dispatch Rules'
        && current?.group === 'Dispatch Logic'
        && current?.description === 'Refactor the session dispatch rules and reuse logic.'
        && current?.activity?.run?.state === 'idle';
    },
    'session should receive the initial label set',
  );

  await sendMessage(session.id, '把复用判定再收紧一点，主要是把模糊的相似会话都挡掉，顺手把对应测试补上。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const current = await getSession(session.id);
      return current?.activity?.run?.state === 'idle';
    },
    'follow-up turn should finish',
  );

  const finalSession = await getSession(session.id);
  assert.equal(finalSession?.name, 'Dispatch Rules', 'same-workstream follow-up should keep the current title');
  assert.equal(finalSession?.group, 'Dispatch Logic', 'same-workstream follow-up should keep the current group');
  assert.equal(
    finalSession?.description,
    'Refactor the session dispatch rules and reuse logic.',
    'same-workstream follow-up should keep the current description',
  );

  console.log('test-session-title-refresh-same-workstream: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

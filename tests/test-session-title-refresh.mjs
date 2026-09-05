#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-title-refresh-'));
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
  if (prompt.includes('Redesign the sidebar grouping logic')) {
    text = JSON.stringify({
      workstreamRelation: 'same_session_shift',
      confidence: 0.97,
      reasoning: '当前会话仍然拥有这条输入，但主线已经转向侧边栏分组规则。',
    });
  } else {
    text = JSON.stringify({
      workstreamRelation: 'same_workstream',
      confidence: 0.97,
      reasoning: '这仍然是当前主线。',
    });
  }
} else if (isLabelPrompt) {
  if (prompt.includes('Redesign the sidebar grouping logic')) {
    text = JSON.stringify(buildPayload(
      'Sidebar Grouping',
      'Sidebar Grouping',
      'Redesign the session grouping rules for the sidebar.',
    ));
  } else if (prompt.includes('Refactor the dispatch rules')) {
    text = JSON.stringify(buildPayload(
      'Dispatch Rules',
      'Dispatch Logic',
      'Refactor the session dispatch rules and reuse logic.',
    ));
  } else {
    text = JSON.stringify(buildPayload(
      'General Work',
      'General',
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

setIsolatedTestHome(tempHome);
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

  await sendMessage(session.id, 'Redesign the sidebar grouping logic so unrelated work stops collapsing into one broad group.', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const current = await getSession(session.id);
      return current?.name === 'Sidebar Grouping'
        && current?.group === 'Sidebar Grouping'
        && current?.description === 'Redesign the session grouping rules for the sidebar.'
        && current?.activity?.run?.state === 'idle';
    },
    'session should refresh title and grouping when the workstream shifts',
  );

  console.log('test-session-title-refresh: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

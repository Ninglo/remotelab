#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-welcome-work-summary-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isSessionStatePrompt = prompt.includes("You are RemoteLab's single post-turn session-state classifier.");
const workSummary = {
  mode: 'project',
  summary: '先整理用户丢来的 Excel 和 PPT，再形成第一版可复用流程。',
  goal: '接管周报整理流程。',
  rawMaterials: ['sales.xlsx', 'brief.pptx'],
  background: ['用户目前靠手工处理。'],
  knownConclusions: ['原始材料比口头描述更关键。'],
  reusablePatterns: ['先接住原始材料，再考虑是否升级成长期流程。'],
  nextSteps: ['检查 Excel 结构', '整理第一版摘要'],
  memory: ['用户不想先写长说明。'],
  needsFromUser: ['若字段含义不清，再补一个目标样例。'],
};
const text = isSessionStatePrompt
  ? JSON.stringify({
      title: '周报流程接管',
      space: 'Work',
      group: 'RemoteLab',
      description: '整理原始业务材料并沉淀可复用周报流程。',
      shouldSetWorkflowState: true,
      workflowState: 'done',
      workflowPriority: 'low',
      workSummary,
    })
  : [
      '我先开始整理材料，并把第一版工作摘要沉淀下来。',
      '<private>',
      '<work_summary>{',
      '  "mode": "project",',
      '  "summary": "先整理用户丢来的 Excel 和 PPT，再形成第一版可复用流程。",',
      '  "goal": "接管周报整理流程。",',
      '  "rawMaterials": ["sales.xlsx", "brief.pptx"],',
      '  "background": ["用户目前靠手工处理。"],',
      '  "knownConclusions": ["原始材料比口头描述更关键。"],',
      '  "reusablePatterns": ["先接住原始材料，再考虑是否升级成长期流程。"],',
      '  "nextSteps": ["检查 Excel 结构", "整理第一版摘要"],',
      '  "memory": ["用户不想先写长说明。"],',
      '  "needsFromUser": ["若字段含义不清，再补一个目标样例。"]',
      '}</work_summary>',
      '</private>',
    ].join(String.fromCharCode(10));

console.log(JSON.stringify({ type: 'thread.started', thread_id: isSessionStatePrompt ? 'session-state-thread' : 'run-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
process.exit(0);
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
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const appsModule = await import(pathToFileURL(join(repoRoot, 'chat', 'apps.mjs')).href);
const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const starterPresetModule = await import(pathToFileURL(join(repoRoot, 'chat', 'session-starter-preset.mjs')).href);

const { WELCOME_STARTER_PRESET } = starterPresetModule;
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

const session = await createSession(tempHome, 'fake-codex', 'Welcome Intake', {
  starterPreset: WELCOME_STARTER_PRESET,
  group: 'RemoteLab',
  description: 'Welcome app intake state should keep a hidden work summary.',
});

await sendMessage(session.id, '我有两个原始文件，想把周报整理这件事交给你。', [], {
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
  'session should finish running',
);

await waitFor(
  async () => (await getSession(session.id))?.workSummary?.summary === '先整理用户丢来的 Excel 和 PPT，再形成第一版可复用流程。',
  'welcome session should persist the hidden work summary',
);

const updated = await getSession(session.id);
assert.equal(updated?.workSummary?.mode, 'project');
assert.deepEqual(updated?.workSummary?.rawMaterials, ['sales.xlsx', 'brief.pptx']);
assert.deepEqual(updated?.workSummary?.reusablePatterns, ['先接住原始材料，再考虑是否升级成长期流程。']);
assert.deepEqual(updated?.workSummary?.nextSteps, ['检查 Excel 结构', '整理第一版摘要']);
assert.deepEqual(updated?.workSummary?.memory, ['用户不想先写长说明。']);

await waitFor(
  async () => (await getSession(session.id))?.workflowState === 'done',
  'workflow state suggestion should settle before cleanup',
);
await waitFor(
  async () => Boolean((await getSession(session.id))?.welcomeOnboardingRetiredAt),
  'welcome onboarding retirement should settle before cleanup',
);

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-welcome-work-summary: ok');

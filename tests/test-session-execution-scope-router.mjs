#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testsDir);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-execution-scope-router-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');
const memoryDir = join(tempHome, '.remotelab', 'memory');
const tasksDir = join(memoryDir, 'tasks');
const promptLogPath = join(tempHome, 'execution-prompt.log');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(tasksDir, { recursive: true });

writeFileSync(
  join(memoryDir, 'projects.md'),
  `# Project Pointers

## 报账支出流程

- Type: recurring workflow
- Paths: \`~/.remotelab/instances/trial6/config/file-assets/reimbursement/报账支出主表.xlsx\`
- Triggers: 报账、报销、票据、小票
- First read: \`~/.remotelab/instances/trial6/memory/tasks/reimbursement-expense-workflow.md\`
- Then inspect: \`~/.remotelab/instances/trial6/config/file-assets/reimbursement/报账支出主表.xlsx\`
- Default action: 收到新的报账邮件后，以现有主表为基础追加更新，核对文字与图片后回传更新后的 Excel。

## Media Workflow

- Type: recurring non-repo domain
- Paths: \`~/my_docs/Media/\`
- Triggers: media, rough cut, transcript, review
- First read: \`~/.remotelab/skills/media-review.md\`
`,
  'utf8',
);

writeFileSync(
  join(tasksDir, 'reimbursement-expense-workflow.md'),
  '# 报账支出流程\n',
  'utf8',
);

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
if (process.env.PROMPT_LOG_FILE) {
  fs.appendFileSync(process.env.PROMPT_LOG_FILE, prompt + String.fromCharCode(10) + '---PROMPT---' + String.fromCharCode(10), 'utf8');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'execution-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '已处理。' },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, 50);
setTimeout(() => process.exit(0), 80);
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
const sessionMetaStore = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href
);

const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = sessionManager;
const { setContextHead } = history;
const { mutateSessionMeta } = sessionMetaStore;

async function waitFor(predicate, description, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const previous = await createSession(tempHome, 'fake-codex', '历史报账规则', {
    sourceId: 'email',
    sourceName: 'Email',
    group: 'Mail',
    description: 'Inbound email from finance@example.com about 报账规则',
    externalTriggerId: 'email-thread:%3Cold-thread%40example.com%3E',
  });
  await mutateSessionMeta(previous.id, (draft) => {
    draft.taskCard = {
      mode: 'project',
      summary: '沿用现有报账主表，不要新建文件。',
      memory: ['所有报账都要追加到同一个 Excel 主表。'],
      knownConclusions: ['图片票据要和文字说明逐项核对。'],
      nextSteps: ['先看文字说明', '再录入金额和日期'],
    };
    return true;
  });
  await setContextHead(previous.id, {
    mode: 'summary',
    summary: '之前已经确认：报账邮件默认沿用现有主表追加，不重新建表。',
    activeFromSeq: 0,
    compactedThroughSeq: 0,
    updatedAt: new Date().toISOString(),
    source: 'test',
  });

  const session = await createSession(tempHome, 'fake-codex', '报账邮件处理', {
    sourceId: 'email',
    sourceName: 'Email',
    group: 'Mail',
    description: 'Inbound email from finance@example.com about 新报账',
    externalTriggerId: 'email-thread:%3Cfresh-thread%40example.com%3E',
  });

  await sendMessage(
    session.id,
    '这是一封新的报账邮件，文字说明和小票照片都在附件里，请按之前的规则处理。',
    [],
    {
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    },
  );

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'session should finish running',
  );

  const promptLog = readFileSync(promptLogPath, 'utf8');
  assert.match(promptLog, /lightweight external context hook/);
  assert.match(promptLog, /Stable context entry points:/);
  assert.match(promptLog, /Projects: ~\/\.remotelab\/memory\/projects\.md/);
  assert.match(promptLog, /Tasks directory: ~\/\.remotelab\/memory\/tasks\//);
  assert.match(promptLog, /Model-managed writable context root:/);
  assert.match(promptLog, /~\/\.remotelab\/memory\/model-context/);
  assert.doesNotMatch(promptLog, /Likely scope-router matches for this turn/);
  assert.doesNotMatch(promptLog, /Recent related session imports for this turn/);

  console.log('test-session-execution-scope-router: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

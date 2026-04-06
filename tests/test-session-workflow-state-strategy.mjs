#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-workflow-strategy-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isWorkflowPrompt = prompt.includes('You are updating RemoteLab workflow state for a developer session.');

let text = '我先继续推进。';
if (isWorkflowPrompt) {
  if (prompt.includes('EXPLICIT_BLOCKER_CASE')) {
    text = JSON.stringify({
      shouldSetWorkflowState: true,
      workflowState: 'waiting_user',
      workflowPriority: 'high',
      reason: 'assistant is blocked on required user input',
    });
  } else if (prompt.includes('OPTIONAL_FEEDBACK_CASE')) {
    const hasStrictOptionalFeedbackRule = prompt.includes('subjective feedback')
      && prompt.includes('leave the workflow state unset');
    text = hasStrictOptionalFeedbackRule
      ? JSON.stringify({
        shouldSetWorkflowState: false,
        workflowState: '',
        workflowPriority: '',
        reason: 'assistant is only soliciting optional subjective feedback, so the session should stay active',
      })
      : JSON.stringify({
        shouldSetWorkflowState: true,
        workflowState: 'done',
        workflowPriority: 'low',
        reason: 'missing strict optional-feedback rule would incorrectly mark this session done',
      });
  } else if (prompt.includes('AMBIGUOUS_ACTIVE_CASE')) {
    text = JSON.stringify({
      shouldSetWorkflowState: false,
      workflowState: '',
      workflowPriority: '',
      reason: 'still active; no high-confidence low-visibility state',
    });
  } else if (prompt.includes('EXPLICIT_DONE_CASE')) {
    text = JSON.stringify({
      shouldSetWorkflowState: true,
      workflowState: 'done',
      workflowPriority: 'low',
      reason: 'current request is complete with no remaining blocker',
    });
  } else {
    text = JSON.stringify({
      shouldSetWorkflowState: false,
      workflowState: '',
      workflowPriority: '',
      reason: 'leave active by default',
    });
  }
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: isWorkflowPrompt ? 'workflow-thread' : 'chat-thread' }));
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

process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
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

try {
  const blockerSession = await createSession(tempHome, 'fake-codex', 'Blocked Case');
  await sendMessage(blockerSession.id, 'EXPLICIT_BLOCKER_CASE 我这边需要你先给我验证码，不然没法继续。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(blockerSession.id))?.activity?.run?.state === 'idle',
    'blocked session should finish running',
  );
  await waitFor(
    async () => (await getSession(blockerSession.id))?.workflowState === 'waiting_user',
    'explicit blocker should settle to waiting_user',
  );
  const blocked = await getSession(blockerSession.id);
  assert.equal(blocked?.workflowPriority, 'high');

  const ambiguousSession = await createSession(tempHome, 'fake-codex', 'Ambiguous Active Case', {
    workflowState: 'done',
    workflowPriority: 'low',
  });
  await sendMessage(ambiguousSession.id, 'AMBIGUOUS_ACTIVE_CASE 先聊思路，后面也许还会继续推进。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(ambiguousSession.id))?.activity?.run?.state === 'idle',
    'ambiguous session should finish running',
  );
  await waitFor(
    async () => {
      const session = await getSession(ambiguousSession.id);
      return !session?.workflowState && !session?.workflowPriority;
    },
    'ambiguous session should clear stale low-visibility workflow state',
  );
  const ambiguous = await getSession(ambiguousSession.id);
  assert.equal(ambiguous?.workflowState || '', '');
  assert.equal(ambiguous?.workflowPriority || '', '');

  const optionalFeedbackSession = await createSession(tempHome, 'fake-codex', 'Optional Feedback Case', {
    workflowState: 'done',
    workflowPriority: 'low',
  });
  await sendMessage(
    optionalFeedbackSession.id,
    'OPTIONAL_FEEDBACK_CASE 方案已经给你了，但你先看看感受如何、有没有主观反馈，我们再决定后面要不要继续聊。',
    [],
    {
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    },
  );

  await waitFor(
    async () => (await getSession(optionalFeedbackSession.id))?.activity?.run?.state === 'idle',
    'optional feedback session should finish running',
  );
  await waitFor(
    async () => {
      const session = await getSession(optionalFeedbackSession.id);
      return !session?.workflowState && !session?.workflowPriority;
    },
    'optional feedback follow-up should clear stale done state and stay active',
  );
  const optionalFeedback = await getSession(optionalFeedbackSession.id);
  assert.equal(optionalFeedback?.workflowState || '', '');
  assert.equal(optionalFeedback?.workflowPriority || '', '');

  const doneSession = await createSession(tempHome, 'fake-codex', 'Done Case');
  await sendMessage(doneSession.id, 'EXPLICIT_DONE_CASE 这个请求已经交付完了，没有残留阻塞。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(doneSession.id))?.activity?.run?.state === 'idle',
    'done session should finish running',
  );
  await waitFor(
    async () => (await getSession(doneSession.id))?.workflowState === 'done',
    'explicit completion should settle to done',
  );
  const done = await getSession(doneSession.id);
  assert.equal(done?.workflowPriority, 'low');

  console.log('test-session-workflow-state-strategy: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-pending-label-resume-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

for (const name of [
  'REMOTELAB_INSTANCE_ROOT',
  'REMOTELAB_CONFIG_DIR',
  'REMOTELAB_CHAT_BASE_URL',
  'REMOTELAB_SESSION_ID',
  'REMOTELAB_RUN_ID',
  'REMOTELAB_RUNNER_UNIT_NAME',
  'REMOTELAB_RUNNER_UNIT_SCOPE',
  'REMOTELAB_RUNNER_LAUNCH_MODE',
  'REMOTELAB_CODEX_HOME_MODE',
  'REMOTELAB_MACHINE_CODEX_HOME',
]) {
  delete process.env[name];
}

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isLabelPrompt = prompt.includes('You are naming a developer session');
const text = isLabelPrompt
  ? JSON.stringify({
      title: 'Track Sprint Visual Plan',
      group: 'L2 Word Rally',
      description: 'Recover a completed delegated session title from its final turn content.',
    })
  : 'unused';

console.log(JSON.stringify({ type: 'thread.started', thread_id: isLabelPrompt ? 'label-thread' : 'run-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
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
const history = await import(
  pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href
);
const runs = await import(
  pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href
);
const sessionMetaStore = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href
);
const normalizer = await import(
  pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href
);

const {
  createSession,
  getSession,
  killAll,
  listSessions,
  resumePendingSessionLabels,
} = sessionManager;
const { appendEvents } = history;
const { createRun } = runs;
const { findSessionMeta, mutateSessionMeta } = sessionMetaStore;
const { messageEvent, statusEvent } = normalizer;

try {
  const session = await createSession(join(tempHome, 'workspace'), 'fake-codex', '', {
    internalRole: 'agent_delegate',
    model: 'fake-model',
    effort: 'low',
  });
  assert.equal(session.autoRenamePending, true, 'unnamed delegated sessions should start pending auto-rename');

  await appendEvents(session.id, [
    messageEvent('user', 'Delegation handoff: design the track sprint visual replacement plan.'),
    messageEvent('assistant', 'Completed the track sprint visual plan and asset replacement specification.'),
    statusEvent('completed'),
  ]);

  const repairedCount = await resumePendingSessionLabels({ waitForCompletion: true });
  assert.equal(repairedCount, 1, 'startup repair should queue the stale pending label');

  const repaired = await getSession(session.id);
  assert.equal(repaired?.name, 'Track Sprint Visual Plan', 'pending title should be recovered from the final turn');
  assert.equal(repaired?.autoRenamePending, false, 'repair should clear autoRenamePending');
  assert.equal(repaired?.group, 'L2 Word Rally', 'repair should apply generated grouping');
  assert.equal(
    repaired?.description,
    'Recover a completed delegated session title from its final turn content.',
    'repair should apply generated description',
  );

  const staleActiveSession = await createSession(join(tempHome, 'workspace'), 'fake-codex', '', {
    internalRole: 'agent_delegate',
    model: 'fake-model',
    effort: 'low',
  });
  await appendEvents(staleActiveSession.id, [
    messageEvent('user', 'Delegation handoff: inspect the completed track sprint state machine plan.'),
    messageEvent('assistant', 'Completed the track sprint state machine plan.'),
    statusEvent('completed'),
  ]);
  const staleRun = await createRun({
    status: {
      sessionId: staleActiveSession.id,
      requestId: 'stale-active-request',
      responseId: 'stale-active-request',
      state: 'completed',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      completedAt: new Date().toISOString(),
      result: { exitCode: 0, signal: null, cancelled: false },
    },
    manifest: {
      sessionId: staleActiveSession.id,
      requestId: 'stale-active-request',
      responseId: 'stale-active-request',
      folder: staleActiveSession.folder,
      tool: 'fake-codex',
      runtimeFamily: 'codex-json',
    },
  });
  await mutateSessionMeta(staleActiveSession.id, (draft) => {
    draft.activeRunId = staleRun.id;
    return true;
  });

  const staleActiveRepairedCount = await resumePendingSessionLabels({ waitForCompletion: true });
  assert.equal(staleActiveRepairedCount, 1, 'startup repair should reconcile terminal active runs before relabeling');

  const staleActiveRepaired = await getSession(staleActiveSession.id);
  assert.equal(staleActiveRepaired?.activeRunId, undefined, 'terminal active run should be cleared during repair');
  assert.equal(staleActiveRepaired?.name, 'Track Sprint Visual Plan', 'stale active pending title should be recovered');
  assert.equal(staleActiveRepaired?.autoRenamePending, false, 'stale active repair should clear autoRenamePending');

  const listedTerminalSession = await createSession(join(tempHome, 'workspace'), 'fake-codex', 'Finished visible session', {
    model: 'fake-model',
    effort: 'low',
  });
  const listedTerminalRun = await createRun({
    status: {
      sessionId: listedTerminalSession.id,
      requestId: 'listed-terminal-request',
      responseId: 'listed-terminal-request',
      state: 'completed',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      completedAt: new Date().toISOString(),
      result: { exitCode: 0, signal: null, cancelled: false },
    },
    manifest: {
      sessionId: listedTerminalSession.id,
      requestId: 'listed-terminal-request',
      responseId: 'listed-terminal-request',
      folder: listedTerminalSession.folder,
      tool: 'fake-codex',
      runtimeFamily: 'codex-json',
    },
  });
  await mutateSessionMeta(listedTerminalSession.id, (draft) => {
    draft.activeRunId = listedTerminalRun.id;
    return true;
  });

  const listedSessions = await listSessions({ includeArchived: false });
  const listedTerminal = listedSessions.find((entry) => entry.id === listedTerminalSession.id);
  assert.equal(listedTerminal?.activity?.run?.state, 'idle', 'completed active run should list as idle');
  assert.equal(
    (await findSessionMeta(listedTerminalSession.id))?.activeRunId,
    undefined,
    'listing sessions should clear stale terminal activeRunId',
  );

  const organizerSession = await createSession(join(tempHome, 'workspace'), 'fake-codex', 'sort session list', {
    internalRole: 'session_list_organizer',
    model: 'fake-model',
    effort: 'low',
  });
  const organizerRun = await createRun({
    status: {
      sessionId: organizerSession.id,
      requestId: 'organizer-terminal-request',
      responseId: 'organizer-terminal-request',
      state: 'completed',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
      completedAt: new Date().toISOString(),
      result: { exitCode: 0, signal: null, cancelled: false },
    },
    manifest: {
      sessionId: organizerSession.id,
      requestId: 'organizer-terminal-request',
      responseId: 'organizer-terminal-request',
      folder: organizerSession.folder,
      tool: 'fake-codex',
      runtimeFamily: 'codex-json',
      internalOperation: 'session_project_maintenance',
    },
  });
  await mutateSessionMeta(organizerSession.id, (draft) => {
    draft.activeRunId = organizerRun.id;
    return true;
  });

  await getSession(organizerSession.id);
  const archivedOrganizer = await findSessionMeta(organizerSession.id);
  assert.equal(archivedOrganizer?.activeRunId, undefined, 'completed organizer should clear activeRunId');
  assert.equal(archivedOrganizer?.archived, true, 'completed organizer should be archived automatically');

  console.log('test-session-pending-label-resume: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

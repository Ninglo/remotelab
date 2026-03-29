import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { createSession, setSessionArchived, sendMessage } from './session-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');
const RUNS_DIR = join(homedir(), '.config', 'claude-web', 'workflow-runs');
const SCHEDULES_FILE = join(WORKFLOWS_DIR, 'schedules.json');

// ---- Atomic write helper ----

function atomicWriteJSON(filepath, data) {
  const tmp = filepath + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filepath);
}

// ---- Placeholder resolution ----

function resolvePlaceholders(prompt, results) {
  return prompt.replace(/\{\{(\w+)\.results\}\}/g, (_, stepId) => {
    if (!results[stepId]) return '[results not available]';
    return Object.entries(results[stepId])
      .map(([id, output]) => `### ${id}\n${output}`)
      .join('\n\n');
  });
}

// ---- Single task runner ----

async function runSessionMessageTask(task, runDir) {
  console.log(`[Workflow] Sending message to session "${task.sessionId}"`);
  await sendMessage(task.sessionId, task.text);
  const output = `Message sent to session ${task.sessionId}`;
  writeFileSync(join(runDir, `${task.id}.txt`), output, 'utf8');
  console.log(`[Workflow] sessionMessage task "${task.id}" completed`);
  return output;
}

async function runTask(task, runDir, sessionIds) {
  if (task.type === 'sessionMessage') {
    return runSessionMessageTask(task, runDir);
  }
  // Default: create session and send message
  console.log(`[Workflow] Running task "${task.id}" in ${task.workspace} (model: ${task.model})`);
  const session = await createSession(task.workspace, 'claude', task.id, {
    model: task.model || 'sonnet',
  });
  const sessionId = session.id;
  sessionIds.push(sessionId);
  await sendMessage(sessionId, task.prompt);
  const output = `Session ${sessionId} created and message sent`;
  writeFileSync(join(runDir, `${task.id}.txt`), output, 'utf8');
  console.log(`[Workflow] Task "${task.id}" completed, session=${sessionId.slice(0, 8)}`);
  return output;
}

// ---- Schedule post-run logic ----

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch (err) {
    console.error('[Workflow] Failed to parse schedules.json:', err.message);
    return { schedules: [] };
  }
}

function handleDisposable(schedule, sessionIds, runDir) {
  if (!schedule?.disposable) return;
  console.log(`[Workflow] Disposable: archiving ${sessionIds.length} session(s) for schedule "${schedule.id}"`);
  for (const sid of sessionIds) {
    setSessionArchived(sid, true);
  }
  // Mark run meta as archived
  try {
    const metaPath = join(runDir, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.archived = true;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error(`[Workflow] Failed to mark run as archived:`, err.message);
  }
}

function handleRunCount(schedule) {
  if (!schedule) return;
  const data = loadSchedules();
  const s = data.schedules.find(s => s.id === schedule.id);
  if (!s) return;

  s.runCount = (s.runCount || 0) + 1;
  console.log(`[Workflow] Schedule "${schedule.id}" runCount=${s.runCount}/${s.maxRuns ?? '∞'}`);

  if (s.maxRuns !== null && s.maxRuns !== undefined && s.runCount >= s.maxRuns) {
    console.log(`[Workflow] Schedule "${schedule.id}" reached maxRuns=${s.maxRuns}, removing`);
    data.schedules = data.schedules.filter(x => x.id !== schedule.id);
    atomicWriteJSON(SCHEDULES_FILE, data);
    // Notify scheduler to clear timer (via returned flag)
    return 'removed';
  }

  atomicWriteJSON(SCHEDULES_FILE, data);
  return 'updated';
}

// ---- Main export ----

export async function executeWorkflow(workflowName, options = {}) {
  const { schedule, inlineWorkflow } = options;

  let workflow;
  if (inlineWorkflow) {
    workflow = inlineWorkflow;
  } else {
    const workflowPath = join(WORKFLOWS_DIR, `${workflowName}.json`);
    if (!existsSync(workflowPath)) {
      throw new Error(`Workflow definition not found: ${workflowPath}`);
    }
    workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
  }

  const runId = options.runId || randomBytes(8).toString('hex');
  const runDir = join(RUNS_DIR, runId);
  mkdirSync(runDir, { recursive: true });

  console.log(`[Workflow] Starting "${workflowName || workflow.name}" run=${runId}`);

  const meta = {
    runId,
    workflow: workflowName,
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: {},
  };
  if (schedule) meta.scheduleId = schedule.id;
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const results = {}; // stepId → { taskId → output }
  const sessionIds = []; // track all sessions created during this run

  try {
    for (const step of workflow.steps) {
      console.log(`[Workflow] Executing step "${step.id}" (type: ${step.type})`);

      const resolvedTasks = step.tasks.map(task => ({
        ...task,
        ...(task.prompt ? { prompt: resolvePlaceholders(task.prompt, results) } : {}),
      }));

      if (step.type === 'parallel') {
        const settled = await Promise.allSettled(
          resolvedTasks.map(async task => {
            const output = await runTask(task, runDir, sessionIds);
            return [task.id, output];
          })
        );
        for (const [i, r] of settled.entries()) {
          if (r.status === 'rejected') {
            console.error(`[Workflow] Task "${resolvedTasks[i].id}" failed in parallel step:`, r.reason?.message);
          }
        }
        results[step.id] = Object.fromEntries(
          settled.map((r, i) => [
            resolvedTasks[i].id,
            r.status === 'fulfilled' ? r.value[1] : `[FAILED: ${r.reason?.message ?? 'unknown error'}]`,
          ])
        );
      } else {
        results[step.id] = {};
        for (const task of resolvedTasks) {
          const output = await runTask(task, runDir, sessionIds);
          results[step.id][task.id] = output;
        }
      }

      meta.steps[step.id] = { status: 'completed', tasks: Object.keys(results[step.id]) };
    }

    meta.status = 'completed';
    meta.completedAt = new Date().toISOString();
    console.log(`[Workflow] "${workflowName}" run=${runId} completed successfully`);
  } catch (err) {
    meta.status = 'failed';
    meta.error = err.message;
    meta.errorStack = err.stack;
    meta.failedAt = new Date().toISOString();
    console.error(`[Workflow] "${workflowName}" run=${runId} failed:`, err.message);
  }

  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));

  // Post-run schedule lifecycle
  if (schedule) {
    handleDisposable(schedule, sessionIds, runDir);
    const result = handleRunCount(schedule);
    meta._scheduleRemoved = result === 'removed';
  }

  return { runId, runDir, meta };
}

// ---- Utility: list recent runs ----

export function listWorkflowRuns(limit = 10) {
  if (!existsSync(RUNS_DIR)) return [];
  try {
    const dirs = readdirSync(RUNS_DIR)
      .map(name => ({ name, mtime: statSync(join(RUNS_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(({ name }) => {
        try {
          return JSON.parse(readFileSync(join(RUNS_DIR, name, 'meta.json'), 'utf8'));
        } catch (err) {
          console.error(`[Workflow] Failed to load workflow run "${name}":`, err.message);
          return { runId: name, status: 'unknown' };
        }
      });
    return dirs;
  } catch (err) {
    console.error('[Workflow] Failed to list workflow runs:', err.message);
    return [];
  }
}

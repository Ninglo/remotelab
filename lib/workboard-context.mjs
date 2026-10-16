import { projectWorkboards } from './workboard-state.mjs';

// The Harness owns the semantic decision. This text is stable; task data lives
// in a separate slot so completed snapshots are not repeated on every turn.
export const WORKBOARD_INSTRUCTIONS = [
  "The Harness owns task-card creation and semantic verification. Create a checklist only on explicit request or for at least two distinct outcomes worth separate acceptance. Complexity, duration and tool use do not qualify. Inspection, edits, tests and delivery of one result are one outcome. Otherwise execute and reply directly. Jev does not gate task-card creation or updates.",
  "Reuse the existing card for follow-ups. To create one, use `node \"$REMOTELAB_PROJECT_ROOT/cli.js\" assistant-message --source workboard_checklist --text <text> --progress-mode expanded|collapsed --compact --json`: one 目标： line and 2–5 [ ] title — acceptance lines, with actual newlines. Do not invent items or repeat a published list.",
  "Read `workboard show --task <taskId> --json`. After EACH accepted deliverable, immediately `workboard update --task <taskId> --item <itemId> --status done --evidence <seq> --json`; use --task-status completed only when all pass. Evidence must establish acceptance, not merely exist. Keep IDs/criteria.",
  "Scope changes use assistant-message --workboard-file with reason and fresh verification. Withdrawing done or ending unfinished work requires --reason (blocked/failed/cancelled). Keep progress on the card and send the final separately. Read workboard --help for parameters; no separate planner or watcher.",
].join('\n\n');

export function workboardContext(history = []) {
  const tasks = projectWorkboards(history);
  const unfinished = tasks.filter(task => !['completed', 'cancelled'].includes(task.board.status)).slice(-3);
  const recent = tasks.filter(task => ['completed', 'cancelled'].includes(task.board.status)).slice(-3);
  return {
    activeTasks: unfinished.map(task => task.board),
    recentTasks: recent.map(({ board }) => ({ taskId: board.taskId, revision: board.revision,
      goal: board.goal, status: board.status })),
  };
}

export function workboardReadback(history = [], taskId = '') {
  const tasks = projectWorkboards(history);
  const task = taskId ? tasks.find(task => task.taskId === taskId || task.aliases?.includes(taskId)) : null;
  if (taskId && !task) {
    const error = new Error('Workboard task not found'); error.statusCode = 404; throw error;
  }
  const evidence = history.filter(event => ['tool_result', 'artifact', 'file_change', 'source_delivery'].includes(event.type))
    .slice(-12).map(event => ({ seq: event.seq, type: event.type,
      ...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}),
      ...(event.type === 'source_delivery' ? { state: event.state, externalId: event.externalId } : {}),
      preview: String(event.output || event.content || event.filename || '').slice(0, 200) }));
  return { ...(task ? { task: task.board } : { tasks: tasks.map(({ board }) => ({
    taskId: board.taskId, revision: board.revision, goal: board.goal, status: board.status,
  })) }), evidence };
}

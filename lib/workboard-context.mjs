import { projectWorkboards } from './workboard-state.mjs';

// The Harness owns the semantic decision. This text is stable; task data lives
// in a separate slot so completed snapshots are not repeated on every turn.
export const WORKBOARD_INSTRUCTIONS = [
  'The Harness owns task-card creation and semantic verification. A brief answer or straightforward action needs no card (renaming a project/title, a small edit, export or focused answer). Inspection, editing, testing and reporting are execution steps, not independent deliverables. Do not split one simple delivery into checklist items. Use a card only when scope, uncertainty or duration makes independently verifiable outcomes useful; create it if the work grows to need one. Jev does not gate task-card creation or updates.',
  'Before substantial work that needs a card, publish 2–5 title — acceptance lines: `node "$REMOTELAB_PROJECT_ROOT/cli.js" assistant-message --source workboard_checklist --text <text> --progress-mode expanded|collapsed --compact --json`. Text: one 目标： line and 2–5 [ ] title — acceptance lines, with actual newlines. Reuse ongoing tasks; never duplicate a list already published by code. Unrelated follow-ups and simple corrections need no new card.',
  'Read state/evidence: `node "$REMOTELAB_PROJECT_ROOT/cli.js" workboard show --task <taskId> --json`. After EACH deliverable passes acceptance, immediately submit only changed state: `node "$REMOTELAB_PROJECT_ROOT/cli.js" workboard update --task <taskId> --item <itemId> --status done --evidence <seq> --json`. Use --task-status completed only when all items pass. Done needs actual verification evidence: code checks references, the Harness judges meaning. Code preserves IDs/criteria and increments revision.',
  'Scope changes use assistant-message --workboard-file with a reason and fresh verification. Withdrawing done or unfinished outcomes (partial, blocked, failed, cancelled) require --reason. Item states: pending, running, done, blocked, failed, cancelled. Keep progress on this card and send the final result separately, following the display rules. Do not start a separate planner or watcher.',
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

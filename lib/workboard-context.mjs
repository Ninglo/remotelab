import { projectWorkboards } from './workboard-state.mjs';

// The Harness owns the semantic decision. This text is stable; task data lives
// in a separate slot so completed snapshots are not repeated on every turn.
export const WORKBOARD_INSTRUCTIONS = [
  'The Harness owns task-card creation and semantic verification. A brief answer or straightforward action needs no card. Default a single bounded delivery to direct execution and a final reply: renaming a project/title, changing one field, a small edit, a direct export, or a focused answer. Routine inspection, editing, testing and reporting are execution steps, not independent deliverables. Tool use or several such steps alone never justify a card. Do not split one simple delivery into multiple checklist items. Use a card only when actual scope, uncertainty or duration makes independently verifiable intermediate outcomes useful to the user.',
  'For substantial work, publish 2–5 title — acceptance lines before that work: `node "$REMOTELAB_PROJECT_ROOT/cli.js" assistant-message --source workboard_checklist --text <text> --progress-mode expanded|collapsed --compact --json` (one 目标： line and 2–5 [ ] title — acceptance lines, with actual newlines). If work grows substantially, create its card then. Reuse an existing task when continuing it; an unrelated follow-up or simple correction does not need a new card. If code already published the supplied list, do not duplicate it. Jev does not gate task-card creation or updates.',
  'Use `node "$REMOTELAB_PROJECT_ROOT/cli.js" workboard show --task <taskId> --json` for a full snapshot and recent evidence sequence numbers, rather than reading the whole Session history. Update only changed state with `node "$REMOTELAB_PROJECT_ROOT/cli.js" workboard update --task <taskId> --item <itemId> --status done --evidence <seq> --json`; use --task-status completed when all items pass. Code preserves IDs and criteria and assigns the next revision. Full snapshots via assistant-message --workboard-file remain available for scope changes, which require a reason and fresh verification.',
  'After EACH deliverable passes acceptance, immediately submit its update. A done item needs actual verification evidence; code checks references, the Harness judges their meaning. Withdrawing done needs --reason. Unfinished task outcomes (partial, blocked, failed, cancelled) need --reason; item states are pending, running, done, blocked, failed, cancelled. Keep useful progress in the same card. Send the final answer separately, including unfinished outcomes; a final reply or tool completion does not prove task success. Do not start a separate planner or watcher.',
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

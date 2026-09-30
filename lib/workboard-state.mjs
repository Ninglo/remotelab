// Session history is the durable source of truth. This projection is shared by
// the transcript and the Feishu publisher; it does not make semantic decisions.
const trim = value => typeof value === 'string' ? value.trim() : '';
const statuses = new Set(['running', 'partial', 'blocked', 'failed', 'cancelled', 'completed']);
const itemStatuses = new Set(['pending', 'running', 'done', 'blocked', 'failed', 'cancelled']);
export const WORKBOARD_STATUS_LABELS = {
  running: '进行中', partial: '部分完成', blocked: '等待条件', failed: '失败',
  cancelled: '已取消', completed: '工作完成，答复待送达', unconfirmed: '执行结束，完成状态待确认',
};
export function workboardStatusLabel(board) {
  const base = board.status === 'completed' && board.deliveryState === 'delivered'
    ? '已完成，答复已送达' : WORKBOARD_STATUS_LABELS[board.status] || '进行中';
  const status = board.deliveryState === 'failed' ? `${base}，答复投递异常` : base;
  return board.reason ? `${status}：${board.reason}` : status;
}
export function formatWorkboard(board) {
  return [`目标：${board.goal}`, ...board.items.map(item =>
    `[${item.status === 'done' ? 'x' : ' '}] ${item.title} — ${item.condition}`)].join('\n');
}
export function parseLegacyWorkboard(content, taskId) {
  const lines = String(content || '').split(/\r?\n/);
  const goal = lines.find(line => /^目标[：:]/.test(line))?.replace(/^目标[：:]\s*/, '').trim();
  const items = lines.flatMap(line => {
    const match = line.match(/^\[([ xX])\]\s*(.+?)\s+—\s+(.+)$/);
    return match ? [{ title: match[2], condition: match[3],
      status: match[1].toLowerCase() === 'x' ? 'done' : 'pending', evidenceRefs: [] }] : [];
  }).map((item, index) => ({ ...item, id: `item-${index + 1}` }));
  if (!goal || items.length < 1 || items.length > 5) return null;
  return { taskId, revision: 1, goal, status: 'running', reason: '', items, legacy: true };
}

export function projectWorkboards(history = []) {
  const tasks = new Map();
  const runTasks = new Map();
  const finalsByTask = new Map();
  const seenFinals = new Set();
  let legacyActive = null;
  for (const event of [...history].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    const runId = trim(event.runId);
    if (event.type === 'message' && event.role === 'assistant' && event.source === 'workboard_checklist') {
      const taskId = trim(event.workboard?.taskId) || (runId ? `wb_${runId}` : legacyActive || `wb_seq_${event.seq}`);
      const previous = tasks.get(taskId);
      let board = event.workboard || parseLegacyWorkboard(event.content, taskId);
      if (!board) continue;
      if (event.workboard && previous?.board.legacy !== true && board.revision <= previous?.board.revision) continue;
      if (!event.workboard) board = { ...board, revision: (previous?.board.revision || 0) + 1 };
      const update = { seq: event.seq, runId, content: formatWorkboard(board), workboard: board };
      const task = { taskId, anchorSeq: previous?.anchorSeq || event.seq, latestSeq: event.seq,
        runId, boardUpdateSeq: event.seq, board, content: update.content, updates: [...(previous?.updates || []), update] };
      tasks.set(taskId, task);
      if (runId) runTasks.set(runId, taskId);
      legacyActive = taskId;
      continue;
    }
    // Associate each answer with the task active when it was generated. A later
    // task in the same Run must not replace an earlier task's delivery receipt.
    if (event.type === 'message' && event.role === 'assistant' && ['final', 'final_answer'].includes(event.phase)) {
      const taskId = runTasks.get(runId) || (!runId ? legacyActive : null);
      const key = `${runId}:${event.providerMessageId}`;
      if (taskId && event.providerMessageId && !seenFinals.has(key)) {
        finalsByTask.set(taskId, event);
        seenFinals.add(key);
      }
    }
    // A final answer can report a blocker. It never proves business completion.
    if (!runId && event.type === 'message' && event.role === 'assistant'
        && ['final', 'final_answer'].includes(event.phase)) legacyActive = null;
    if (event.type !== 'status' || !runTasks.has(runId)) continue;
    const task = tasks.get(runTasks.get(runId));
    if (!task || task.runId !== runId || task.board.status !== 'running') continue;
    const content = trim(event.content);
    const status = content === 'cancelled' ? 'cancelled'
      : content.startsWith('error:') ? 'failed' : content === 'completed' ? 'unconfirmed' : '';
    if (!status) continue;
    const board = { ...task.board, status,
      reason: status === 'failed' ? content.slice(6).trim() : '' };
    const update = { seq: event.seq, runId, content: formatWorkboard(board), workboard: board };
    tasks.set(task.taskId, { ...task, latestSeq: event.seq, board, content: update.content,
      updates: [...task.updates, update] });
  }
  const receipts = new Map(history.filter(event => event.type === 'source_delivery').map(event => [event.deliveryId, event]));
  return [...tasks.values()].map(task => {
    const candidate = finalsByTask.get(task.taskId);
    const final = candidate?.seq > task.boardUpdateSeq ? candidate : null;
    const parts = [...receipts.values()].filter(event => ((event.providerMessageId && event.providerMessageId === final?.providerMessageId
      && event.runId === final?.runId) || (event.workboardTaskId === task.taskId && event.workboardRevision === task.board.revision))
      && ['content', 'attachment'].includes(event.kind));
    if (!parts.length) return task;
    const expectedParts = Math.max(...parts.map(part => part.providerPartCount || 1));
    const deliveryState = parts.length >= expectedParts && parts.every(part => part.state === 'delivered' && part.externalId) ? 'delivered'
      : parts.some(part => ['delivery_failed', 'unknown'].includes(part.state)) ? 'failed' : 'pending';
    const board = { ...task.board, deliveryState };
    const seq = Math.max(task.latestSeq, ...parts.map(part => part.seq));
    return { ...task, board, latestSeq: seq, updates: [...task.updates,
      { seq, runId: task.runId, content: task.content, workboard: board }] };
  });
}

function reject(message, statusCode = 400) {
  const error = new Error(message); error.statusCode = statusCode; throw error;
}
export function normalizeWorkboardUpdate(input, { history = [], runId = '', text = '' } = {}) {
  const tasks = projectWorkboards(history);
  const taskId = trim(input?.taskId) || (runId ? `wb_${runId}` : '');
  if (!taskId || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(taskId)) reject('workboard.taskId is required (stable across continuation Runs)');
  const previous = tasks.find(task => task.taskId === taskId)?.board;
  const candidate = input || parseLegacyWorkboard(text, taskId);
  if (!candidate) reject('A workboard needs a goal and 2–5 title — acceptance lines');
  if (!Array.isArray(candidate.items) || candidate.items.length < 2 || candidate.items.length > 5) reject('workboard.items must contain 2–5 deliverables');
  const items = candidate.items.map((item, index) => ({ id: trim(item.id) || `item-${index + 1}`,
    title: trim(item.title), condition: trim(item.condition), status: trim(item.status) || 'pending',
    evidenceRefs: Array.isArray(item.evidenceRefs) ? [...new Set(item.evidenceRefs)] : [] }));
  const board = { taskId, revision: input?.revision ?? (previous?.revision || 0) + 1,
    goal: trim(candidate.goal), status: trim(candidate.status) || 'running', reason: trim(candidate.reason), items };
  if (JSON.stringify(board).length > 24000) reject('workboard is too large');
  if (!board.goal || !statuses.has(board.status) || new Set(items.map(item => item.id)).size !== items.length
      || items.some(item => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(item.id) || !item.title || !item.condition || !itemStatuses.has(item.status))) {
    reject('workboard goal, item IDs, conditions and explicit statuses are required');
  }
  // Replaying the exact same revision is idempotent; a conflicting/stale write is rejected.
  const stored = [...history].reverse().find(event => event.workboard?.taskId === taskId)?.workboard;
  if (stored && board.revision === stored.revision && JSON.stringify(board) === JSON.stringify(stored)) return { board, duplicate: true };
  if (!Number.isInteger(board.revision) || board.revision !== (previous?.revision || 0) + 1) reject('workboard revision conflict; read the latest snapshot and retry', 409);
  if (['partial', 'blocked', 'failed', 'cancelled'].includes(board.status) && !board.reason) reject('An unfinished outcome needs a reason');
  if (board.status === 'completed' && items.some(item => item.status !== 'done')) reject('completed requires every deliverable to be done');
  if (previous && (board.goal !== previous.goal || JSON.stringify(items.map(({ id, title, condition }) => ({ id, title, condition })))
      !== JSON.stringify(previous.items.map(({ id, title, condition }) => ({ id, title, condition })))) && !board.reason) reject('Changing the task scope requires a reason');
  const evidence = new Map(history.map(event => [event.seq, event]));
  for (const item of items) {
    for (const ref of item.evidenceRefs) {
      const event = evidence.get(ref);
      if (!Number.isInteger(ref) || !event || !['tool_result', 'artifact', 'message', 'file_change', 'source_delivery'].includes(event.type)
          || (event.type === 'message' && event.source === 'workboard_checklist')) reject(`Unknown or unsuitable evidence event: ${ref}`);
      if (item.status === 'done' && event.type === 'tool_result' && typeof event.exitCode === 'number' && event.exitCode !== 0) reject(`Failed tool result cannot verify a completed item: ${ref}`);
      if (item.status === 'done' && event.type === 'source_delivery' && (event.state !== 'delivered' || !event.externalId)) reject(`Unconfirmed delivery cannot verify a completed item: ${ref}`);
    }
    if (item.status === 'done' && !item.evidenceRefs.length) reject(`Completed item ${item.id} needs evidenceRefs (Session event sequence numbers); use --workboard-file`);
    const prior = previous?.items.find(old => old.id === item.id);
    if (prior?.status === 'done' && item.status !== 'done' && !board.reason) reject('Withdrawing a completed item requires a reason');
    if (prior?.status === 'done' && (prior.title !== item.title || prior.condition !== item.condition)
        && item.status === 'done' && JSON.stringify(prior.evidenceRefs) === JSON.stringify(item.evidenceRefs)) reject('Changed acceptance conditions require fresh verification');
  }
  return { board, duplicate: false };
}

export function projectWorkboardTranscript(history) {
  const tasks = projectWorkboards(history);
  const anchors = new Map(tasks.map(task => [task.anchorSeq, task]));
  const hasPublicBoard = tasks.length > 0;
  if (!hasPublicBoard) return history;
  return history.flatMap(event => {
    const task = anchors.get(event.seq);
    if (task) return [{ ...event, content: task.content, workboard: task.board,
      workboardUpdateSeq: task.latestSeq, workboardLastRunId: task.runId,
      workboardStatusLabel: workboardStatusLabel(task.board) }];
    if (event.source === 'workboard_checklist') return [];
    // Native execution plans remain internal when a public deliverable list exists.
    if (hasPublicBoard && event.messageKind === 'todo_list') return [{ ...event, messageKind: 'execution_plan' }];
    return [event];
  });
}

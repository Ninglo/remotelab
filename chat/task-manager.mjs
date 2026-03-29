import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { TASKS_FILE } from '../lib/config.mjs';

// In-memory task store
let tasks = [];

// Callback invoked when a blocked task becomes pending and has an assigned session.
// Injected by initTaskManager() — router provides the actual sendMessage function.
let _onTaskReady = null;

// ---- Helpers ----

function atomicWriteJSON(filepath, data) {
  const tmp = filepath + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filepath);
}

function loadTasks() {
  try {
    if (existsSync(TASKS_FILE)) {
      const raw = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
      tasks = Array.isArray(raw) ? raw : [];
    }
  } catch (err) {
    console.error('[TaskManager] Failed to load tasks.json:', err.message);
    tasks = [];
  }
}

function saveTasks() {
  try {
    atomicWriteJSON(TASKS_FILE, tasks);
  } catch (err) {
    console.error('[TaskManager] Failed to save tasks.json:', err.message);
  }
}

// ---- Dependency resolution ----

/**
 * Called whenever a task transitions to 'completed'.
 * Removes completedTaskId from blocked_by of all blocked tasks.
 * If a task's blocked_by becomes empty, it moves to 'pending' and
 * _onTaskReady is called if it has an assigned session.
 */
function resolveDependencies(completedTaskId) {
  let changed = false;
  for (const t of tasks) {
    if (t.status !== 'blocked') continue;
    if (!t.blocked_by.includes(completedTaskId)) continue;

    t.blocked_by = t.blocked_by.filter(id => id !== completedTaskId);

    if (t.blocked_by.length === 0) {
      t.status = 'pending';
      changed = true;
      console.log(`[TaskManager] Task "${t.id}" unblocked (all deps resolved)`);

      if (t.assigned_session_id && _onTaskReady) {
        // Fire-and-forget — don't let callback errors stop the loop
        Promise.resolve(_onTaskReady(t)).catch(err => {
          console.error(`[TaskManager] onTaskReady error for task ${t.id}:`, err.message);
        });
      }
    }
  }
  if (changed) saveTasks();
}

// ---- Public API ----

/**
 * Initialize the task manager.
 * @param {Function} onTaskReady - Called with (task) when a blocked task becomes pending.
 *   Signature: async (task) => void. Should send a message to task.assigned_session_id.
 */
export function initTaskManager(onTaskReady) {
  _onTaskReady = onTaskReady;
  loadTasks();
  console.log(`[TaskManager] Loaded ${tasks.length} task(s) from disk`);
}

/**
 * Create a new task.
 * Status is automatically set to 'blocked' if blocked_by is non-empty, else 'pending'.
 */
export function createTask({ subject, description = '', assigned_session_id = null, blocked_by = [], report_to = null, repo_path = null, worktree_path = null, branch = null }) {
  const id = randomBytes(8).toString('hex');
  const task = {
    id,
    subject,
    description,
    status: blocked_by.length > 0 ? 'blocked' : 'pending',
    assigned_session_id,
    blocked_by: [...blocked_by],
    report_to,
    repo_path,
    worktree_path,
    branch,
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  tasks.push(task);
  saveTasks();
  console.log(`[TaskManager] Created task "${id}" (${task.status}): ${subject}`);
  return task;
}

/**
 * Get a single task by ID. Returns null if not found.
 */
export function getTask(id) {
  return tasks.find(t => t.id === id) || null;
}

/**
 * List tasks, optionally filtered.
 * @param {Object} filters - { status?, assigned_session_id? }
 */
export function listTasks({ status, assigned_session_id } = {}) {
  let result = tasks;
  if (status) result = result.filter(t => t.status === status);
  if (assigned_session_id) result = result.filter(t => t.assigned_session_id === assigned_session_id);
  return result;
}

/**
 * Update a task's mutable fields.
 * Handles status transitions: sets completed_at, triggers dependency resolution.
 * @param {string} id - Task ID
 * @param {Object} updates - Partial task fields to update
 * @returns Updated task, or null if not found
 */
export function updateTask(id, updates) {
  const task = tasks.find(t => t.id === id);
  if (!task) return null;

  const prevStatus = task.status;

  if (updates.subject !== undefined) task.subject = updates.subject;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.assigned_session_id !== undefined) task.assigned_session_id = updates.assigned_session_id;
  if (updates.blocked_by !== undefined) task.blocked_by = updates.blocked_by;
  if (updates.status !== undefined) task.status = updates.status;
  if (updates.repo_path !== undefined) task.repo_path = updates.repo_path;
  if (updates.worktree_path !== undefined) task.worktree_path = updates.worktree_path;
  if (updates.branch !== undefined) task.branch = updates.branch;

  // Auto-set completed_at on first completion
  if (task.status === 'completed' && !task.completed_at) {
    task.completed_at = new Date().toISOString();
  }

  saveTasks();

  // Trigger dependency resolution if this task just completed
  if (prevStatus !== 'completed' && task.status === 'completed') {
    resolveDependencies(task.id);
  }

  return task;
}

/**
 * Delete a task by ID. Returns true if found and deleted.
 */
export function deleteTask(id) {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  saveTasks();
  return true;
}

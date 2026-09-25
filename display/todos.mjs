import { randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

const STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done']);
const EDITABLE = new Set(['title', 'note', 'dueAt', 'status', 'progress']);

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function text(value, limit, label, required = false) {
  if (typeof value !== 'string') invalid(`${label} must be text`);
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if ((required && !cleaned) || cleaned.length > limit) invalid(`Invalid ${label}`);
  return cleaned;
}

function fields(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid To do');
  if (Object.keys(input).some((key) => !EDITABLE.has(key))) invalid('Unknown To do field');
  const next = previous ? { ...previous } : { title: '', note: '', dueAt: null, status: 'todo', progress: null };
  if (!previous && !Object.hasOwn(input, 'title')) invalid('To do title is required');
  if (Object.hasOwn(input, 'title')) next.title = text(input.title, 120, 'title', true);
  if (Object.hasOwn(input, 'note')) next.note = text(input.note, 500, 'note');
  if (Object.hasOwn(input, 'dueAt')) {
    if (input.dueAt === null || input.dueAt === '') next.dueAt = null;
    else {
      if (typeof input.dueAt !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/i.test(input.dueAt)) invalid('Deadline needs an ISO time with timezone');
      const ms = Date.parse(input.dueAt);
      if (!Number.isFinite(ms)) invalid('Invalid deadline');
      next.dueAt = new Date(ms).toISOString();
    }
  }
  if (Object.hasOwn(input, 'status')) {
    if (!STATUSES.has(input.status)) invalid('Invalid To do status');
    next.status = input.status;
  }
  if (Object.hasOwn(input, 'progress')) {
    const progress = input.progress;
    if (progress === null) next.progress = null;
    else {
      if (!progress || typeof progress !== 'object' || Array.isArray(progress)
        || Object.keys(progress).some((key) => !['current', 'target', 'unit'].includes(key))) invalid('Invalid To do progress');
      const current = progress.current ?? previous?.progress?.current ?? 0;
      const target = progress.target ?? previous?.progress?.target;
      if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(target) || target < 1) invalid('Progress needs non-negative current and positive target');
      next.progress = { current, target, unit: progress.unit === undefined ? previous?.progress?.unit || '' : text(progress.unit, 24, 'unit') };
    }
  }
  return next;
}

function ordered(items) {
  return [...items].sort((left, right) => {
    if ((left.status === 'done') !== (right.status === 'done')) return left.status === 'done' ? 1 : -1;
    if (left.dueAt && right.dueAt) return Date.parse(left.dueAt) - Date.parse(right.dueAt);
    if (left.dueAt || right.dueAt) return left.dueAt ? -1 : 1;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function createTodoStore(file) {
  const mutate = createSerialTaskQueue();
  async function document() {
    const stored = await readJson(file, { version: 1, people: {} });
    if (stored?.version !== 1 || !stored.people || typeof stored.people !== 'object') throw Error('Invalid To do store');
    return stored;
  }
  async function save(stored) {
    await writeJsonAtomic(file, stored);
    await chmod(file, 0o600);
  }
  async function list(personId) {
    const stored = await document();
    return ordered(stored.people[personId] || []);
  }
  async function create(personId, input, sourceSessionId = '') {
    const valid = fields(input);
    return mutate(async () => {
      const stored = await document();
      const items = stored.people[personId] || [];
      if (items.length >= 300) invalid('To do limit reached');
      const now = new Date().toISOString();
      const item = { id: `todo_${randomBytes(8).toString('hex')}`, ...valid,
        sourceSessionId: sourceSessionId || null, createdAt: now, updatedAt: now,
        completedAt: valid.status === 'done' ? now : null };
      stored.people[personId] = [...items, item];
      await save(stored);
      return item;
    });
  }
  async function update(personId, id, input) {
    return mutate(async () => {
      const stored = await document();
      const item = stored.people[personId]?.find((entry) => entry.id === id);
      if (!item) return null;
      const valid = fields(input, item);
      Object.assign(item, valid, { updatedAt: new Date().toISOString() });
      item.completedAt = item.status === 'done' ? item.completedAt || item.updatedAt : null;
      await save(stored);
      return item;
    });
  }
  async function remove(personId, id) {
    return mutate(async () => {
      const stored = await document();
      const items = stored.people[personId] || [];
      if (!items.some((item) => item.id === id)) return false;
      stored.people[personId] = items.filter((item) => item.id !== id);
      await save(stored);
      return true;
    });
  }
  async function summary(personId) {
    const items = (await list(personId)).filter((item) => item.status !== 'done');
    return { available: true, openCount: items.length, items: items.slice(0, 8).map(({ id, title, status, dueAt, progress, updatedAt }) => ({ id, title, status, dueAt, progress, updatedAt })) };
  }
  return { list, create, update, remove, summary };
}

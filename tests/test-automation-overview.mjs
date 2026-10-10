import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({ Intl, Date });
vm.runInContext(await readFile(new URL('../static/chat/automation-overview.js', import.meta.url), 'utf8'), context);
const { category, purpose, days, purposes, businessStatus } = context.RemoteLabAutomationOverview;
const once = { kind: 'one_time', state: 'completed' };
assert.equal(category(once), 'one_time', 'completed one-time work remains discoverable as one-time');
assert.equal(category({ ...once, state: 'failed' }), 'one_time', 'a failed attempt does not change its type');
assert.equal(category({ ...once, state: 'admitted', lastExecution: { runAvailable: false } }), 'one_time');
assert.equal(category({ ...once, state: 'paused' }), 'stopped');
assert.equal(category({ ...once, state: 'cancelled' }), 'stopped');
assert.equal(category({ kind: 'recurring', state: 'active', lastExecution: { state: 'failed' } }), 'recurring');
assert.equal(category({ kind: 'recurring', state: 'completed' }), 'stopped', 'an expired repeating task is stopped');
assert.equal(category({ members: [{ kind: 'recurring', state: 'cancelled' }, { ...once, state: 'scheduled' }] }),
  'one_time', 'a pending explicit follow-up is still visible after its schedule stops');

for (const [title, expected] of [
  ['每日项目审阅', 'projects'], ['每周反馈复盘', 'improvement'], ['每日磁盘检查与必要清理（日报来源）', 'operations'],
  ['RoboDojo 自动报告', 'execution'], ['具身前沿追踪 · 张思源每日单独阅读', 'research'],
  ['张思源｜每晚新增个人记忆核验', 'memory'], ['每日项目 TODO 巡检', 'projects'], ['未分类任务', 'other'],
]) assert.equal(purpose({ title }), expected);
assert.equal(purpose({ title: '磁盘检查', purpose: 'projects' }), 'projects', 'explicit purpose wins over a misleading title');
assert.equal(purposes.length, 7, 'six purposes and an honest unclassified fallback');
assert.equal(purpose({ title: '普通任务', prompt: 'Review reports and check daily monitoring' }), 'other',
  'unrelated keywords in long instructions must not invent a purpose');

const now = Date.parse('2026-10-10T10:00:00Z');
const held = { kind: 'recurring', state: 'active', check: { at: '2026-10-10T09:59:00Z', reason: 'retry_limit_reached' } };
assert.equal(businessStatus(held, now), 'blocked');
assert.equal(businessStatus({ ...held, check: { ...held.check, reason: 'consumer_disabled' } }, now), 'disabled');
assert.equal(businessStatus({ ...held, check: { ...held.check, reason: 'no project due' } }, now), 'waiting');
assert.equal(businessStatus({ ...held, state: 'paused' }, now), null, 'native stop state takes precedence');
assert.equal(businessStatus({ ...held, check: { ...held.check, at: '2026-10-10T09:00:00Z' } }, now), null, 'stale business switches do not assert current state');
assert.equal(businessStatus({ ...held, check: { ...held.check, at: '2026-10-10T10:01:00Z' } }, now), null);
assert.equal(businessStatus({ ...held, check: { ...held.check, error: 'read failed' } }, now), null);
assert.equal(businessStatus({ ...held, check: { ...held.check, reason: 'ordinary prose about a failure' } }, now), null);

const entries = [
  { id: 'a', scheduledAt: '2026-10-03T10:00:00Z', state: 'completed', error: '', runtime: { model: 'fixture' } },
  { id: 'b', scheduledAt: '2026-10-02T20:00:00Z', state: 'failed', error: 'Full original error\nSecond line' },
  { id: 'c', scheduledAt: '2026-10-02T10:00:00Z', attemptedAt: '2026-10-03T00:00:00Z', state: 'running' },
  { id: 'd', scheduledAt: '2026-10-01T10:00:00Z', state: 'cancelled' },
  { id: 'unknown', state: 'admitted' },
];
const before = JSON.stringify(entries);
const grouped = days(entries, 'Asia/Shanghai');
const today = grouped.find(group => group.day === '2026-10-03');
assert.deepEqual(Array.from(today.records, entry => entry.id), ['a', 'b', 'c'],
  'calendar dates use the task timezone and actual attempts, including delayed execution');
assert.equal(days(entries, 'UTC').find(group => group.day === '2026-10-03').records.length, 2);
assert.equal(grouped.flatMap(group => group.records).length, entries.length, 'every record survives folding');
assert.equal(today.records[1], entries[1], 'full errors and all fields retain their original records');
assert.equal(JSON.stringify(entries), before, 'view grouping must never mutate execution truth');
assert.equal(days(entries, 'Invalid/Timezone').find(group => group.day === '2026-10-03').records.length, 3);
assert.equal(days([], 'UTC').length, 0, 'missing dates do not fabricate daily execution records');
console.log('Automation categories, purposes and complete daily history passed.');

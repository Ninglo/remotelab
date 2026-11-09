import { randomUUID } from 'node:crypto';
import { loadAuthDocument } from '../lib/auth-config.mjs';
import { MEMORY_DIR } from '../lib/config.mjs';
import { appendEvent } from './history.mjs';
import { applyLearningUpdates, learningPaths, readPersonalProfile, verifiedLearningPerson } from './memory-learning.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
async function owner(actor, memoryDir) {
  const authDocument = await loadAuthDocument({ persistMigration: false });
  if (actor?.authKind === 'service' || !verifiedLearningPerson({ ...actor, authDocument })) fail('请使用本人的登录账号审阅记忆。', 403);
  return { personId: actor.personId, identityId: actor.identityId, authDocument, memoryDir };
}
const publicEntry = e => ({ id: e.id, version: e.version, status: e.status,
  content: e.content, conditions: e.conditions || '', exceptions: e.exceptions || '', updatedAt: e.updatedAt });

export async function listPersonalMemories(actor, { memoryDir = MEMORY_DIR, after = '' } = {}) {
  const verified = await owner(actor, memoryDir);
  if (after && !/^mem_[a-f0-9]{16}$/.test(after)) fail('无效的记忆分页位置。');
  const profile = await readPersonalProfile(learningPaths(memoryDir, verified.personId).profile);
  const active = profile.entries.filter(e => e.status !== 'withdrawn').sort((a,b) => a.id.localeCompare(b.id));
  const page = active.filter(e => e.id > after).slice(0, 30);
  return { entries: page.map(publicEntry), total: active.length,
    next: page.length && active.some(e => e.id > page.at(-1).id) ? page.at(-1).id : '' };
}

export async function reviewPersonalMemory(input, actor, { memoryDir = MEMORY_DIR } = {}) {
  if (!input || Object.keys(input).some(k => !['id','expectedVersion','action','content','conditions','exceptions'].includes(k))
      || !/^mem_[a-f0-9]{16}$/.test(input.id || '') || !['keep','edit','delete'].includes(input.action)
      || !Number.isInteger(input.expectedVersion)) fail('无效的记忆操作。');
  const verified = await owner(actor, memoryDir);
  const profile = await readPersonalProfile(learningPaths(memoryDir, verified.personId).profile, { entryId: input.id, details: true });
  const entry = profile.entries.find(e => e.id === input.id);
  if (!entry) fail('找不到这条个人记忆。', 404);
  if (entry.version !== input.expectedVersion || entry.status === 'withdrawn') fail('记忆已更新，请重新读取后操作。', 409);
  const content = input.action === 'edit' ? input.content?.trim() : entry.content;
  const conditions = input.action === 'edit' ? input.conditions?.trim() || '' : entry.conditions;
  const exceptions = input.action === 'edit' ? input.exceptions?.trim() || '' : entry.exceptions;
  if (!content || content.length > 800 || conditions?.length > 500 || exceptions?.length > 500) fail('请填写记忆内容，并保持在长度限制内。');
  const statement = `${input.action === 'delete' ? '删除' : input.action === 'keep' ? '保留' : '保存修改'}：${content}\n适用时机：${conditions || ''}\n例外：${exceptions || ''}`;
  // Private audit namespace: no new conversational Session, message or notification.
  const sessionId = `personal_memory_${verified.personId}`;
  const runId = `memory_review_${randomUUID().replaceAll('-','')}`;
  const evidence = await appendEvent(sessionId, { type: 'memory_review_action', personId: verified.personId,
    identityId: verified.identityId, memoryId: entry.id, memoryVersion: entry.version,
    action: input.action, surface: 'personal-settings', content: statement });
  const result = await applyLearningUpdates({ ...verified,
    sources: [{ sessionId, runId, seq: evidence.seq, type: 'user', output: statement }],
    updates: [{ key: entry.key, kind: 'preference', action: input.action === 'delete' ? 'withdraw' : 'revise',
      explicit: true, expectedVersion: input.expectedVersion, content, conditions, exceptions, cues: entry.cues,
      reason: '本人在个人记忆设置中审阅', evidence: [{ seq: evidence.seq, quote: statement.slice(0,500) }] }] });
  if (!result.promotedCount) fail(result.rejected?.[0]?.reason || '记忆未保存。', 409);
  return { id: entry.id, status: input.action === 'delete' ? 'withdrawn' : 'confirmed', version: input.expectedVersion + 1 };
}

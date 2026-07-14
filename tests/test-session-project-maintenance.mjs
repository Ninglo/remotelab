#!/usr/bin/env node
import assert from 'assert/strict';
import {
  PROJECT_MAINTENANCE_INTERNAL_OPERATION,
  SESSION_LIST_ORGANIZER_INTERNAL_ROLE,
  buildProjectMaintenancePayload,
  createSessionProjectMaintenanceScheduler,
  evaluateProjectMaintenanceHealth,
  getSessionListOrganizerTargetProjectCount,
  getSessionListOrganizerTargetSpaceCount,
  isProjectMaintenanceScopedSession,
} from '../chat/session-project-maintenance.mjs';

function makeSession(id, group, extra = {}) {
  return {
    id,
    folder: '/tmp/remotelab',
    tool: 'fake-codex',
    sourceId: 'chat',
    sourceName: 'RemoteLab',
    name: extra.name || id,
    space: Object.prototype.hasOwnProperty.call(extra, 'space') ? extra.space : 'Work',
    group,
    description: extra.description || `${id} description`,
    created: extra.created || '2026-06-15T00:00:00.000Z',
    updatedAt: extra.updatedAt || '2026-06-15T00:00:00.000Z',
    ...extra,
  };
}

assert.equal(getSessionListOrganizerTargetProjectCount(18), 6);
assert.equal(getSessionListOrganizerTargetProjectCount(40), 8);
assert.equal(getSessionListOrganizerTargetSpaceCount(40), 3);

assert.equal(isProjectMaintenanceScopedSession(makeSession('chat', 'RemoteLab')), true);
assert.equal(isProjectMaintenanceScopedSession(makeSession('mail', 'Mail', { sourceId: 'gmail' })), false);
assert.equal(isProjectMaintenanceScopedSession(makeSession('internal', 'RemoteLab', { internalRole: 'session_list_organizer' })), false);
assert.equal(isProjectMaintenanceScopedSession(makeSession('archived', 'RemoteLab', { archived: true })), false);

const unhealthySessions = [
  makeSession('kol-ai', 'KOL AI 评级'),
  makeSession('kol-data', 'KOL 数据同步'),
  makeSession('kol-e2e', 'KOL E2E 自动化'),
  makeSession('kol-monitor', 'KOL 提醒与发布监控'),
  makeSession('growth-a', '增长验证与内容选题'),
  makeSession('growth-b', '增长验证与内容选题'),
  makeSession('feishu-audit', 'Feishu', { sourceId: 'feishu' }),
];

const unhealthyPayload = buildProjectMaintenancePayload(unhealthySessions, unhealthySessions[0]);
assert.equal(unhealthyPayload.totalSessions, 6, 'payload should scope to Chat UI sessions only');
assert.equal(unhealthyPayload.targetProjectCount, 4, 'payload should include a dynamic project-count budget');
assert.equal(unhealthyPayload.targetSpaceCount, 2, 'payload should include a compact Space-count budget');
assert.equal(unhealthyPayload.sessions[0].existingSpace, 'Work', 'payload should expose current Space as read-only context');
assert.equal(unhealthyPayload.groupSummary.singletonGroups, 4, 'payload should expose singleton project count');

const unhealthy = evaluateProjectMaintenanceHealth(unhealthySessions, unhealthySessions[0]);
assert.equal(unhealthy.shouldRun, true, 'over-split Chat UI sessions should trigger maintenance');
assert.ok(unhealthy.reasons.includes('singleton_ratio_high'));
assert.ok(unhealthy.reasons.includes('missing_sidebar_order'));

const healthySessions = [
  makeSession('remote-a', 'RemoteLab 产品整理', { sidebarOrder: 1 }),
  makeSession('remote-b', 'RemoteLab 产品整理', { sidebarOrder: 2 }),
  makeSession('kol-a', 'KOL Flow', { sidebarOrder: 3 }),
  makeSession('kol-b', 'KOL Flow', { sidebarOrder: 4 }),
];
const healthy = evaluateProjectMaintenanceHealth(healthySessions, healthySessions[0]);
assert.equal(healthy.shouldRun, false, 'already compact organized sessions should not trigger maintenance');

const missingSpaceSessions = healthySessions.map((session, index) => (
  index === 0 ? { ...session, space: '' } : session
));
const missingSpace = evaluateProjectMaintenanceHealth(missingSpaceSessions, missingSpaceSessions[0]);
assert.ok(missingSpace.reasons.includes('missing_space'), 'missing Space assignments should trigger AI maintenance');

const createdSessions = [];
const sentMessages = [];
const scheduler = createSessionProjectMaintenanceScheduler({
  debounceMs: 0,
  loadSessionsMeta: async () => unhealthySessions,
  createSession: async (folder, tool, name, extra) => {
    const session = {
      id: `organizer-${createdSessions.length + 1}`,
      folder,
      tool,
      name,
      ...extra,
    };
    createdSessions.push(session);
    return session;
  },
  sendMessage: async (sessionId, text, images, options) => {
    sentMessages.push({ sessionId, text, images, options });
    return { run: { id: 'run-project-maintenance' } };
  },
  logger: { log() {}, error(error) { throw new Error(error); } },
});

const queued = await scheduler.runProjectMaintenanceNow(unhealthySessions[0]);
assert.equal(queued, true, 'scheduler should queue organizer when health gate trips');
assert.equal(createdSessions.length, 1);
assert.equal(createdSessions[0].internalRole, SESSION_LIST_ORGANIZER_INTERNAL_ROLE);
assert.match(createdSessions[0].systemPrompt, /Project compression is allowed/);
assert.equal(sentMessages.length, 1);
assert.equal(sentMessages[0].sessionId, createdSessions[0].id);
assert.equal(sentMessages[0].options.internalOperation, PROJECT_MAINTENANCE_INTERNAL_OPERATION);
assert.match(sentMessages[0].text, /Current snapshot has 5 existing groups and 4 singleton groups/);
assert.match(sentMessages[0].text, /"sourceId": "chat"/);
assert.doesNotMatch(sentMessages[0].text, /feishu-audit/);

const healthyScheduler = createSessionProjectMaintenanceScheduler({
  loadSessionsMeta: async () => healthySessions,
  createSession: async () => {
    throw new Error('healthy sessions should not create organizer session');
  },
  sendMessage: async () => {
    throw new Error('healthy sessions should not send organizer message');
  },
  logger: { log() {}, error(error) { throw new Error(error); } },
});
assert.equal(await healthyScheduler.runProjectMaintenanceNow(healthySessions[0]), false);

console.log('test-session-project-maintenance: ok');

#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-state-model.js'),
  'utf8',
);
const i18nSource = readFileSync(
  join(repoRoot, 'static', 'chat', 'i18n.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-state-model.js',
});

const model = context.RemoteLabSessionStateModel;

assert.ok(model, 'session state model should attach to the global scope');

function createI18nContext() {
  const storage = new Map();
  const context = {
    console,
    navigator: {
      language: 'en',
      languages: ['en'],
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    document: {
      readyState: 'complete',
      documentElement: { lang: '' },
      querySelectorAll() {
        return [];
      },
    },
    dispatchEvent() {},
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(i18nSource, context, {
    filename: 'i18n.js',
  });
  return context;
}

const fallbackStringsMatch = source.match(/const fallbackStrings = \{([\s\S]*?)\n  \};/);
assert.ok(fallbackStringsMatch, 'session state model should define fallback strings');
const fallbackI18nKeys = [...fallbackStringsMatch[1].matchAll(/"([^"]+)":/g)].map((match) => match[1]);

const i18nContext = createI18nContext();
assert.ok(i18nContext.RemoteLabI18n, 'i18n runtime should attach to the global scope');
for (const language of ['en', 'zh-CN']) {
  i18nContext.RemoteLabI18n.setUiLanguagePreference(language);
  for (const key of fallbackI18nKeys) {
    assert.notEqual(
      i18nContext.RemoteLabI18n.t(key),
      key,
      `${language} i18n should include the session state key ${key}`,
    );
  }
}

function makeActivity(overrides = {}) {
  return {
    run: {
      state: 'idle',
      phase: null,
      startedAt: null,
      runId: null,
      cancelRequested: false,
      ...overrides.run,
    },
    queue: {
      state: 'idle',
      count: 0,
      ...overrides.queue,
    },
    compact: {
      state: 'idle',
      ...overrides.compact,
    },
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'session-test',
    activity: makeActivity(),
    ...overrides,
  };
}

const runningSession = makeSession({
  activity: makeActivity({
    run: { state: 'running', phase: 'accepted', runId: 'run-1' },
  }),
});
const runningStatus = model.getSessionStatusSummary(runningSession);
assert.equal(runningStatus.primary.key, 'running');
assert.equal(model.isSessionBusy(runningSession), true);

const runningWithStaleWaitingSession = makeSession({
  workflowState: 'waiting_user',
  workflowPriority: 'high',
  activity: makeActivity({
    run: { state: 'running', phase: 'running', runId: 'run-stale-waiting' },
  }),
});
assert.equal(
  model.getSessionAttentionBand(runningWithStaleWaitingSession),
  4,
  'live running activity should override a stale waiting-on-user workflow label',
);

const queuedSession = makeSession({
  activity: makeActivity({
    queue: { state: 'queued', count: 2 },
  }),
});
const queuedStatus = model.getSessionStatusSummary(queuedSession);
assert.equal(queuedStatus.primary.key, 'queued');
assert.equal(queuedStatus.primary.title, '2 follow-ups queued');
assert.equal(model.isSessionBusy(queuedSession), true);

const compactingSession = makeSession({
  activity: makeActivity({
    compact: { state: 'pending' },
  }),
});
assert.equal(model.getSessionStatusSummary(compactingSession).primary.key, 'compacting');
assert.equal(model.isSessionBusy(compactingSession), true);

assert.equal(model.normalizeSessionWorkflowPriority('P1'), 'high');
assert.equal(model.normalizeSessionWorkflowPriority('normal'), 'medium');
assert.equal(model.normalizeSessionWorkflowPriority('later'), 'low');

assert.equal(
  JSON.stringify(model.getWorkflowStatusInfo('waiting-user')),
  JSON.stringify({
    key: 'waiting_user',
    label: 'needs user',
    className: 'status-waiting-user',
    dotClass: '',
    itemClass: '',
    title: 'Blocked on user input',
  }),
  'workflow status info should be normalized from the canonical workflow-state model',
);
assert.equal(
  model.getWorkflowStatusInfo('actively running'),
  null,
  'unknown workflow states should not synthesize fake status badges',
);

const explicitHighPriority = model.getSessionWorkflowPriorityInfo(makeSession({ workflowPriority: 'urgent' }));
assert.equal(explicitHighPriority.key, 'high');
assert.equal(explicitHighPriority.rank, 3);

const workflowPriorityFallback = model.getSessionWorkflowPriorityInfo(
  makeSession({ workflowPriority: 'done-later' }),
);
assert.equal(workflowPriorityFallback.key, 'medium', 'unknown priority strings should fall back to medium attention');

const unreadDoneSession = makeSession({
  workflowState: 'done',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
});
assert.equal(model.hasSessionUnreadUpdate(unreadDoneSession), true, 'idle sessions updated after review should be marked unread');
assert.equal(model.getSessionReviewStatusInfo(unreadDoneSession)?.key, 'unread', 'unread sessions should expose a dedicated review badge');

const userOnlyUpdateSession = makeSession({
  workflowState: 'done',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T11:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
});
assert.equal(
  model.hasSessionUnreadUpdate(userOnlyUpdateSession),
  false,
  'new user messages or bookkeeping updates should not mark the session unread without a newer assistant reply',
);

const completeAndReviewed = makeSession({
  workflowState: 'done',
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T13:00:00.000Z',
});
assert.equal(model.isSessionCompleteAndReviewed(completeAndReviewed), true, 'completed sessions with no unseen updates should be de-emphasized');

const runningUnreadCandidate = makeSession({
  lastEventAt: '2026-03-14T13:00:00.000Z',
  lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
  lastReviewedAt: '2026-03-14T12:00:00.000Z',
  activity: makeActivity({
    run: {
      state: 'running',
      phase: 'running',
      startedAt: '2026-03-14T11:30:00.000Z',
      runId: 'run-review-1',
    },
  }),
});
assert.equal(model.hasSessionUnreadUpdate(runningUnreadCandidate), false, 'running sessions should not constantly become unread while streaming');

assert.ok(
  model.compareSessionListSessions(
    makeSession({ workflowPriority: 'high', updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ workflowPriority: 'low', updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'recency should win over workflow priority',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ pinned: true, workflowPriority: 'medium', updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ workflowPriority: 'medium', updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'the activity comparator should leave the separate pinned section to the sidebar',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ workflowPriority: 'medium', updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ workflowPriority: 'medium', updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'more recent sessions should sort first',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({ sidebarOrder: 1, updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ sidebarOrder: 3, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) > 0,
  'legacy organizer order must not override recency',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({
      workflowState: 'done',
      lastEventAt: '2026-03-14T13:00:00.000Z',
      lastAssistantMessageAt: '2026-03-14T13:00:00.000Z',
      lastReviewedAt: '2026-03-14T12:00:00.000Z',
    }),
    makeSession({
      lastEventAt: '2026-03-14T13:30:00.000Z',
      activity: makeActivity({
        run: {
          state: 'running',
          phase: 'running',
          startedAt: '2026-03-14T11:00:00.000Z',
          runId: 'run-2',
        },
      }),
    }),
  ) > 0,
  'unread completed work must not overtake newer activity',
);

assert.ok(
  model.compareSessionListSessions(
    makeSession({
      lastEventAt: '2026-03-14T13:30:00.000Z',
      activity: makeActivity({
        run: {
          state: 'running',
          phase: 'running',
          startedAt: '2026-03-14T09:00:00.000Z',
          runId: 'run-older',
        },
      }),
    }),
    makeSession({
      lastEventAt: '2026-03-14T11:15:00.000Z',
      activity: makeActivity({
        run: {
          state: 'running',
          phase: 'running',
          startedAt: '2026-03-14T10:00:00.000Z',
          runId: 'run-newer',
        },
      }),
    }),
  ) < 0,
  'running and idle sessions should use the same latest activity timestamp',
);

const chronologicalSessions = [
  makeSession({ id: 'older-unread', lastEventAt: '2026-03-14T12:00:00Z',
    lastAssistantMessageAt: '2026-03-14T12:00:00Z', workflowState: 'waiting_user' }),
  makeSession({ id: 'newer-reviewed', lastEventAt: '2026-03-14T13:00:00Z',
    lastReviewedAt: '2026-03-14T13:00:00Z', workflowState: 'done' }),
];
const chronologicalIds = () => chronologicalSessions.slice().sort(model.compareSessionListSessions).map(s => s.id);
assert.deepEqual(chronologicalIds(), ['newer-reviewed', 'older-unread']);
chronologicalSessions[0].localReviewedAt = '2026-03-14T14:00:00Z';
assert.equal(model.getSessionReviewStatusInfo(chronologicalSessions[0]), null);
assert.deepEqual(chronologicalIds(), ['newer-reviewed', 'older-unread'], 'clicking to read must not move a row');
chronologicalSessions[0].lastReviewedAt = chronologicalSessions[0].localReviewedAt;
chronologicalSessions[0].updatedAt = '2026-03-14T14:00:00Z';
chronologicalSessions[0].activity = makeActivity({ run: { state: 'running', startedAt: '2026-03-14T14:00:00Z' } });
assert.deepEqual(chronologicalIds(), ['newer-reviewed', 'older-unread'], 'metadata and run state must not reorder rows');
chronologicalSessions[0].lastEventAt = '2026-03-14T15:00:00Z';
assert.deepEqual(chronologicalIds(), ['older-unread', 'newer-reviewed'], 'new activity should move a row to the top');
assert.ok(model.compareSessionListSessions({ id: 'a' }, { id: 'b' }) < 0, 'equal timestamps need a stable ID tie breaker');
assert.equal(model.getSessionSortTime({ lastEventAt: 'invalid', updatedAt: '2026-03-14T12:00:00Z' }),
  Date.parse('2026-03-14T12:00:00Z'), 'invalid timestamps should fall back to usable activity metadata');

const toolFallbackStatus = model.getSessionStatusSummary(
  makeSession({ tool: 'codex' }),
  { includeToolFallback: true },
);
assert.equal(toolFallbackStatus.primary.key, 'tool');
assert.equal(toolFallbackStatus.primary.label, 'codex');

const idleStatus = model.getSessionStatusSummary(makeSession());
assert.equal(idleStatus.primary.key, 'idle');
assert.equal(idleStatus.primary.label, 'idle');

console.log('test-chat-session-state-model: ok');

#!/usr/bin/env node
import assert from 'assert/strict';

import {
  archiveSession,
  buildUniqueTitle,
  createSmokeSession,
  deleteAgendaEvent,
  ensureSmokeAgentAvailable,
  extractAgendaEventIdFromEvents,
  findAgendaEventByTitle,
  getAgendaEvent,
  loadSessionEvents,
  parseArgs,
  resolveSmokeAgentConfig,
  submitSmokeMessage,
} from './live-agent-smoke-helpers.mjs';

const options = parseArgs(process.argv.slice(2));
const smokeAgent = resolveSmokeAgentConfig(options);
ensureSmokeAgentAvailable(smokeAgent);

const sessionName = 'agenda agent live smoke';
const title = buildUniqueTitle('RL agenda live smoke');
const start = trimString(options.start) || '2030-01-02T09:00:00+08:00';
const expectedStartUtc = '2030-01-02T01:00:00.000Z';

let sessionId = '';
let eventId = '';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

try {
  const session = createSmokeSession({
    name: sessionName,
    description: 'Live agenda creation smoke using a low-cost agent configuration.',
    tool: smokeAgent.tool,
  });
  sessionId = trimString(session?.id);
  assert.ok(sessionId, 'smoke session should be created');

  const text = [
    '请只做一件事：使用当前支持的日历创建流程，创建一个测试日程。',
    `标题必须是：${title}`,
    `开始时间必须是：${start}`,
    '时长 30 分钟。',
    '创建成功后，只回复标题和绝对时间。',
    '不要改代码。',
  ].join('\n');

  const submit = submitSmokeMessage(sessionId, {
    text,
    tool: smokeAgent.tool,
    model: smokeAgent.model,
    effort: smokeAgent.effort,
    thinking: smokeAgent.thinking,
  });
  assert.equal(submit.awaitedRun?.state, 'completed', 'smoke run should complete successfully');
  assert.match(trimString(submit.reply || ''), new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const allEvents = loadSessionEvents(sessionId, { filter: 'all' }).events || [];
  const extracted = extractAgendaEventIdFromEvents(allEvents, title);
  assert.ok(extracted.toolUse, 'smoke run should invoke bash with remotelab agenda add');
  assert.ok(
    /remotelab agenda add --title/.test(trimString(extracted.toolUse.toolInput)),
    'smoke run should use the fixed remotelab agenda command',
  );
  assert.ok(
    !/cli\.js agenda add/.test(trimString(extracted.toolUse.toolInput)),
    'smoke run should not fall back to node cli.js for agenda add on a healthy host',
  );
  assert.ok(extracted.toolResult, 'smoke run should emit a tool result for agenda creation');

  eventId = trimString(extracted.eventId);
  if (!eventId) {
    const fallbackEvent = findAgendaEventByTitle(title);
    eventId = trimString(fallbackEvent?.id || fallbackEvent?.uid || fallbackEvent?.externalId);
  }
  assert.ok(eventId, 'smoke run should produce a concrete agenda event id');

  const event = getAgendaEvent(eventId);
  assert.ok(event, 'created agenda event should be readable through remotelab agenda get');
  assert.equal(trimString(event.summary || event.title), title, 'agenda event title should match the requested title');
  assert.equal(trimString(event.startTime), expectedStartUtc, 'agenda event start time should match the requested absolute time');

  console.log(JSON.stringify({
    status: 'ok',
    sessionId,
    runId: submit.awaitedRun?.id || submit.run?.id || null,
    tool: smokeAgent.tool,
    model: smokeAgent.model || null,
    effort: smokeAgent.effort || null,
    eventId,
    title,
    start,
    expectedStartUtc,
  }, null, 2));
} finally {
  if (eventId) {
    try {
      deleteAgendaEvent(eventId);
    } catch {}
  }
  if (sessionId) {
    try {
      archiveSession(sessionId);
    } catch {}
  }
}

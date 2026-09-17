#!/usr/bin/env node
import assert from 'assert/strict';

const { buildDelegationHandoff, buildDelegationNotice } = await import('../chat/session-context-compaction.mjs');

const handoff = buildDelegationHandoff({
  source: { id: 'parent-session-123' },
  task: 'Create a new independent bug workflow for the current issue. Do not merge into existing issue threads.',
});

assert.match(handoff, /^Delegation handoff:/);
assert.match(handoff, /already in the delegated target session/i);
assert.match(handoff, /exactly one focused task/i);
assert.match(handoff, /Complete it directly in this session/);
assert.match(handoff, /Do NOT use session-spawn or delegate further/);
assert.match(handoff, /Create a new independent bug workflow for the current issue\./);
assert.match(handoff, /Parent session id: parent-session-123/);

// Test without source id
const handoffNoSource = buildDelegationHandoff({
  source: {},
  task: 'Simple task',
});
assert.match(handoffNoSource, /^Delegation handoff:/);
assert.ok(!handoffNoSource.includes('Parent session id:'), 'Should not include parent session id when empty');

const chineseHandoff = buildDelegationHandoff({
  source: { id: 'parent-session-zh' },
  sourceText: '请把这个独立问题交给新会话处理，后续也继续用中文沟通。',
  task: 'Repair the monitoring notification route and retain all verification evidence.',
});
assert.match(chineseHandoff, /^任务交接：/);
assert.match(chineseHandoff, /你已经位于本任务的独立目标会话中/);
assert.match(chineseHandoff, /请直接在本会话完成/);
assert.match(chineseHandoff, /不要使用 session-spawn，也不要继续创建子会话/);
assert.match(chineseHandoff, /Repair the monitoring notification route/);
assert.match(chineseHandoff, /父会话 ID：parent-session-zh/);
assert.doesNotMatch(chineseHandoff, /Delegation handoff|Parent session id/);

const chineseTaskHandoff = buildDelegationHandoff({
  source: {},
  task: '修复监控通知路由，并保留全部验证证据。',
});
assert.match(chineseTaskHandoff, /^任务交接：/);

const chineseNotice = buildDelegationNotice({
  sourceText: '请创建一个独立会话处理这个问题。',
  task: 'Investigate the handoff language bug.',
  childName: '修复交接语言',
  targetUrl: '/?session=child-zh&tab=sessions',
});
assert.match(chineseNotice, /^已为这项工作创建独立会话。/);
assert.match(chineseNotice, /- 任务：Investigate the handoff language bug\./);
assert.match(chineseNotice, /- 会话：\[修复交接语言\]/);
assert.match(chineseNotice, /- 打开：\/\?session=child-zh&tab=sessions/);
assert.doesNotMatch(chineseNotice, /Spawned a parallel session|- Task:|- Open:/);

console.log('test-session-delegation-handoff: ok');

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const fixture = await mkdtemp(join(tmpdir(), 'automation-home-run-'));
process.env.REMOTELAB_CONFIG_DIR = fixture;
const { createTrigger, ensureExecutionSession } = await import('../chat/triggers.mjs');
const { prepareAutomationHomeRun } = await import('../chat/automation-home.mjs');
const { mutateAutomationHome, readAutomationHome, automationDefinition } = await import('../chat/automation-home-store.mjs');
const { getSession } = await import('../chat/session-manager.mjs');
try {
  const taskId = 'sch_1234567890abcdef12345678', homeId = '1234567890abcdef1234567890abcdef';
  const trigger = await createTrigger({text:'original goal',scheduleId:taskId,scheduledAt:'2026-10-12T00:00:00Z',
    sessionTemplate:{folder:'/tmp',tool:'codex',sessionCollection:'automations'}});
  await mutateAutomationHome(taskId, () => ({taskId,sessionId:homeId,author:{name:'Creator'},taskCreatedAt:'2026-10-01T00:00:00Z',
    definitions:[{revision:1,definition:automationDefinition(trigger)}],runs:{}}));
  const execution = await ensureExecutionSession(trigger);
  const initial = await prepareAutomationHomeRun(execution.trigger,execution.session);
  assert.ok(initial.includes(homeId));
  assert.ok(initial.includes('定义版本：1'));
  assert.equal((await getSession(execution.session.id)).automationHomeSessionId,homeId);
  await mutateAutomationHome(taskId, home => {home.definitions.push({revision:2,definition:{text:'new goal'}});return home;});
  assert.equal(await prepareAutomationHomeRun(execution.trigger,execution.session),initial,'retry retains original definition association');
  const saved = await readAutomationHome(taskId);
  assert.equal(saved.runs[trigger.id].definition.text,'original goal');
  assert.equal(saved.runs[trigger.id].revision,1);
  const untouched = await createTrigger({text:'unselected',scheduledAt:'2026-10-13T00:00:00Z',sessionTemplate:{folder:'/tmp',tool:'codex'}});
  const separate = await ensureExecutionSession(untouched);
  assert.equal(await prepareAutomationHomeRun(separate.trigger,separate.session),'');
  assert.equal((await getSession(separate.session.id)).automationHomeSessionId,undefined);
  console.log('Automation home: isolated execution linkage, frozen retry definition and opt-in boundary passed');
} finally { await rm(fixture,{recursive:true,force:true}); }

import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const testRoot = await mkdtemp(join(tmpdir(), 'automation-delivery-test-'));
process.env.REMOTELAB_CONFIG_DIR = join(testRoot, 'config');
process.env.REMOTELAB_MEMORY_DIR = join(testRoot, 'memory');
const { CONFIG_DIR } = await import('../lib/config.mjs');
const { automationDeliveryOptions, enrichAutomationDelivery, setAutomationDelivery } = await import('../chat/automation-delivery.mjs');
try {
const task = { id: 'sch_' + 'a'.repeat(24), resultDelivery: { mode: 'conversation', connector: 'feishu', sourceRouteId: 'bot-a', target: {chatId:'oc_shared'} } };
const occurrence = { id: 'trg_' + 'b'.repeat(24), scheduleId: task.id };
const taskBefore = JSON.stringify(task);
assert.deepEqual(await automationDeliveryOptions(occurrence), {});
let value = await setAutomationDelivery(task, {enabled:false, expectedRevision:0}, {personId:'person_a'});
assert.equal(value.revision, 1);
assert.deepEqual(await automationDeliveryOptions(occurrence), {suppressSourceDelivery:true}, 'old pending occurrences read the current parent setting');
assert.deepEqual(await automationDeliveryOptions({id:'trg_other'}), {}, 'unrelated tasks are unaffected');
await assert.rejects(setAutomationDelivery(task,{enabled:true,expectedRevision:0}), /reload/);
await assert.rejects(setAutomationDelivery(task,{enabled:'false',expectedRevision:1}), /required/);
await assert.rejects(setAutomationDelivery({id:'other',resultDelivery:{mode:'remotelab'}},{enabled:false,expectedRevision:0}), /no platform/);
assert.equal(JSON.stringify(task),taskBefore,'settings never rewrite task routing or prompt');
const session = (route,name,at='2026-01-01') => ({updatedAt:at,conversation:{connector:'feishu',sourceRouteId:route,target:{chatId:'oc_shared'}},sourceContext:{chatId:'oc_shared',chatName:name,sourceRouteId:route}});
const [projected] = await enrichAutomationDelivery([structuredClone(task)], {sessions:[session('bot-a','Current name','2026-03-01'),session('bot-a','Old name'),session('bot-b','Other bot','2026-04-01')]});
assert.equal(projected.deliveryRecipient,'Current name');
assert.equal(projected.deliveryControl.enabled,false);
assert.equal(projected.deliveryControl.revision,1);
await setAutomationDelivery(task,{enabled:true,expectedRevision:1});
assert.deepEqual(await automationDeliveryOptions(occurrence),{});
const stored=JSON.parse(await readFile(join(CONFIG_DIR,'automation-delivery-settings.json'),'utf8'));
assert.equal(stored.tasks[task.id].history.length,2);
assert.equal(stored.tasks[task.id].history[0].personId,'person_a');
await writeFile(join(CONFIG_DIR,'automation-delivery-settings.json'),'{invalid');
await assert.rejects(automationDeliveryOptions(occurrence),'broken settings must never silently enable delivery');
console.log('Automation delivery: scoped names, durable toggle, conflicts, restore, pending occurrences and fail-closed reads passed.');

} finally { await rm(testRoot, {recursive:true,force:true}); }

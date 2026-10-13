import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { automationDefinitionHash, automationBackgroundHash, listAutomationFlows } from '../chat/automation-flows.mjs';
const task = { id: 'sch_fixture', prompt: 'Read the original record', schedule: { type: 'cron', cron: '0 4 * * *', timezone: 'Asia/Shanghai' }, target: {mode:'new_session'}, resultDelivery:{mode:'remotelab'} };
const before=JSON.stringify(task);
const config={version:1,groups:[{id:'memory',read:'Original source',rows:[{title:'Review',taskIds:[task.id],definitions:{[task.id]:automationDefinitionHash(task)},process:'Review evidence',write:'Original record',send:'Original recipient',links:[{title:'Unsafe',url:'javascript:alert(1)'},{title:'Credential URL',url:'https://user:pass@example.test'},{title:'Safe',url:'https://example.test/report'}]}]}]};
const load=async()=>JSON.stringify(config);
let result=await listAutomationFlows([task],{load});
assert.equal(result.groups[0].rows[0].needsReview,false);
assert.equal(result.groups[0].rows[0].links.length,1);
assert.equal(result.groups[0].rows[0].links[0].title,'Safe');
for(const patch of [{prompt:'Changed instructions'},{schedule:{...task.schedule,cron:'0 5 * * *'}},{target:{mode:'fixed_session'}},{resultDelivery:{mode:'source_conversation'}},{gate:{mode:'script',snapshotSha256:'changed'}},{wakeOn:['foreground_idle']},{automationPolicy:{minIdleSeconds:300}}]){
 result=await listAutomationFlows([{...task,...patch}],{load});assert.equal(result.groups[0].rows[0].needsReview,true);
}
result=await listAutomationFlows([{...task,nextRunAt:'2030-01-01',state:'paused',summary:{totalRuns:10}}],{load});assert.equal(result.groups[0].rows[0].needsReview,false,'runtime churn does not invalidate the definition');
assert.equal((await listAutomationFlows([],{load})).groups[0].rows[0].needsReview,true,'missing task cannot masquerade as reviewed');
assert.deepEqual(await listAutomationFlows([],{load:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'})}}),{groups:[],unavailable:false});
assert.deepEqual(await listAutomationFlows([],{load:async()=>'{bad'}),{groups:[],unavailable:true});
config.groups[0].rows.push(null);config.groups[0].rows[0].links.push(null);
assert.equal((await listAutomationFlows([task],{load})).groups[0].rows.length,1);
assert.equal(JSON.stringify(task),before,'projection does not mutate producers');
console.log('Flow descriptions: source drift, missing/broken config, safe links, runtime churn and read-only projection passed.');

const background = {id:'resource-check',title:'Resource observer',trigger:'Every minute',note:'Reuse existing alerts',state:'running'};
config.groups.push({id:'operations',readAt:'Continuous',rows:[{title:'Alerts',backgroundIds:[background.id],definitions:{[background.id]:automationBackgroundHash(background)}}]});
result=await listAutomationFlows([task],{load,backgroundMechanisms:[background]});
assert.equal(result.groups[1].rows[0].needsReview,false);
assert.deepEqual(result.groups[1].rows[0].backgroundIds,[background.id]);
assert.equal((await listAutomationFlows([task],{load,backgroundMechanisms:[{...background,state:'failed'}]})).groups[1].rows[0].needsReview,false);
assert.equal((await listAutomationFlows([task],{load,backgroundMechanisms:[{...background,trigger:'Every hour'}]})).groups[1].rows[0].needsReview,true);
assert.equal((await listAutomationFlows([task],{load})).groups[1].rows[0].needsReview,true);
console.log('Background bindings: live states, changed cadence and missing sources passed.');
config.language='zh-CN';config.groups[0].rows[0].writeDetails='Original path /data/project.md';
result=await listAutomationFlows([task],{load});
assert.equal(result.language,'zh-CN');assert.equal(result.groups[0].rows[0].writeDetails,'Original path /data/project.md');
config.language='invalid';assert.equal((await listAutomationFlows([task],{load})).language,'');

// A displayed plan is bounded inert content, not a task definition or scheduler change.
config.groups[0].plan={title:'Shared project context',status:'Execution changes pending',stages:[
  null,{connector:'Ready context is reused',kind:'shared',nodes:[null,{title:'Context <script>bad()</script>',lines:['Evidence and sources',null,{}]}]},
  {connector:'Independent consumers',kind:'executable',nodes:[{title:'Tasks',lines:['Read current task status']}],run:{command:'must not execute'}},
],run:{command:'must not execute'}};
const planned=await listAutomationFlows([task],{load});
assert.equal(planned.groups[0].plan.status,'Execution changes pending');
assert.equal(planned.groups[0].plan.stages.length,2);
assert.equal(planned.groups[0].plan.stages[0].nodes[0].title,'Context <script>bad()</script>');
assert.deepEqual(planned.groups[0].plan.stages[0].nodes[0].lines,['Evidence and sources']);
assert.equal(planned.groups[0].plan.stages[1].kind,'');
assert.equal(planned.groups[0].plan.run,undefined);
assert.equal(planned.groups[0].plan.stages[1].run,undefined);
assert.equal(JSON.stringify(task),before);
config.groups[0].plan={stages:'invalid'};
assert.equal((await listAutomationFlows([task],{load})).groups[0].plan,null,'invalid optional plan leaves task rows available');
console.log('Plan projection preserves explicit pending status, inert text and original task state.');

config.groups[0].rows[0].delivery={recipient:'Named group',condition:'After publication',format:'Rich text',content:'Changes and links',control:'Workflow owned',execute:'never'};
const delivery=(await listAutomationFlows([task],{load})).groups[0].rows[0].delivery;
assert.equal(delivery.recipient,'Named group');
assert.equal(delivery.execute,undefined);
assert.equal(JSON.stringify(task),before);

config.groups[0].rows[0].trigger='Only when new material is ready';
assert.equal((await listAutomationFlows([task],{load})).groups[0].rows[0].trigger,config.groups[0].rows[0].trigger);

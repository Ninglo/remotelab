import test from 'node:test';
import assert from 'node:assert/strict';
import { accountContinuity, continuityAttention } from '../lib/monitoring-actions.mjs';
import { dispatchMonitoringAlerts, renderMonitoringAlert } from '../chat/monitoring-alerts.mjs';
import { monitoringNotificationDecision } from '../lib/monitoring-policy.mjs';

const now=Date.parse('2026-10-30T11:00:00Z'), policy={lastAccountWarningPercent:30};
const account=(id,remainingPercent,extra={})=>({id,identityId:id,label:id,account:{type:'chatgpt'},usage:{status:'ready',checkedAt:new Date(now).toISOString(),buckets:[{id:'codex',primary:{remainingPercent,resetsAt:new Date(now+86400000).toISOString()}}]},...extra});
const runtime=accounts=>({activeId:accounts[0].id,autoSwitch:true,accounts});
const continuity=(accounts,options=policy)=>accountContinuity(runtime(accounts),now,options);
function snapshot(accounts){const c=continuity(accounts);return {generatedAt:new Date(now).toISOString(),accountContinuity:c,attention:continuityAttention(c),disks:[],services:[],accounts:[],coverage:{gaps:[]},automations:{items:[]}};}
function fixture(){let state=null,sends=0;const rendered=[];return {options:{config:{enabled:true,chatId:'oc_ops',confirmationObservations:3,accountAlerts:{enabled:true},noisePolicy:{mode:'risk_only'}},now,load:async()=>structuredClone(state),save:async(_,v)=>{state=structuredClone(v);},send:async(events,config)=>{sends++;rendered.push(renderMonitoringAlert(events,config));return 'om_'+sends;},update:async(_,__,id)=>id},getState:()=>state,getSends:()=>sends,rendered};}

test('threshold is inclusive, opt-in, and only the last account above the existing reserve triggers',()=>{
 assert.equal(continuity([account('a',30)],{}).lastAccountWarning,undefined);
 assert.equal(continuity([account('a',31),account('b',0)]).lastAccountWarning.state,'ready');
 assert.equal(continuity([account('a',30),account('b',0)]).lastAccountWarning.state,'low');
 assert.equal(continuity([account('a',30),account('b',20)]).lastAccountWarning.state,'ready');
 assert.equal(continuity([account('a',30),account('b',10)]).lastAccountWarning.state,'low');
 assert.equal(continuity([account('a',5),account('b',0)]).lastAccountWarning.state,'low');
});
test('account pool is deduplicated and the last account need not be the default',()=>{
 const c=continuity([account('old',0),account('last',30),account('alias',30,{identityId:'last'})]);
 assert.equal(c.lastAccountWarning.usableAccountCount,1);assert.equal(c.lastAccountWarning.account.id,'last');
 assert.equal(c.remainingPercent,0);assert.equal(c.lastAccountWarning.remainingPercent,30);
});
test('unknown, expired or missing quota does not prove this is the last account; signed-out slots are excluded',()=>{
 const stale=account('b',0);stale.usage.checkedAt=new Date(now-61000).toISOString();
 assert.equal(continuity([account('a',30),stale]).lastAccountWarning.state,'unknown');
 stale.usage.checkedAt=new Date(now).toISOString();stale.usage.buckets[0].primary.resetsAt=new Date(now-1000).toISOString();
 assert.equal(continuity([account('a',30),stale]).lastAccountWarning.state,'unknown');
 assert.equal(continuity([account('a',30),{id:'empty',account:null}]).lastAccountWarning.state,'low');
});
test('first valid low observation sends immediately, survives repetition and says prepare reset or new account',async()=>{
 for(const riskOnly of [true,false]){
  const f=fixture();if(!riskOnly)delete f.options.config.noisePolicy;
  const s=snapshot([account('last',30),account('old',0)]);
  await dispatchMonitoringAlerts({...f.options,snapshot:s});assert.equal(f.getSends(),1);
  await dispatchMonitoringAlerts({...f.options,snapshot:s});assert.equal(f.getSends(),1);
  assert.match(f.rendered[0],/账号即将耗尽，请准备重置或购入新账号/);assert.match(f.rendered[0],/last 剩余 30%/);
 }
});
test('unknown samples and default switches do not rearm; real replenishment does',async()=>{
 const f=fixture();await dispatchMonitoringAlerts({...f.options,snapshot:snapshot([account('a',30),account('b',0)])});
 const stale=account('a',30);stale.usage.checkedAt=new Date(now-61000).toISOString();
 await dispatchMonitoringAlerts({...f.options,snapshot:snapshot([stale,account('b',0)])});
 await dispatchMonitoringAlerts({...f.options,snapshot:snapshot([account('b',0),account('a',28)])});assert.equal(f.getSends(),1);
 await dispatchMonitoringAlerts({...f.options,snapshot:snapshot([account('a',80),account('b',0)])});
 await dispatchMonitoringAlerts({...f.options,snapshot:snapshot([account('a',30),account('b',0)])});assert.equal(f.getSends(),2);
});
test('pre-existing baseline cannot swallow the newly configured advance warning',async()=>{
 const f=fixture();const old=snapshot([account('a',20)]);old.accountContinuity=continuity([account('a',20)],{});old.attention=continuityAttention(old.accountContinuity);
 await dispatchMonitoringAlerts({...f.options,snapshot:old,baseline:true});
 await dispatchMonitoringAlerts({...f.options,snapshot:snapshot([account('a',20)])});assert.equal(f.getSends(),1);
});
test('mute and uncertain delivery retain the existing protections',async()=>{
 const f=fixture(),s=snapshot([account('a',30)]);
 await dispatchMonitoringAlerts({...f.options,config:{...f.options.config,enabled:false},snapshot:s});assert.equal(f.getSends(),0);
 const g=fixture();await dispatchMonitoringAlerts({...g.options,snapshot:s,send:async()=>{throw Error('uncertain');}});
 await dispatchMonitoringAlerts({...g.options,snapshot:s});assert.equal(g.getSends(),0);
 assert.equal(monitoringNotificationDecision({kind:'accountContinuity',continuity:s.accountContinuity},{policy:{mode:'risk_only'}}).confirmations,1);
});

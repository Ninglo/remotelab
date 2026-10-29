import test from 'node:test';
import assert from 'node:assert/strict';
import { collectServiceIncidents, mergeServiceJournal, serviceIncidentAttention } from '../chat/service-incidents.mjs';
import { dispatchMonitoringAlerts, renderMonitoringAlert } from '../chat/monitoring-alerts.mjs';
const unit = 'example.service';
const row = (MESSAGE, n, other={}) => ({ MESSAGE, __CURSOR: `cursor${n}`, __REALTIME_TIMESTAMP: String(1_790_000_000_000_000+n*1000), ...other });
const rows = [row('FATAL ERROR: JavaScript heap out of memory',1,{_SYSTEMD_INVOCATION_ID:'inv'}),
 row(`${unit}: Main process exited, code=dumped, status=6/ABRT`,2,{UNIT:unit,INVOCATION_ID:'inv'}),
 row(`${unit}: Scheduled restart job, restart counter is at 1.`,3,{UNIT:unit,INVOCATION_ID:'inv'})];
test('one crash survives rapid restart and observer restart, without duplicate alert or false root-cause resolution', async()=>{
 const events=mergeServiceJournal([],rows,unit);
 assert.equal(events.length,1); assert.equal(events[0].evidence.length,3);
 assert.equal(events[0].reason,'javascript_heap_oom'); assert.equal(events[0].automaticRestart,true);
 assert.deepEqual(mergeServiceJournal(events,rows,unit),events);
 let state=null,sends=0;
 const services=[{unit,status:'healthy',label:'App'}];
 const attention=serviceIncidentAttention(events,services);
 const snapshot={generatedAt:new Date().toISOString(),attention,services,disks:[],accounts:[],coverage:{gaps:[]},automations:{items:[]}};
 const options={config:{confirmationObservations:5,noisePolicy:{mode:'risk_only'}},snapshot,
 load:async()=>structuredClone(state), save:async(_,s)=>{state=structuredClone(s)},send:async()=>{sends++;return 'om_test'},update:async()=> 'om_test'};
 await dispatchMonitoringAlerts(options); assert.equal(sends,1,'durable crash must bypass five-sample threshold');
 await dispatchMonitoringAlerts(options); assert.equal(sends,1);
 assert.equal(Object.values(state.incidents)[0].event.recovered,undefined);
 assert.match(renderMonitoringAlert(attention,{}),/根因|原因仍需/);
 const next=mergeServiceJournal(events,[row('FATAL ERROR: JavaScript heap out of memory',4,{_SYSTEMD_INVOCATION_ID:'new'})],unit);
 await dispatchMonitoringAlerts({...options,snapshot:{...snapshot,attention:serviceIncidentAttention(next,services)}});
 assert.equal(sends,2,'a new invocation rearms even if the service is healthy');
});
test('normal stop is not a crash; cursor is durable and failed reads never advance it',async()=>{
 assert.deepEqual(mergeServiceJournal([],[row(`${unit}: Main process exited, code=exited, status=0/SUCCESS`,1,{UNIT:unit})],unit),[]);
 const disk=new Map(); let calls=0;
 const options={services:[{unit,scope:'system'}],config:{enabled:true},directory:'/test',
 load:async p=>structuredClone(disk.get(p)),save:async(p,v)=>{disk.set(p,structuredClone(v))},
 execute:async(cmd,args)=>{calls++;assert.equal(cmd,'journalctl'); if(calls>1){assert.ok(args.includes('cursor3')); throw Object.assign(new Error('failed'),{code:'EACCES'})}return{stdout:rows.map(JSON.stringify).join('\n')}}};
 const first=await collectServiceIncidents(options); assert.equal(first.events.length,1);
 assert.equal(disk.get('/test/state.json').units[unit].cursor,'cursor3');
 const second=await collectServiceIncidents(options); assert.equal(second.events.length,1); assert.equal(second.gaps[0].code,'EACCES');
 assert.equal(disk.get('/test/state.json').units[unit].cursor,'cursor3');
 assert.ok([...disk.keys()].some(p=>p.startsWith('/test/events/')));
});
test('journal grep with no matches is healthy empty coverage, not a failed read',async()=>{
 const result=await collectServiceIncidents({services:[{unit,scope:'system'}],config:{enabled:true},load:async()=>null,save:async()=>{},execute:async()=>{throw Object.assign(new Error('no matches'),{code:1,stdout:'',stderr:''})}});
 assert.deepEqual(result.gaps,[]);assert.deepEqual(result.events,[]);
});

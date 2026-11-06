import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectServiceIncidents, mergeServiceJournal, mergeServiceCycles, serviceIncidentAttention } from '../chat/service-incidents.mjs';
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
 const now=Date.parse(events[0].at)+1000;
 const attention=serviceIncidentAttention(events,services,{now});
 const snapshot={generatedAt:new Date().toISOString(),attention,services,disks:[],accounts:[],coverage:{gaps:[]},automations:{items:[]}};
 const options={now,config:{confirmationObservations:5,noisePolicy:{mode:'risk_only'}},snapshot,
 load:async()=>structuredClone(state), save:async(_,s)=>{state=structuredClone(s)},send:async()=>{sends++;return 'om_test'},update:async()=> 'om_test'};
 await dispatchMonitoringAlerts(options); assert.equal(sends,1,'durable crash must bypass five-sample threshold');
 await dispatchMonitoringAlerts(options); assert.equal(sends,1);
 assert.equal(Object.values(state.incidents)[0].event.recovered,false);
 assert.match(renderMonitoringAlert(attention,{}),/根因|原因仍需/);
 const next=mergeServiceJournal(events,[row('FATAL ERROR: JavaScript heap out of memory',4,{_SYSTEMD_INVOCATION_ID:'new'})],unit);
 await dispatchMonitoringAlerts({...options,snapshot:{...snapshot,attention:serviceIncidentAttention(next,services,{now})}});
 assert.equal(sends,1,'repeated crashes belong to the same service incident');
 assert.equal(Object.values(state.incidents)[0].event.crashCount,2);
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

test('confirmed recovery survives cold collection, planned restarts and later gaps; new crashes remain actionable', async t => {
 const root=await mkdtemp(join(tmpdir(),'service-recovery-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const events=mergeServiceJournal([],rows,unit);
 const last=Date.parse(events[0].at);
 let stored={version:1,since:events[0].at,units:{},events,cycles:mergeServiceCycles([],events)};
 const services=[{unit,scope:'system'}];
 const observedServices=[{unit,status:'healthy',lastRunAt:new Date(last+1000).toISOString()}];
 const options={services,observedServices,config:{enabled:true},directory:'/isolated',now:last+31*60_000,
  load:async()=>structuredClone(stored),save:async(path,value)=>{if(path.endsWith('/state.json'))stored=structuredClone(value)},
  execute:async()=>({stdout:''})};
 await collectServiceIncidents({...options,dryRun:true});
 assert.equal(stored.cycles[0].recoveredAt,undefined,'dry runs never persist recovery');
 await collectServiceIncidents(options);
 assert.equal(stored.cycles[0].recoveredLastAt,stored.cycles[0].lastAt);
 const restarted=[{unit,status:'healthy',lastRunAt:new Date(last+4*3600_000).toISOString()}];
 const later=last+4*3600_000+1000;
 let item=serviceIncidentAttention(stored.cycles,restarted,{now:later})[0];
 assert.equal(item.recovered,true,'deployment cannot reopen an already recovered crash');
 item=serviceIncidentAttention(stored.cycles,restarted,{now:later,gaps:[{source:`serviceJournal:${unit}`} ]})[0];
 assert.equal(item.recovered,true,'later missing coverage does not erase prior recovery evidence');
 assert.match(item.recoveryObservation,/本事故已于/);
 let ledger=null,sends=0,edits=0;
 const dispatch=async(attention,now)=>dispatchMonitoringAlerts({stateFile:join(root,'alerts.json'),now,
  config:{enabled:true},snapshot:{generatedAt:new Date(now).toISOString(),attention,services:restarted,
   disks:[],accounts:[],automations:{items:[]},coverage:{gaps:[]}},
  load:async()=>structuredClone(ledger),save:async(_,s)=>{ledger=structuredClone(s)},
  send:async()=>{sends++;return 'om_recovery_test'},update:async()=>{edits++;return 'om_recovery_test'}});
 await dispatch(serviceIncidentAttention(events,observedServices,{now:last+1000}),last+1000);
 await dispatch(serviceIncidentAttention(stored.cycles,observedServices,{now:options.now}),options.now);
 await dispatch(serviceIncidentAttention(stored.cycles,restarted,{now:later}),later);
 assert.equal(sends,1,'a restart beyond the three-hour window does not create another card');
 assert.equal(edits,1);
 const fresh={...events[0],id:'new-fatal',at:new Date(later+1000).toISOString()};
 const cycles=mergeServiceCycles(stored.cycles,[fresh]);
 const projected=serviceIncidentAttention(cycles,restarted,{now:later+2000});
 assert.equal(projected.at(-1).recovered,false,'a fresh journal crash opens a new incident');
 await dispatch(projected,later+2000);
 assert.equal(sends,2);
 const changed=mergeServiceCycles(stored.cycles,[{...fresh,id:'late-evidence',at:new Date(last+20_000).toISOString()}]);
 assert.equal(serviceIncidentAttention(changed,observedServices,{now:last+21_000})[0].recovered,false,
  'new evidence in the same cycle invalidates its older recovery receipt');
});

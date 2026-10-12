import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import sourceModule from '../scripts/feishu-native/live-source.cjs';
const root=await mkdtemp(join(tmpdir(),'native-live-')),web=join(root,'web');await mkdir(web);
const account='1000000000000000001';let identity=account,healthy=true;
await writeFile(join(root,'native-source-account.json'),JSON.stringify({account}));
let data={syncedAt:'2026-10-12T10:00:00Z',sourceConnected:true,entries:[{webThreadId:'1000000000000000011',sessionId:'one',chatId:'group',status:'running'},{webThreadId:'1000000000000000012',sessionId:'two',chatId:'other',status:'review'}],boards:[{id:'board',groups:[{chatId:'group',webChatId:'1000000000000000021'}],topics:[]}],webArtifacts:[{sessionId:'one'},{sessionId:'two'}]};
const save=async()=>{await writeFile(join(web,'topic-projection.json'),JSON.stringify(data));await writeFile(join(web,'live-status.json'),JSON.stringify({upstreamConnected:true,connected:true,pid:123}));};await save();
let changed;const first=new Promise(r=>changed=r);
const source=sourceModule.createLiveSource({root,web,onChange:()=>changed(),readAccount:async()=>identity,alive:()=>healthy,interval:60000});
try{
 await first;
 let p=source.projection(account,['1000000000000000011']);assert.equal(p.sourceConnected,true);assert.deepEqual(p.entries.map(e=>e.sessionId),['one']);assert.equal(p.boards.length,1);assert.equal(p.webArtifacts.length,1);
 assert.equal(source.projection('1000000000000000002',['1000000000000000011']).entries.length,0);
 data={...data,syncedAt:'2026-10-12T10:00:01Z',entries:data.entries.map(e=>({...e,status:'waiting'}))};await save();await source.refresh();
 // Native state is the actual supplied RL state, never inferred from UI/card state.
 p=source.projection(account,['1000000000000000011']);assert.equal(p.entries[0].status,'waiting');
 healthy=false;await source.refresh();assert.equal(source.projection(account,['1000000000000000011']).sourceConnected,false);
 healthy=true;await source.refresh();assert.equal(source.projection(account,['1000000000000000011']).sourceConnected,true);
 identity='1000000000000000002';await source.refresh();assert.equal(source.projection(account,['1000000000000000011']).entries.length,0);
 identity=account;await source.refresh();assert.equal(source.projection(account,['1000000000000000011']).sourceConnected,true);
 data={...data,syncedAt:'2026-10-12T09:59:00Z',entries:data.entries.map(e=>({...e,status:'running'}))};await save();await source.refresh();p=source.projection(account,['1000000000000000011']);assert.equal(p.entries[0].status,'waiting');assert.equal(p.sourceConnected,false);
 console.log('Native live source: account isolation, visible scope, RL transitions, dead helper, reconnect and old snapshot checks passed');
}finally{source.close();await rm(root,{recursive:true,force:true});}

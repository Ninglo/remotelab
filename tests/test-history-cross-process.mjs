import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
if (process.argv[2] === 'child') {
  const h=await import('../chat/history.mjs');
  await h.getHistoryHeadSeq('fixture');process.send({ready:true});
  process.once('message',async()=>{
    const e=await h.appendEvent('fixture',{type:process.argv[3]==='card'?'memory_review_action':'work_event',content:'synthetic',writer:process.argv[3]});
    process.send({seq:e.seq});process.disconnect();
  });
} else {
  const home=await mkdtemp(join(tmpdir(),'history-cross-process-'));setIsolatedTestHome(home);
  const children=[];
  try {
    const h=await import('../chat/history.mjs'); const {CHAT_HISTORY_DIR}=await import('../lib/config.mjs');
    assert.equal(await h.getHistoryHeadSeq('fixture'),0);
    let ready=0;const seqs=[];
    for(const label of ['card','main'])children.push(fork(new URL(import.meta.url),['child',label],{env:process.env,stdio:['ignore','ignore','inherit','ipc']}));
    await Promise.all(children.map(child=>new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{child.kill();reject(Error('cross-process fixture timed out'));},10000);
      child.on('message',m=>{if(m.ready){if(++ready===2)children.forEach(c=>c.send('go'));}else seqs.push(m.seq);});
      child.on('error',reject);child.on('exit',code=>{clearTimeout(deadline);code===0?resolve():reject(Error('child failed'));});
    })));
    assert.deepEqual(seqs.sort(),[1,2]);
    assert.equal(await h.getHistoryHeadSeq('fixture'),2,'a reader with a cached old head sees other-process writes');
    const events=join(CHAT_HISTORY_DIR,'fixture','events');assert.equal((await readdir(events)).length,2);
    const types=await Promise.all([1,2].map(async n=>JSON.parse(await readFile(join(events,String(n).padStart(9,'0')+'.json'))).type));
    assert.deepEqual(types.sort(),['memory_review_action','work_event']);
    // An event committed before a metadata failure must survive the next append.
    await writeFile(join(events,'000000003.json'),JSON.stringify({seq:3,type:'memory_review_action',timestamp:Date.now(),content:'orphan commit'}));
    const next=await h.appendEvent('fixture',{type:'work_event'});assert.equal(next.seq,4);
    assert.equal(JSON.parse(await readFile(join(events,'000000003.json'))).content,'orphan commit');
    const meta=JSON.parse(await readFile(join(CHAT_HISTORY_DIR,'fixture','meta.json')));assert.equal(meta.size,4);
    console.log('PASS cross-process history: unique events, fresh reader, interrupted metadata recovery');
  }finally{for(const child of children)if(child.connected)child.kill();await rm(home,{recursive:true,force:true});}
}

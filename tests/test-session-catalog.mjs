import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSessionCatalog, readSessionCatalog } from '../lib/session-catalog.mjs';
const exec=promisify(execFile);
const moduleUrl=new URL('../lib/session-catalog.mjs',import.meta.url).href;
test('record migration, indexed access, multi-process increments, rollback and immutable read snapshots',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'session-catalog-')),file=join(dir,'chat-sessions.json');
 try {
  const original=Array.from({length:200},(_,i)=>({id:`session${i}`,name:`Name ${i}`,counter:0,context:'actual-shape-synthetic-test'.repeat(1000),conversation:{target:{chatId:'test'}}}));
  await writeFile(file,JSON.stringify(original));
  const store=createSessionCatalog(file), migrated=await store.migrate();
  assert.equal(migrated.count,200);assert.deepEqual(await store.all(),original);
  assert.deepEqual(JSON.parse(await readFile(migrated.backup)),original);
  assert.ok((await readFile(file)).length<20000,'index stays independent of record body bytes');
  assert.deepEqual(await readSessionCatalog(file),original);
  const old=await store.snapshot();
  await Promise.all(Array.from({length:4},()=>exec(process.execPath,['--input-type=module','-e',`import {createSessionCatalog} from ${JSON.stringify(moduleUrl)}; const c=createSessionCatalog(${JSON.stringify(file)}); for(let i=0;i<4;i++) await c.mutateOne('session0',d=>{d.counter++;return true;});`])));
  assert.equal((await store.get('session0')).counter,16,'cross-process read/modify/write cannot lose increments');
  assert.equal((await store.readSnapshot(old))[0].counter,0,'a committed reader snapshot remains consistent');
  assert.equal(await store.get('missing'),null);assert.equal(await store.get('constructor'),null);
  const list=await store.all(); const unrelated=list[5];
  await store.mutateAll(async(rows,save)=>{rows[1]={...rows[1],name:'changed'};rows.splice(2,1);await save(rows)});
  assert.equal((await store.all())[4],unrelated,'unchanged parsed records are shared');
  assert.equal((await store.get('session1')).name,'changed');assert.equal(await store.get('session2'),null);
  const before=await store.all();
  await store.exportLegacy();assert.deepEqual(JSON.parse(await readFile(file)),before);
  assert.equal(await store.enabled(),false);assert.deepEqual(await readSessionCatalog(file),before);
  await store.migrate();
  const orphan=join(store.directory,'a'.repeat(64)+'.json');await writeFile(orphan,'{}');await utimes(orphan,new Date(0),new Date(0));
  assert.equal((await store.prune()).removed,1);assert.deepEqual(await store.all(),before);
 } finally {await rm(dir,{recursive:true,force:true})}
});
test('external references stay outside runnable sessions and survive native updates, retries and prune',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reference-catalog-')),file=join(dir,'chat-sessions.json');
 try {
  await writeFile(file,JSON.stringify([{id:'a',name:'native'}]));const c=createSessionCatalog(file);await c.migrate();
  const nativeId='01234567-89ab-cdef-abcd-0123456789ab',key='sg-codex:ownerA:'+nativeId;
  const ref={source:'sg-codex',nativeId,title:'fixture',archived:false,updatedAt:1};
  await assert.rejects(c.writeExternalReference(key,ref,null),/NOT_ENABLED/);
  assert.equal(await c.enableReferences(),true);assert.equal(await c.enableReferences(),false);
  const first=await c.writeExternalReference(key,ref,null);assert.equal(first.changed,true);
  assert.equal((await c.writeExternalReference(key,ref,null)).changed,false);
  await assert.rejects(c.writeExternalReference(key,{...ref,title:'stale'},null),/STALE_REFERENCE/);
  await assert.rejects(c.writeExternalReference(key,{...ref,transcript:'no'},first.hash),/INVALID_REFERENCE/);
  await c.mutateAll((rows,save)=>save(rows.map(r=>({...r,name:'new native name'}))));
  const reopened=createSessionCatalog(file);assert.equal((await reopened.all()).length,1);
  assert.equal(await reopened.get(key),null);assert.deepEqual(await reopened.readExternalReference(await reopened.snapshot(),key),ref);
  await utimes(join(c.directory,first.hash+'.json'),new Date(0),new Date(0));await c.prune();
  assert.deepEqual(await c.readExternalReference(await c.snapshot(),key),ref);
  await assert.rejects(c.exportLegacy(),/REFERENCE_NAMESPACE/);
  assert.equal((await c.writeExternalReference(key,null,first.hash)).changed,true);
  assert.equal(await c.readExternalReference(await c.snapshot(),key),null);
  assert.equal((await c.get('a')).name,'new native name');
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('OS mutation lock releases when a writer dies before index commit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'session-catalog-crash-')), file=join(dir,'chat-sessions.json');
 try {
  await writeFile(file,JSON.stringify([{id:'a',name:'before'}]));const store=createSessionCatalog(file);await store.migrate();
  await exec(process.execPath,['--input-type=module','-e',`import {withCatalogLock} from ${JSON.stringify(moduleUrl)}; const fs=await import('node:fs/promises'); const {syncBuiltinESMExports}=await import('node:module'); const original=fs.default.rename; fs.default.rename=async(a,b)=>{if(b===${JSON.stringify(file)}) process.kill(process.pid,'SIGKILL'); return original(a,b)};syncBuiltinESMExports();const {createSessionCatalog}=await import(${JSON.stringify(moduleUrl)});await createSessionCatalog(${JSON.stringify(file)}).mutateOne('a',d=>{d.name='never committed';return true});`]).catch(e=>assert.equal(e.signal,'SIGKILL'));
  assert.equal((await store.get('a')).name,'before','a crash after body staging cannot publish a partial transaction');
  await store.mutateOne('a',d=>{d.name='after';return true;});assert.equal((await store.get('a')).name,'after');
 } finally {await rm(dir,{recursive:true,force:true})}
});

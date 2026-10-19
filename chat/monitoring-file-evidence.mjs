// Optional, private projection of native file events. Canonical history remains authoritative.
import { readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
export const fileId = path => createHash('sha256').update(path).digest('hex').slice(0,12);
const queue = createKeyedTaskQueue();
export async function evidenceConfig(configDir=CONFIG_DIR) {
 try { return JSON.parse(await readFile(join(configDir,'monitoring-evidence.json'),'utf8')); }
 catch(e) { if(e.code==='ENOENT') return null; throw e; }
}
export async function recordFileEvidence(sessionId,event,{configDir=CONFIG_DIR}={}) {
 if(event.type!=='file_change'||event.changeState!=='completed'||!isAbsolute(event.filePath||'')||!Number.isInteger(event.seq))return;
 const config=await evidenceConfig(configDir);if(!config)return;
 // Copied/forked events are not a fresh modification from the destination session.
 if(!event.requestId)return;
 const key=createHash('sha256').update(JSON.stringify([sessionId,event.requestId])).digest('hex').slice(0,24);
 let accepted;for(const bucket of ['active','archive']){try{accepted=JSON.parse(await readFile(join(configDir,'requests',bucket,key+'.json'),'utf8'));break}catch(e){if(e.code!=='ENOENT')throw e}}
 if(!accepted?.acceptedAt||accepted.sessionId!==sessionId||accepted.requestId!==event.requestId)return;
 const registry=JSON.parse(await readFile(config.registryPath,'utf8'));
 const path=resolve(event.filePath);
 const roots=registry.groups.filter(g=>g.collectVersions).flatMap(g=>g.paths).map(p=>resolve(p.replace('$ROOT',config.sourceRoot)));
 const targets=await Promise.all(roots.map(p=>realpath(p).catch(()=>p)));
 const target=await realpath(path).catch(()=>path);
 if(![...roots,...targets].some(p=>path===p||path.startsWith(p+'/')||target===p||target.startsWith(p+'/')))return;
 const id=fileId(target),dest=join(config.indexDir,id+'.json');
 await queue(dest,async()=>{
  let rows=[];try{rows=JSON.parse(await readFile(dest,'utf8')).events||[]}catch(e){if(e.code!=='ENOENT')throw e}
  if(rows.some(x=>x.sessionId===sessionId&&x.seq===event.seq))return;
  rows.push({sessionId,seq:event.seq,path,target,at:event.timestamp,requestId:event.requestId||null,runId:event.runId||null,changeType:event.changeType});
  rows.sort((a,b)=>a.at-b.at);
  await mkdir(config.indexDir,{recursive:true,mode:0o700});
  await writeFile(dest+'.tmp',JSON.stringify({events:rows.slice(-200)}),{mode:0o600});await rename(dest+'.tmp',dest);
 });
}
export async function fileEvidence(config,path) {
 const target=await realpath(path).catch(()=>path);
 try{return JSON.parse(await readFile(join(config.indexDir,fileId(target)+'.json'),'utf8')).events||[]}
 catch(e){if(e.code==='ENOENT')return [];throw e}
}

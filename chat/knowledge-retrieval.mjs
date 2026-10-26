// Optional, instance-configured CPU worker. No model work on the HTTP event loop.
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let worker;
const script = fileURLToPath(new URL('../knowledge/hybrid-worker.py', import.meta.url));
async function start(config) {
  const directory = await mkdtemp(join(tmpdir(), 'remotelab-knowledge-'));
  const socket = join(directory, 'worker.sock');
  const child = execFile(config.python, [script, socket, JSON.stringify(config)], {
    env: {...process.env, HF_HUB_OFFLINE:'1', TRANSFORMERS_OFFLINE:'1', TOKENIZERS_PARALLELISM:'false'},
  });
  // stdout carries one readiness message only; RPC responses use the private socket.
  const state = {child, directory, socket, ready:null, exited:false};
  child.once('exit', () => { state.exited=true; void rm(directory,{recursive:true,force:true}); });
  state.ready = new Promise((resolve,reject) => {
    const timeout=setTimeout(() => { child.kill(); reject(new Error('Knowledge model startup timed out')); }, config.timeoutMs || 30000);
    let text='';
    child.stdout.on('data', chunk => {
      text+=chunk;
      if (!text.includes('\n')) return;
      try { const value=JSON.parse(text.trim()); clearTimeout(timeout); resolve(value); }
      catch { clearTimeout(timeout); child.kill(); reject(new Error('Invalid knowledge worker readiness')); }
    });
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Knowledge model worker exited')); });
  });
  return state;
}
export async function closeKnowledgeRetriever() {
  const old=worker; worker=null;
  if (old) (await old.promise).child.stdin.end();
}
export async function retrieveKnowledge(config, {query, corpusHash, pages}) {
  const key=JSON.stringify(config);
  if (worker && worker.key!==key) await closeKnowledgeRetriever();
  if (!worker) {
    const entry={key,promise:start(config)}; worker=entry;
    entry.promise.then(s => s.child.once('exit', () => { if(worker===entry) worker=null; }), () => { if(worker===entry) worker=null; });
  }
  const state=await worker.promise;
  await state.ready;
  if (state.exited) throw new Error('Knowledge worker unavailable');
  return new Promise((resolve,reject) => {
    const client=createConnection(state.socket); let data='';
    const fail=e=>{client.destroy();reject(e);};
    client.setTimeout(config.timeoutMs || 30000,()=>fail(new Error('Knowledge retrieval timed out')));
    client.once('error',fail);
    client.on('connect',()=>client.end(JSON.stringify({query,corpusHash,pages})));
    client.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>1024*1024)fail(new Error('Knowledge response too large'));});
    client.on('end',()=>{
      try {const value=JSON.parse(data);if(value.error)throw new Error(value.error);resolve(value);}
      catch(e){reject(e);}
    });
  });
}

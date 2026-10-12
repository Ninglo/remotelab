import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
const root=await mkdtemp(join(tmpdir(),'feishu-native-bridge-')),cap='fixture-private-capability';await writeFile(join(root,'native-asset-capability'),cap);await writeFile(join(root,'web-display-choice.json'),JSON.stringify({enabled:true,aliases:{},theme:'sky'}));
const child=spawn(process.execPath,[new URL('../scripts/feishu-native/bridge.cjs',import.meta.url).pathname],{env:{...process.env,RLFE_TRIAL_ROOT:root},stdio:['ignore','pipe','pipe']});
const deadline=setTimeout(()=>child.kill('SIGTERM'),15000);let failure='';child.stderr.on('data',x=>failure+=x);
const base='http://127.0.0.1:19342',account='1000000000000000001',client='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const req=async(path,body,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+cap,'X-Native-Account':account,'X-Native-Client':client,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});
try{
 await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(failure||'helper exited')})]);
 assert.equal((await req('/status',undefined,{Origin:'https://evil.test'})).status,403);
 assert.equal((await req('/status',undefined,{Authorization:'Bearer wrong'})).status,403);
 assert.equal((await req('/initial')).status,200);
 assert.equal((await req('/initial',undefined,{'X-Native-Account':'person_foo'})).status,400);
 await req('/storage/set',{values:{'feishuWebExplore.test':{person:'Alice'}}});
 assert.deepEqual(await (await req('/storage/get',{key:'feishuWebExplore.test'})).json(),{'feishuWebExplore.test':{person:'Alice'}});
 assert.deepEqual(await (await req('/storage/get',{key:'feishuWebExplore.test'},{'X-Native-Account':'1000000000000000002'})).json(),{'feishuWebExplore.test':null});
 assert.equal((await req('/request',{type:'rlfe:personal-workspace-request',operation:'context',account:'1000000000000000002',token:'fwspace_'+'a'.repeat(43)})).status,400);
 assert.equal((await req('/request',{type:'arbitrary-proxy',url:'https://evil.test'})).status,400);
 assert.equal((await req('/external',{url:'file:///etc/passwd'})).status,400);
 assert.equal((await req('/pair/finish?key=unknown',{})).status,400);
 assert.equal((await req('/save',{value:{aliases:{':999999999999':'unseen'}}})).status,400);
 console.log('Native helper rejects spoofed origins/accounts, arbitrary proxying and invalid callbacks; per-account storage is isolated');
}finally{clearTimeout(deadline);const done=once(child,'exit');child.kill('SIGTERM');await done;await rm(root,{recursive:true,force:true});}

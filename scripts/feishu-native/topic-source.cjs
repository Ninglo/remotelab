// One account-scoped source for both native renderers. Keep the live subscription
// until its replacement has delivered a snapshot; viewport churn is not an outage.
const {execFile,spawn}=require('node:child_process');
const {PassThrough,Readable}=require('node:stream');
function systemProxy(){return new Promise(resolve=>{
 execFile('/usr/sbin/scutil',['--proxy'],{timeout:3000,maxBuffer:131072},(error,text)=>{
  if(error){resolve('');return;}
  const fields=Object.fromEntries([...text.matchAll(/^\s*(HTTPS\w+)\s*:\s*(\S+)\s*$/gm)].map(m=>[m[1],m[2]]));
  const host=fields.HTTPSProxy,port=Number(fields.HTTPSPort);
  resolve(fields.HTTPSEnable==='1'&&/^[a-zA-Z0-9.:[\]-]+$/.test(host||'')&&Number.isInteger(port)&&port>0&&port<65536?'http://'+(host.includes(':')&&!host.startsWith('[')?'['+host+']':host)+':'+port:'');
 });
});}
// The bundled Node version does not automatically use macOS proxy settings.
// curl provides the OS-supported CONNECT/TLS stream without adding a runtime
// dependency. Credentials go through stdin, never process arguments or files.
function proxyFetch(url,{signal,headers},proxy,launch=spawn){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(new DOMException('aborted','AbortError'));return;}
 const quote=value=>{if(/[\r\n\0]/.test(value))throw Error('状态连接参数无效');return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';};
 const config=['url = '+quote(url),'proxy = '+quote(proxy),...Object.entries(headers).map(([k,v])=>'header = '+quote(k+': '+v))].join('\n')+'\n';
 const child=launch('/usr/bin/curl',['--silent','--show-error','--no-buffer','--compressed','--include','--suppress-connect-headers','--proto','=https','--connect-timeout','10','--config','-'],{stdio:['pipe','pipe','pipe']});
 const body=new PassThrough();let pending=Buffer.alloc(0),ready=false;
 const fail=error=>{if(!ready)reject(error);body.destroy(error);child.kill();};
 body.on('error',()=>{});
 const abort=()=>fail(new DOMException('aborted','AbortError'));
 signal?.addEventListener('abort',abort,{once:true});
 child.on('error',fail);child.stdin.on('error',fail);
 child.stderr.resume();
 child.on('close',code=>{signal?.removeEventListener('abort',abort);if(code&&!signal?.aborted)fail(Error('代理状态连接失败'));else if(!ready&&!signal?.aborted)fail(Error('代理未返回状态响应'));});
 body.on('close',()=>{if(child.exitCode===null)child.kill();});
 const readHeaders=chunk=>{
  pending=Buffer.concat([pending,chunk]);const end=pending.indexOf('\r\n\r\n');
  if(end<0){if(pending.length>65536)fail(Error('状态响应头过大'));return;}
  if(end>65536){fail(Error('状态响应头过大'));return;}
  const head=pending.subarray(0,end).toString(),match=/^HTTP\/\S+\s+(\d{3})/.exec(head);
  if(!match){fail(Error('状态响应头无效'));return;}
  const status=Number(match[1]);
  if(status>=100&&status<200){pending=pending.subarray(end+4);if(pending.length)readHeaders(Buffer.alloc(0));return;}
  child.stdout.off('data',readHeaders);ready=true;
  const responseHeaders=new Headers();for(const line of head.split('\r\n').slice(1)){const i=line.indexOf(':');if(i>0)responseHeaders.append(line.slice(0,i),line.slice(i+1).trim());}
  if(pending.length>end+4)body.write(pending.subarray(end+4));pending=null;
  child.stdout.pipe(body);
  try{resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(body),{status,headers:responseHeaders}));}catch(error){fail(error);}
 };
 child.stdout.on('data',readHeaders);child.stdin.end(config);
});}
async function nativeTopicFetch(url,options){
 const proxy=process.platform==='darwin'?await systemProxy():'';
 return proxy?proxyFetch(url,options,proxy):fetch(url,options);
}
function applyTopicFrame(previous,frame){
 if(frame.type!=='topic-patch')return frame;
 if(!previous||frame.base!==previous.streamSequence||frame.streamSequence!==frame.base+1||!Array.isArray(frame.changes)||frame.changes.length>1000)throw Error('状态增量不连续，正在重新同步');
 let next=structuredClone(previous);
 for(const change of frame.changes){
  if(!Array.isArray(change)||change.length!==2||!Array.isArray(change[0])||change[0].length>20)throw Error('状态增量格式无效');
  const [keys,value]=change;
  if(keys.some(k=>typeof k!=='string'||['__proto__','prototype','constructor'].includes(k)))throw Error('状态增量路径无效');
  if(!keys.length){next=value;continue;}
  let node=next;
  for(const key of keys.slice(0,-1)){if(!node||typeof node!=='object'||!Object.hasOwn(node,key))throw Error('状态增量路径已失效');node=node[key];}
  const key=keys.at(-1);
  if(!node||typeof node!=='object'||(Array.isArray(node)&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=node.length)))throw Error('状态增量目标无效');
  node[key]=value;
 }
 if(!next||typeof next!=='object')throw Error('状态增量结果无效');
 return {...next,syncedAt:frame.syncedAt,streamSequence:frame.streamSequence};
}
function createTopicSource({remote,origin,onChange,fetchImpl=nativeTopicFetch,heartbeatMs=45000,snapshotMs=15000,retryMs=250}){
 const accounts=new Map();
 const empty=error=>({entries:[],boards:[],sourceConnected:false,error,transport:'personal-grant'});
 function stop(s){if(!s)return;s.stopped=true;clearTimeout(s.timer);clearTimeout(s.heartbeat);s.controller?.abort();stop(s.fallback);s.fallback=null;}
 function view(s){return !s?empty('请连接本人账号以同步状态'):s.fallback?view(s.fallback):s.data;}
 const scope=(current,previous)=>[...new Set([...current,...previous])].slice(0,200).sort();
 function update(account,grant,ids,groups){
  const valid=grant?.expiresAt>Date.now()&&grant.nativeAccount===account&&grant.origin===origin&&/^fwtops_[\w-]{43}$/.test(grant.token||'');
  const old=accounts.get(account),sameGrant=valid&&old?.token===grant.token;
  // Keep a bounded subscription to recently visible rows. Scrolling away or an
  // empty virtual-list commit must not continually tear down healthy streams.
  const wanted=scope(ids,sameGrant?old.ids:[]),wantedGroups=scope(groups,sameGrant?old.groups:[]);
  const query=new URLSearchParams({ids:wanted.join(','),groups:wantedGroups.join(','),delta:'1'});
  const key=valid?grant.token+':'+query:'';
  if(old?.key===key)return;
  let fallback=null;
  if(sameGrant){
   if(old.ready)fallback=old;
   else{fallback=old.fallback;old.fallback=null;stop(old);}
  }else stop(old);
  const s={key,token:valid?grant.token:null,ids:wanted,groups:wantedGroups,
   data:sameGrant?view(old):empty(valid?'正在连接 RemoteLab':'请连接本人账号以同步状态'),
   fallback,ready:false,stopped:false,backoff:retryMs};
  accounts.set(account,s);
  if(valid)void run();
  async function run(){
   if(s.stopped)return;
   const controller=new AbortController();s.controller=controller;
   // Headers or keepalives alone do not establish a usable subscription. Keep
   // the previous live view until a real snapshot arrives, but retry a stalled
   // replacement instead of letting heartbeats keep it pending indefinitely.
   let snapshotPending=true;
   const snapshotTimer=setTimeout(()=>controller.abort(),snapshotMs);snapshotTimer.unref?.();
   const contact=()=>{clearTimeout(s.heartbeat);s.heartbeat=setTimeout(()=>controller.abort(),heartbeatMs);s.heartbeat.unref?.();};contact();
   let terminal=false;
   try{
    if(grant.expiresAt<=Date.now()){terminal=true;throw Error('状态连接已失效，请重新连接本人账号');}
    const r=await fetchImpl(remote+'/api/feishu-web-topics/stream?'+query,{redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+grant.token,'X-Feishu-Origin':origin,'X-Feishu-Account':account}});
    if(!r.ok){terminal=[400,401,403].includes(r.status);throw Error((await r.json()).error||'状态连接失败');}
    let buffer='',previous=null;const decoder=new TextDecoder();
    for await(const value of r.body){
     if(s.stopped)return;contact();buffer+=decoder.decode(value,{stream:true});if(buffer.length>4194304)throw Error('状态数据过大');let end;
     while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
      const data=applyTopicFrame(previous,JSON.parse(line.slice(6)));if(data.sourceConnected===false||!Array.isArray(data.entries)||!Array.isArray(data.boards))throw Error(data.error||'状态来源不可用');
      previous=data;
      snapshotPending=false;clearTimeout(snapshotTimer);
      s.data={...data,transport:'personal-grant'};s.ready=true;s.backoff=retryMs;
      stop(s.fallback);s.fallback=null;onChange();
     }
    }
    throw Error('状态连接已断开，正在恢复');
   }catch(e){if(!s.stopped){
    const error=e.name==='AbortError'?(snapshotPending?'状态快照等待超时，正在恢复':'状态心跳中断，正在恢复'):e.message;
    // Authorization failure must clear even the old subscription immediately.
    if(terminal){stop(s.fallback);s.fallback=null;s.data=empty(error);}
    else s.data={...s.data,sourceConnected:false,error};
    onChange();
   }}finally{clearTimeout(snapshotTimer);clearTimeout(s.heartbeat);controller.abort();}
   if(!s.stopped&&!terminal){s.timer=setTimeout(run,s.backoff);s.timer.unref?.();s.backoff=Math.min(5000,s.backoff*2);}
  }
 }
 return {update,projection:account=>view(accounts.get(account)),remove(account){stop(accounts.get(account));accounts.delete(account);},close(){for(const s of accounts.values())stop(s);accounts.clear();}};
}
module.exports={createTopicSource,applyTopicFrame,nativeTopicFetch,proxyFetch};

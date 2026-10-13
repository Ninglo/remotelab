// One account-scoped source for both native renderers. Keep the live subscription
// until its replacement has delivered a snapshot; viewport churn is not an outage.
function createTopicSource({remote,origin,onChange,fetchImpl=fetch,heartbeatMs=45000,retryMs=250}){
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
  const query=new URLSearchParams({ids:wanted.join(','),groups:wantedGroups.join(',')});
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
   const contact=()=>{clearTimeout(s.heartbeat);s.heartbeat=setTimeout(()=>controller.abort(),heartbeatMs);s.heartbeat.unref?.();};contact();
   let terminal=false;
   try{
    if(grant.expiresAt<=Date.now()){terminal=true;throw Error('状态连接已失效，请重新连接本人账号');}
    const r=await fetchImpl(remote+'/api/feishu-web-topics/stream?'+query,{redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+grant.token,'X-Feishu-Origin':origin,'X-Feishu-Account':account}});
    if(!r.ok){terminal=[400,401,403].includes(r.status);throw Error((await r.json()).error||'状态连接失败');}
    let buffer='';const decoder=new TextDecoder();
    for await(const value of r.body){
     if(s.stopped)return;contact();buffer+=decoder.decode(value,{stream:true});if(buffer.length>4194304)throw Error('状态数据过大');let end;
     while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
      const data=JSON.parse(line.slice(6));if(data.sourceConnected===false||!Array.isArray(data.entries)||!Array.isArray(data.boards))throw Error(data.error||'状态来源不可用');
      s.data={...data,transport:'personal-grant'};s.ready=true;s.backoff=retryMs;
      stop(s.fallback);s.fallback=null;onChange();
     }
    }
    throw Error('状态连接已断开，正在恢复');
   }catch(e){if(!s.stopped){
    const error=e.name==='AbortError'?'状态心跳中断，正在恢复':e.message;
    // Authorization failure must clear even the old subscription immediately.
    if(terminal){stop(s.fallback);s.fallback=null;s.data=empty(error);}
    else s.data={...s.data,sourceConnected:false,error};
    onChange();
   }}finally{clearTimeout(s.heartbeat);controller.abort();}
   if(!s.stopped&&!terminal){s.timer=setTimeout(run,s.backoff);s.timer.unref?.();s.backoff=Math.min(5000,s.backoff*2);}
  }
 }
 return {update,projection:account=>view(accounts.get(account)),remove(account){stop(accounts.get(account));accounts.delete(account);},close(){for(const s of accounts.values())stop(s);accounts.clear();}};
}
module.exports={createTopicSource};

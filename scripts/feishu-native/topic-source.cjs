// A standalone Mac uses its own explicit, account-scoped RemoteLab grant.
// One stream per account serves both native renderers; no browser profile needed.
function createTopicSource({remote,origin,onChange,fetchImpl=fetch,heartbeatMs=45000,retryMs=250}){
 const accounts=new Map();
 const empty=error=>({entries:[],boards:[],sourceConnected:false,error,transport:'personal-grant'});
 function stop(s){s.stopped=true;clearTimeout(s.timer);clearTimeout(s.heartbeat);s.controller?.abort();}
 function update(account,grant,ids,groups){
  const valid=grant?.expiresAt>Date.now()&&grant.nativeAccount===account&&grant.origin===origin&&/^fwtops_[\w-]{43}$/.test(grant.token||'');
  const query=new URLSearchParams({ids:[...new Set(ids)].sort().slice(0,200).join(','),groups:[...new Set(groups)].sort().slice(0,200).join(',')});
  const key=valid?grant.token+':'+query:'';const old=accounts.get(account);
  if(old?.key===key)return;
  if(old)stop(old);
  const s={key,data:empty(valid?'正在连接 RemoteLab':'请连接本人账号以同步状态'),stopped:false,backoff:retryMs};accounts.set(account,s);
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
      s.data={...data,transport:'personal-grant'};s.backoff=retryMs;onChange();
     }
    }
    throw Error('状态连接已断开，正在恢复');
   }catch(e){if(!s.stopped){s.data={...s.data,sourceConnected:false,error:e.name==='AbortError'?'状态心跳中断，正在恢复':e.message};onChange();}}
   finally{clearTimeout(s.heartbeat);controller.abort();}
   if(!s.stopped&&!terminal){s.timer=setTimeout(run,s.backoff);s.timer.unref?.();s.backoff=Math.min(5000,s.backoff*2);}
  }
 }
 return {update,projection:account=>accounts.get(account)?.data||empty('请连接本人账号以同步状态'),remove(account){const s=accounts.get(account);if(s)stop(s);accounts.delete(account);},close(){for(const s of accounts.values())stop(s);accounts.clear();}};
}
module.exports={createTopicSource};

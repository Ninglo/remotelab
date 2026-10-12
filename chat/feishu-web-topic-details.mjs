import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getHistoryHeadSeq, loadHistory } from './history.mjs';
import { getSessionTokenTotals } from './session-token-totals.mjs';
import { codexAuthManager } from './codex-auth.mjs';
import { contextFromEvents, totalsBySession, quotaFromSources } from './feishu-web-usage-view.mjs';

// Return only display fields for Sessions already resolved by the topic source.
export function createTopicDetails({head=getHistoryHeadSeq,history=loadHistory,totals=getSessionTokenTotals,
  auth=codexAuthManager,read=readFile,fileStat=stat}={}) {
  const contexts=new Map();let quota,quotaUntil=0,quotaPending;
  async function readQuota(){
    if(quotaUntil>Date.now())return quota;
    if(!quotaPending)quotaPending=Promise.allSettled([auth.getStatus(),auth.getRateLimits()]).then(([a,b])=>{
      quota=quotaFromSources(a.status==='fulfilled'?a.value:null,b.status==='fulfilled'?b.value:null);quotaUntil=Date.now()+60000;return quota;
    }).finally(()=>{quotaPending=null;});
    return quotaPending;
  }
  async function context(id){
    const seq=await head(id),old=contexts.get(id);if(old?.seq===seq)return old.value;
    // Read metadata only, incrementally; older usage is discovered in bounded pages.
    let end=seq,value,budget=4096;
    while(end>(old?.seq||0)&&budget>0){
      const from=Math.max((old?.seq||0)+1,end-255);
      value=contextFromEvents(await history(id,{fromSeq:from,toSeq:end,includeBodies:false}));
      if(value)break;budget-=end-from+1;end=from-1;
    }
    value||=old?.value||null;contexts.delete(id);contexts.set(id,{seq,value});
    if(contexts.size>2000)contexts.delete(contexts.keys().next().value);
    return value;
  }
  async function artifacts(file,entries){
    if(!file)return [];
    if(!file.startsWith('/')||(await fileStat(file)).size>2*1024*1024)throw Error('网页成果来源无效');
    const registry=JSON.parse(await read(file,'utf8'));if(registry.schema!==1||!Array.isArray(registry.artifacts))throw Error('网页成果格式无效');
    const linked=new Map(entries.map(e=>[e.sessionId,e]));
    return registry.artifacts.filter(a=>{const e=linked.get(a.sessionId);return e&&e.chatId===a.chatId&&e.rootId===a.rootId;}).map(a=>({
      id:a.id,sessionId:a.sessionId,webThreadId:linked.get(a.sessionId).webThreadId,title:a.title,filename:a.filename,
      versions:(a.versions||[]).filter(v=>typeof v.source==='string'&&Buffer.byteLength(v.source)<=256*1024&&createHash('sha256').update(v.source).digest('hex')===v.sha256).map(v=>{
        const delivery=v.delivery,verified=delivery?.webThreadId===linked.get(a.sessionId).webThreadId;
        return {number:v.number,source:v.source,sha256:v.sha256,createdAt:v.createdAt,
          messageLink:verified&&delivery.sourceLink||'https://index.jiujianian.dev/?session='+a.sessionId+'&tab=sessions&web-artifact='+encodeURIComponent(a.id)+'&version='+v.number,
          ...(verified?{nativeMessageId:delivery.nativeMessageId}:{})};
      })
    }));
  }
  return async(entries,config)=>{
    const [summary,capacity,web]=await Promise.allSettled([totals(),readQuota(),artifacts(config.artifactsFile,entries)]);
    const bySession=totalsBySession(summary.status==='fulfilled'?summary.value:{}),result=[];
    for(let i=0;i<entries.length;i+=4)result.push(...await Promise.all(entries.slice(i,i+4).map(async e=>({...e,usage:{cumulative:bySession.get(e.sessionId)||null,context:await context(e.sessionId).catch(()=>null)}}))));
    return {entries:result,quota:capacity.status==='fulfilled'?capacity.value:{status:'unavailable',windows:[]},webArtifacts:web.status==='fulfilled'?web.value:[],detailsError:web.status==='rejected'?'消息成果暂时无法读取':''};
  };
}
export const topicDetails=createTopicDetails();

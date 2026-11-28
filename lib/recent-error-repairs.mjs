import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run=promisify(execFile);
const repo=fileURLToPath(new URL('../',import.meta.url));
const sha=/^[0-9a-f]{40}$/;
const signaturePattern=/^[0-9a-f]{64}$/;
const DAY=86_400_000;
const bound=(v,max)=>typeof v==='string' && Boolean(v.trim()) && v.length<=max;
const timestamp=v=>typeof v==='string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(v) ? Date.parse(v) : NaN;
let cache;
async function git(...args) {
  const {stdout}=await run('git',['-C',repo,...args],{timeout:5000,maxBuffer:16384});
  return stdout.trim();
}
export async function validateRepairReceipts(entries,{now=Date.now(),checkGit=git}={}) {
  if (entries===undefined) return {valid:[],invalid:[]};
  if (!Array.isArray(entries) || entries.length>50) return {valid:[],invalid:[{reason:'回执列表无效或超过 50 条'}]};
  const valid=[],invalid=[],counts=new Map();
  for(const row of entries) if(signaturePattern.test(row?.signature||'')) counts.set(row.signature,(counts.get(row.signature)||0)+1);
  for (const entry of entries) {
    const signature=signaturePattern.test(entry?.signature||'')?entry.signature:null;
    const startedAt=timestamp(entry?.deployment?.startedAt),verifiedAt=timestamp(entry?.deployment?.verifiedAt);
    const {commit,deployment}=entry||{};
    let reason;
    if (!signature) reason='签名格式无效';
    else if (counts.get(signature)>1) reason='同一签名有多个生效回执';
    else if (!sha.test(commit||'') || !sha.test(deployment?.commit||'')) reason='提交 SHA 不完整';
    else if (!Number.isFinite(startedAt) || !(startedAt<=verifiedAt && verifiedAt<=now)) reason='部署或复验时间无效';
    else if (!bound(deployment.evidence,2048) || !bound(entry.verification,500) || !bound(entry.recordedBy,100)) reason='缺部署或复验证据';
    else {
      try {
        const committedAt=Number(await checkGit('show','-s','--format=%ct',commit))*1000;
        if (!(startedAt>committedAt && committedAt>0)) reason='部署不晚于修复提交';
        else await checkGit('merge-base','--is-ancestor',commit,deployment.commit);
      } catch { reason='无法验证部署版本包含修复提交'; }
    }
    if (reason) invalid.push({signature,reason});
    else valid.push({signature,commit,startedAt,verifiedAt});
  }
  return {valid,invalid};
}
export function loadedRepairReceipts(entries,now=Date.now()) {
  const key=JSON.stringify(entries);
  if (!cache || cache.key!==key || cache.expires<=now) cache={key,expires:now+60_000,result:validateRepairReceipts(entries,{now})};
  return cache.result;
}

export function observationMs(timestamps) {
  const sorted=[...timestamps].sort((a,b)=>a-b).slice(-5);
  const gaps=sorted.slice(1).map((at,i)=>at-sorted[i]).sort((a,b)=>a-b);
  const mid=Math.floor(gaps.length/2);
  const median=gaps.length%2 ? gaps[mid] : gaps.length ? (gaps[mid-1]+gaps[mid])/2 : 0;
  return Math.min(7*DAY,Math.max(DAY,median*3));
}

// Used for both browser and digest; only approved scalars leave this layer.
export function repairReports(db,prepare,{repairs,now}) {
  const sql=q=>prepare(db,q);
  return repairs.filter(r=>r.verifiedAt<=now).map(r=>{
    const tracking=sql('SELECT observation_ms AS observation,relapse_at AS tracked FROM error_repair_tracking WHERE signature=? AND commit_sha=? AND started_at=?')
      .get(r.signature,r.commit,r.startedAt);
    const history=tracking ? [] : preDeploymentTimes(db,prepare,r);
    const observation=tracking?.observation ?? observationMs(history);
    const current=sql('SELECT min(at) AS at FROM error_events WHERE cluster=? AND at>=? AND at<=?').get(r.signature,r.startedAt,now).at;
    const relapseAt=[tracking?.tracked,current].filter(at=>at!=null && at<=now).sort((a,b)=>a-b)[0] ?? null;
    const closedAt=Math.max(r.startedAt+observation,r.verifiedAt);
    const summary=sql('SELECT source,label FROM error_clusters WHERE id=?').get(r.signature);
    return {...r,closedAt,relapseAt,source:summary?.source,label:summary?.label,
      state:relapseAt!==null?'recurring':now>=closedAt?'closed':'observing'};
  });
}
export function preDeploymentTimes(db,prepare,r) {
  return prepare(db,`SELECT min(at) AS at FROM error_events WHERE cluster=? AND at<? GROUP BY operation
    ORDER BY at DESC LIMIT 5`).all(r.signature,r.startedAt).map(x=>x.at);
}

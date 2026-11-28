import { errorSignature, RECENT_ERROR_SOURCES } from './recent-errors.mjs';
import { groupErrorLine, originalLink } from './recent-error-public.mjs';

export const DAY = 86_400_000;
export function digestOptions(config = {}) {
  const timeZone = config.timeZone ?? 'Asia/Shanghai';
  const digestAt = config.digestAt ?? '09:00';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(digestAt)) throw Error('Invalid digestAt');
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' });
  const limit = (key, fallback, cap) => {
    const v = config[key] ?? fallback;
    if (!Number.isInteger(v) || v < (key === 'maxRows' ? 1 : 0) || v > cap) throw Error(`Invalid ${key}`);
    return v;
  };
  return { clock, timeZone, digestAt, maxRows:limit('maxRows',10,30), maxAnalyses:limit('maxAnalyses',8,12) };
}

function wallTime(clock, timestamp) {
  const p = Object.fromEntries(clock.formatToParts(timestamp).map(({type,value}) => [type,value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function digestPeriod(now, options) {
  const { clock, digestAt } = options;
  let date = wallTime(clock,now).slice(0,10);
  const parts = date => `${date}T${digestAt}`;
  function resolve(date) {
    const target = Date.parse(`${parts(date)}Z`);
    let at = target;
    for (let i=0;i<3;i++) {
      const diff = target-Date.parse(`${wallTime(clock,at)}Z`);
      if (!diff) return at;
      at += diff;
    }
    throw Error('Digest wall time does not exist on this date');
  }
  let until = resolve(date);
  if (until > now) {
    date = new Date(Date.parse(`${date}T00:00:00Z`)-DAY).toISOString().slice(0,10);
    until = resolve(date);
  }
  return { date, until };
}

// Shared by the SQLite worker and read-only preview. Preserve legacy IDs for
// unrecognized diagnostics; don't reconstruct hashes from redacted free text.
export function readDigestWindow(db, prepare, { since, until, now }) {
  if (![since,until].every(Number.isSafeInteger) || since >= until || until-since > 3*DAY || until>now) throw Error('Invalid digest window');
  const groups = new Map();
  const rows = prepare(db,`SELECT e.event_id AS eventId,e.operation,e.at,e.cluster,e.reference,
    e.session_id IS NOT NULL AS hasSession,c.source,c.label,c.first_at AS origin,x.excerpt
    FROM error_events e JOIN error_clusters c ON c.id=e.cluster LEFT JOIN error_excerpts x ON x.event_seq=e.seq
    WHERE e.at>=? AND e.at<? ORDER BY e.at,e.seq`).iterate(since,until);
  for (const row of rows) {
    const known = errorSignature(row.source, '', row.excerpt);
    const sig = known?.cluster ?? row.cluster;
    const diagnostic = groupErrorLine(row.excerpt);
    const g = groups.get(sig) || {sig,source:row.source,label:known?.label ?? row.label,first:row.at,last:row.at,origin:row.origin,
      operations:new Set(), shareable:false, events:[], thresholds:new Set()};
    g.operations.add(row.operation);
    g.last = row.at;
    g.origin = Math.min(g.origin,row.origin);
    if (known?.timeoutSeconds) g.thresholds.add(known.timeoutSeconds);
    if (diagnostic) {
      g.shareable = true;
      if (!g.events.some(e=>e.operation===row.operation) && g.events.length<3) g.events.push({operation:row.operation,
        eventId:row.eventId,hasSession:Boolean(row.hasSession),at:row.at,diagnostic});
    }
    groups.set(sig,g);
  }
  return [...groups.values()].map(({operations,events,thresholds,...g})=>({ ...g,count:operations.size,
    thresholds:[...thresholds].sort((a,b)=>a-b),events:events.map(({operation,...e})=>e) }));
}

const time = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hourCycle:'h23',dateStyle:'short',timeStyle:'medium'});
export async function renderRecentErrorDigest({ groups, since, until, publicBase, maxRows=10, maxAnalyses=8, analyze=null }) {
  if (!groups.length) return '';
  const sorted = groups.filter(g=>g.shareable && g.count>=2).sort((a,b)=>b.count-a.count || a.first-b.first || a.sig.localeCompare(b.sig));
  const shown=sorted.slice(0,maxRows), overflow=sorted.slice(maxRows);
  const hidden=groups.filter(g=>!g.shareable || g.count<2);
  const total=rows=>rows.reduce((n,g)=>n+g.count,0);
  const lines=[`【报错日报】${time.format(since)} 至 ${time.format(until)}（北京时间，不含结束时刻）`];
  for (const [i,g] of shown.entries()) {
    const source = RECENT_ERROR_SOURCES[g.source] || '系统报错';
    const label = g.label === '未分类报错' ? g.events[0]?.diagnostic : g.label;
    const links = g.events.filter(e=>e.hasSession).map(e=>originalLink(publicBase,e.eventId)).filter(Boolean);
    const status = g.origin < since ? '持续' : '新增';
    const fields=[`${label}（${source}）`,`${g.count} 次`,status,`${time.format(g.first)}—${time.format(g.last)}`];
    if (g.thresholds.length) fields.push(`阈值：${g.thresholds.map(s=>`${s}s`).join('／')}`);
    if (links.length) fields.push(links.join(' · '));
    if (i < maxAnalyses && analyze) {
      const advice = await Promise.resolve().then(()=>analyze({source,label, thresholds:g.thresholds,
        events:g.events.map(e=>({at:time.format(e.at),diagnostic:e.diagnostic}))})).catch(()=>null);
      if (advice?.cause && advice?.direction) fields.push(`可能原因：${advice.cause}；修改建议：${advice.direction}`);
      else fields.push('分析暂不可用');
    }
    lines.push(fields.join('｜'));
  }
  if (overflow.length) lines.push(`另有 ${overflow.length} 类、共 ${total(overflow)} 次`);
  if (hidden.length) lines.push(`仅一次或证据不足、未公开内容的报错：${hidden.length} 类 ${total(hidden)} 次，可在监管中心近期报错查看`);
  return lines.join('\n');
}

import { errorSignature, RECENT_ERROR_SOURCES } from './recent-errors.mjs';
import { groupErrorLine, originalLink, serviceExitSignal } from './recent-error-public.mjs';

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
export function readDigestWindow(db, prepare, { since, until, now, serviceSignals=new Map() }) {
  if (![since,until].every(Number.isSafeInteger) || since >= until || until-since > 3*DAY || until>now) throw Error('Invalid digest window');
  const groups = new Map();
  const hasFacts=prepare(db,"SELECT 1 FROM sqlite_master WHERE name='error_event_facts'").get();
  const rows = prepare(db,`SELECT e.event_id AS eventId,e.operation,e.at,e.cluster,e.reference,
    e.session_id IS NOT NULL AS hasSession,c.source,c.label,c.first_at AS origin,x.excerpt
    ${hasFacts ? ',f.exit_signal AS exitSignal,f.gate_timeout_seconds AS gateTimeoutSeconds' : ''}
    FROM error_events e JOIN error_clusters c ON c.id=e.cluster LEFT JOIN error_excerpts x ON x.event_seq=e.seq
    ${hasFacts ? 'LEFT JOIN error_event_facts f ON f.event_seq=e.seq' : ''}
    WHERE e.at>=? AND e.at<? ORDER BY e.at,e.seq`).iterate(since,until);
  for (const row of rows) {
    const known = errorSignature(row.source, '', row.excerpt);
    const sig = known?.cluster ?? row.cluster;
    const signal = row.source==='service-exit' ? row.exitSignal ?? serviceSignals.get(row.reference) ?? serviceExitSignal(row.excerpt) : null;
    const diagnostic = groupErrorLine(row.excerpt) || (signal ? `退出信号：${signal}` : '');
    const g = groups.get(sig) || {sig,source:row.source,label:known?.label ?? row.label,first:row.at,last:row.at,origin:row.origin,
      operations:new Set(), shareable:false, events:[], thresholds:new Set(), objects:new Set(), signals:new Set()};
    g.operations.add(row.operation);
    g.last = row.at;
    g.origin = Math.min(g.origin,row.origin);
    if (known?.timeoutSeconds) g.thresholds.add(known.timeoutSeconds);
    if (known?.mechanism && row.gateTimeoutSeconds) g.thresholds.add(row.gateTimeoutSeconds);
    if (known?.mechanism && /^(?:sch_|trg_)[a-z0-9_-]+$/i.test(row.reference || '')) g.objects.add(row.reference);
    if (signal) g.signals.add(signal);
    if (diagnostic) {
      g.shareable = true;
      if (!g.events.some(e=>e.operation===row.operation) && g.events.length<3) g.events.push({operation:row.operation,
        eventId:row.eventId,hasSession:Boolean(row.hasSession),at:row.at,diagnostic});
    }
    groups.set(sig,g);
  }
  return [...groups.values()].map(({operations,events,thresholds,objects,signals,...g})=>({ ...g,count:operations.size,
    objectCount:objects.size,signals:[...signals].sort(),
    thresholds:[...thresholds].sort((a,b)=>a-b),events:events.map(({operation,...e})=>e) }));
}

const time = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hourCycle:'h23',dateStyle:'short',timeStyle:'medium'});
export async function renderRecentErrorDigest({ groups, since, until, publicBase, maxRows=10, maxAnalyses=8, analyze=null, repairs=[], invalid=[] }) {
  const active=new Map(repairs.filter(r=>r.state==='recurring' || r.state==='observing').map(r=>[r.signature,r]));
  const closed=repairs.filter(r=>r.state==='closed' && r.closedAt>=since);
  if (!groups.length && !closed.length && !invalid.length && ![...active.values()].some(r=>r.startedAt>=since)) return '';
  const recurring=g=>active.get(g.sig)?.state==='recurring';
  const eligible=g=>recurring(g) || g.shareable && g.count>=2;
  const sorted = groups.filter(eligible).sort((a,b)=>Number(recurring(b))-Number(recurring(a)) || b.count-a.count || a.first-b.first || a.sig.localeCompare(b.sig));
  const shown=sorted.slice(0,maxRows), overflow=sorted.slice(maxRows);
  const hidden=groups.filter(g=>!eligible(g));
  const total=rows=>rows.reduce((n,g)=>n+g.count,0);
  const lines=[`【报错日报】${time.format(since)} 至 ${time.format(until)}（北京时间，不含结束时刻）`];
  for (const [i,g] of shown.entries()) {
    const source = RECENT_ERROR_SOURCES[g.source] || '系统报错';
    const label = g.shareable ? (g.label === '未分类报错' ? g.events[0]?.diagnostic : g.label) : '证据未公开';
    const links = g.events.filter(e=>e.hasSession).map(e=>originalLink(publicBase,e.eventId)).filter(Boolean);
    const repair=active.get(g.sig);
    const status=repair?.state==='recurring' ? `复发（修复 ${repair.commit.slice(0,12)}）` : repair ? '修复观察中' : g.origin < since ? '持续' : '新增';
    const fields=[`${label}（${source}）`,`${g.count} 次`,status,`${time.format(g.first)}—${time.format(g.last)}`];
    if (g.thresholds.length) fields.push(`阈值：${g.thresholds.map(s=>`${s}s`).join('／')}`);
    if (g.source==='service-exit') fields.push(`退出信号：${g.signals?.join('／') || '未记录'}`);
    if (links.length) fields.push(links.join(' · '));
    if (i < maxAnalyses && analyze && g.shareable) {
      const advice = await Promise.resolve().then(()=>analyze({source,label, gateThresholdSeconds:g.thresholds, affectedObjects:g.objectCount || undefined, exitSignals:g.signals,
        events:g.events.map(e=>({at:time.format(e.at),diagnostic:e.diagnostic}))})).catch(()=>null);
      if (advice?.cause && advice?.direction) fields.push(`可能原因：${advice.cause}；修改建议：${advice.direction}`);
      else fields.push('分析暂不可用');
    }
    lines.push(fields.join('｜'));
  }
  const observing=[...active.values()].filter(r=>r.state==='observing' && !shown.some(g=>g.sig===r.signature));
  const brief=r=>`${r.label || '报错'}（签名 ${r.signature.slice(0,12)}，修复 ${r.commit.slice(0,12)}）`;
  if (observing.length) lines.push(`修复观察中：${observing.slice(0,maxRows).map(brief).join('、')}${observing.length>maxRows?` 等 ${observing.length} 项`:''}`);
  if (closed.length) lines.push(`本期验证关闭：${closed.slice(0,maxRows).map(brief).join('、')}${closed.length>maxRows?` 等 ${closed.length} 项`:''}`);
  if (invalid.length) lines.push(`回执无效：${[...new Set(invalid.map(r=>r.reason))].join('；')}（${invalid.length} 条）`);
  if (overflow.length) lines.push(`另有 ${overflow.length} 类、共 ${total(overflow)} 次`);
  if (hidden.length) lines.push(`仅一次或证据不足、未公开内容的报错：${hidden.length} 类 ${total(hidden)} 次，可在监管中心近期报错查看`);
  return lines.join('\n');
}

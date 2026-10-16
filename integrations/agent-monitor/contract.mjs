// Versioned data contract. Canonical source: RemoteLab integrations/agent-monitor.
// No imports from a website, renderer, publisher or runtime.
// Metric arithmetic remains owned by RemoteLab; this module only validates and selects fields.
export const metricDefinitions = [
  { key: "meanTokens", label: "平均 token 用量", unit: "token", count: "usageRuns" },
  { key: "meanInjectionChars", label: "平均上下文注入", unit: "字符", count: "injection" },
  { key: "firstInjectionChars", label: "首轮上下文注入", unit: "字符", count: "firstInjection" },
  { key: "meanFirstResponseMs", label: "平均首次响应", unit: "ms", count: "firstResponse" },
  { key: "meanDeliveryMs", label: "平均交付用时", unit: "ms", count: "delivery" },
  { key: "firstDeliveryMs", label: "首轮交付用时", unit: "ms", count: "firstDelivery" },
  { key: "totalTokens", label: "今日 token 总量", unit: "token", count: "usageRuns" },
]         ;
                                                                
                                                            
                                                                                                                                        
                                                                                                            
                                                                                                                             
                                     
                                                                                                       
                                                                                             
                                                                                       
                                                                                                                    
                                                                                      
                                                                                                    
                                                                                                                     
                                                                      
                                                                                                                    
                                                                       
                                                                                                                             

function check(ok         )             { if (!ok) throw new Error("Invalid agent snapshot"); }
function obj(value         )                          { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value                           ; }
function text(value         , max = 160)         { check(typeof value === "string" && value.length <= max); return value; }
function number(value         )         { check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER); return value; }
function nullable(value         )                { return value == null ? null : number(value); }
function stamp(value         )         { const s = text(value, 40); check(/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s))); return s; }
function maybeStamp(value         ) { return value == null ? null : stamp(value); }
function rows(value         , max        )            { check(Array.isArray(value) && value.length <= max); return value; }
function sample(value         )         { if (value == null) return { count: 0, mean: null }; const s = obj(value); const count = number(s.count); check(Number.isInteger(count)); return { count, mean: count === 0 ? null : nullable(s.mean) }; }
function stages(value         , keys          ) { const s = value == null ? {} : obj(value); return Object.fromEntries(keys.map(k => [k, sample(s[k])])); }
function day(value         )           {
  const d = obj(value), label = text(d.day, 10); check(/^\d{4}-\d{2}-\d{2}$/.test(label));
  const start = stamp(d.start); check(start === new Date(Date.parse(`${label}T05:00:00+08:00`)).toISOString());
  return { day: label, start, sessions: nullable(d.sessions), usageRuns: nullable(d.usageRuns), unknownFirstRuns: nullable(d.unknownFirstRuns),
    ...Object.fromEntries(metricDefinitions.map(m => [m.key, nullable(d[m.key])]))                                    ,
    injection: sample(d.injection), firstInjection: sample(d.firstInjection), delivery: sample(d.delivery), firstDelivery: sample(d.firstDelivery), firstResponse: sample(d.firstResponse),
    journeyStages: stages(d.journeyStages, ["receive", "prepare", "launch", "run", "send", "total"]),
    deliveryStages: stages(d.deliveryStages, ["total", "wait", "run", "send"]), firstDeliveryStages: stages(d.firstDeliveryStages, ["total", "wait", "run", "send"]),
  };
}
function dashboard(value         )                             {
  if (value === null) return null;
  const d = obj(value); check(d.timezone === "Asia/Shanghai" && d.dayStartHour === 5);
  const c = obj(d.coverage), coverage                                   = {};
  for (const k of ["limitedFiles", "readErrors", "missingRuns", "missingRequests", "missingInjections", "eligibleRuns", "sampledRuns"]) coverage[k] = number(c[k]);
  check(typeof c.truncated === "boolean"); coverage.truncated = c.truncated;
  const days = rows(d.days, 7).map(day); check(new Set(days.map(d => d.day)).size === days.length);
  const s = d.sources == null ? null : obj(d.sources);
  return { generatedAt: stamp(d.generatedAt), timezone: "Asia/Shanghai", dayStartHour: 5,
    currentRunning: nullable(d.currentRunning), todayActiveSessions: nullable(d.todayActiveSessions), unknownStates: nullable(d.unknownStates),
    today: day(d.today), days, coverage,
    semantics: Object.fromEntries(["usage", "injection", "first", "firstResponse", "journey", "stages", "delivery"].filter(k => d.semantics != null && obj(d.semantics)[k] != null).map(k => [k, text(obj(d.semantics)[k], 2000)])),
    documents: rows(d.documents, 32).map(v => { const r = obj(v); return { name: text(r.name), chars: nullable(r.chars), when: text(r.when, 400) }; }),
    sources: s ? { observedAt: stamp(s.observedAt), chars: nullable(s.chars), entries: rows(s.entries, 64).map(v => { const r = obj(v); return { name: text(r.name), chars: nullable(r.chars) }; }) } : null,
  };
}
function accounts(value         )                            {
  if (value === null) return null;
  const a = obj(value);
  return { generatedAt: stamp(a.generatedAt), items: rows(a.items, 128).map(v => {
    const r = obj(v); check(typeof r.active === "boolean");
    const status = text(r.status, 32); check(["available", "exhausted", "unknown", "stale", "error", "healthy", "limited"].includes(status));
    return { label: text(r.label), status, active: r.active, observedAt: maybeStamp(r.observedAt), windows: rows(r.windows, 8).map(v => {
      const w = obj(v), remainingPercent = nullable(w.remainingPercent); check(remainingPercent === null || remainingPercent <= 100);
      return { minutes: number(w.minutes), remainingPercent, resetsAt: maybeStamp(w.resetsAt) };
    }) };
  }) };
}
function summary(value         )                 {
  const s = obj(value); const counts = [s.available, s.exhausted, s.unknown].map(number);
  check(counts.every(n => Number.isInteger(n) && n <= 128) && counts.reduce((a, b) => a + b, 0) <= 128);
  return { available: counts[0], exhausted: counts[1], unknown: counts[2] };
}
export function parseAgentSnapshot(value         , now = Date.now())                {
  const s = obj(value); check(s.schema === 1);
  const result                = { schema: 1, accountSummary: s.accountSummary == null ? null : summary(s.accountSummary), source: text(s.source, 80), publishedAt: stamp(s.publishedAt), dashboard: dashboard(s.dashboard), accounts: accounts(s.accounts) };
  check(result.dashboard || result.accounts);
  for (const t of [result.publishedAt, result.dashboard?.generatedAt, result.accounts?.generatedAt]) if (t) check(Date.parse(t) <= now + 60_000);
  return result;
}
export function viewAgentSnapshot(snapshot               , accountsAllowed         , now = Date.now())                   {
  return { ...snapshot, accounts: accountsAllowed ? snapshot.accounts : null, accountsAllowed,
    dashboardStale: !snapshot.dashboard || now - Date.parse(snapshot.dashboard.generatedAt) > 5 * 60_000,
    accountsStale: !snapshot.accounts || now - Date.parse(snapshot.accounts.generatedAt) > 5 * 60_000 };
}

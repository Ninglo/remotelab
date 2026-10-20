import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metricComparisons, metricCandidate, populationTrendCandidates } from '../lib/metric-diagnosis.mjs';
import { metricRecipientKey } from '../lib/metric-alert-bundle.mjs';
import { processSessionDiagnostics, sessionDiagnosisCard } from '../chat/session-diagnostics.mjs';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';
import { privateDiagnosisNotification } from '../lib/session-diagnosis.mjs';

const now = Date.parse('2026-10-20T06:00:00Z'), DAY = 86400000;
const row = (id, at, value) => ({ runId: `r${id}`, sessionId: `s${id % 6}`, responseAt: at, at,
  state: 'completed', model: 'm', tool: 'codex', effort: 'high', surface: 'feishu',
  firstSessionRun: false, experiment: 'unmarked', metrics: { injectionChars: value }, sources: [] });
const history = Array.from({ length: 8 }, (_, d) => Array.from({ length: 12 }, (_, i) =>
  row(d * 100 + i, now - (d + 2) * DAY - i * 1000, 10000))).flat();
const recent = Array.from({ length: 12 }, (_, i) => row(2000 + i, now - i * 1000, 10000));
const rest = { excludedDates: ['2026-10-18'] };
assert.equal(privateDiagnosisNotification({ kind: 'metric', status: 'resolved',
  notification: { reason: 'resolved', sentSemantic: 'legacy-closed', sentRatio: 2 } },
{ metricAlerts: true }).ready, false, 'a policy upgrade does not resend already closed legacy cards');
const injection = rows => metricComparisons(rows, now, rest).find(c => c.metric === 'injectionChars' && !c.comparisonType);

const partial = row(3000, now - DAY - 3600000, 500);
let c = injection([...history, ...recent, partial]);
assert(!c.baselineRows.some(s => s.runId === partial.runId), 'the partial day before the rolling cutoff is not a complete reference date');
assert(!c.referenceDates.includes('2026-10-18'), 'confirmed rest date is excluded, not every weekend');
assert(c.referenceDates.includes('2026-10-17'), 'an unconfirmed weekend date remains eligible');
assert.equal(c.baseline, 10000);
assert.equal(c.alarm, false);
assert.equal(c.baselineDays, 7);
const earlyRest = row(3001, Date.parse('2026-10-17T18:00:00Z'), 1);
assert(!injection([...history, ...recent, earlyRest]).baselineRows.some(s => s.runId === earlyRest.runId),
  'Beijing rest-day midnight is excluded even before the 05:00 report boundary');

const low = history.map(s => ({ ...s, metrics: { injectionChars: s.responseAt >= now - 3 * DAY + 1 ? 6000 : 10000 } }));
const rebound = metricComparisons([...low, ...recent], now).find(c => c.comparisonType === 'rebound');
assert(rebound?.alarm, 'a well-supported drop then return to the old level is detected');
assert.equal(rebound.baseline, 6000);
assert.equal(rebound.previousBaseline, 10000);
assert.match(metricCandidate(rebound, now).summary, /原因|待核查/);
assert(!metricComparisons([...low, ...recent], now, rest).some(c => c.comparisonType === 'rebound'),
  'a rest-day low is not an optimization reference');
const sparseLow = low.filter(s => s.responseAt < now - 3 * DAY + 1 || Number(s.runId.slice(1)) < 3);
assert(!metricComparisons([...sparseLow, ...recent], now).some(c => c.comparisonType === 'rebound'),
  'a low with only three requests cannot establish an improvement');
assert(!metricComparisons([...low, ...recent.slice(0, 3)], now).some(c => c.alarm),
  'a three-request rebound also remains unconfirmed');
assert(!metricComparisons([...history, ...recent.slice(0, 2).map(s => ({ ...s, metrics: { injectionChars: 500 } }))], now).some(c => c.alarm),
  'an apparently excellent but tiny sample cannot establish a new normal');

const population = [...history, ...recent].map(s => ({ ...s, firstSessionRun: true }));
assert(!populationTrendCandidates(population, now, rest).length);

const root = await mkdtemp(join(tmpdir(), 'metric-reference-'));
try {
  const config = { enabled: true, metricPolicy: { enabled: true, notifyOnRegression: true, ...rest },
    notification: { enabled: true, profile: 'bot', openId: 'ou_person', feishuAppId: 'cli_app', noisePolicy: { mode: 'risk_only' } } };
  const legacy = { ...metricCandidate(c, now), id: 'old', baseline: 3000, ratio: 3.333,
    createdAt: new Date(now - DAY).toISOString(), summary: '旧基准上涨233.3%', evidence: ['原始证据'],
    notification: { sentSemantic: 'old-semantic', sentRatio: 3.333 } };
  delete legacy.baselinePolicyKey;
  const recipientKey = metricRecipientKey(config.notification);
  const state = { incidents: { old: legacy }, metricNotifications: { bundle: { id: 'bundle', kind: 'metric-bundle',
    createdAt: new Date(now - DAY).toISOString(), recipientKey, memberIds: ['old'],
    delivery: { messageId: 'om_original', chatId: 'oc_private', recipientKey, status: 'delivered' } } } };
  const stateFile = join(root, 'state.json');
  await writeDurableJson(stateFile, state);
  const sent = [];
  await processSessionDiagnostics({ config, now, stateFile,
    readSessions: async () => ({ sessions: [], coverage: {} }),
    readMetrics: async () => ({ samples: [...history, ...recent], coverage: {} }),
    deliver: async item => { sent.push(structuredClone(item)); return item.delivery; } });
  const saved = (await readRecord(stateFile)).incidents.old;
  assert.equal(saved.resolutionType, 'baseline_recalibrated');
  assert.equal(saved.baselineRevisions[0].baseline, 3000);
  assert.deepEqual(saved.baselineRevisions[0].evidence, ['原始证据']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].delivery.messageId, 'om_original', 'correct the original card without creating another notification');
  const card = sessionDiagnosisCard(sent[0], config.notification);
  assert.match(card.header.title.content, /已复核/);
  assert(!card.header.title.content.includes('已恢复'), 'a corrected comparison is not performance recovery');

  await writeDurableJson(stateFile, state);
  sent.length = 0;
  await processSessionDiagnostics({ config, now, stateFile,
    readSessions: async () => ({ sessions: [], coverage: {} }),
    readMetrics: async () => ({ samples: [], coverage: {} }), deliver: async item => { sent.push(item); return item.delivery; } });
  assert.equal((await readRecord(stateFile)).incidents.old.status, 'review_required');
  assert.equal(sent.length, 0, 'no data cannot validate a baseline correction or recovery');

  const restLow = { ...legacy, ...metricCandidate(rebound, now), id: 'old',
    notification: legacy.notification };
  delete restLow.baselinePolicyKey;
  await writeDurableJson(stateFile, { ...state, incidents: { old: restLow } });
  await processSessionDiagnostics({ config, now, stateFile,
    readSessions: async () => ({ sessions: [], coverage: {} }),
    readMetrics: async () => ({ samples: [...low, ...recent], coverage: {} }), deliver: async item => item.delivery });
  assert.match((await readRecord(stateFile)).incidents.old.summary, /休息日/);
  assert.equal((await readRecord(stateFile)).incidents.old.resolutionType, 'baseline_recalibrated',
    'a resting-date low is withdrawn even when the old rebound comparison no longer exists');

  await writeDurableJson(stateFile, state);
  await processSessionDiagnostics({ config, now, stateFile,
    readSessions: async () => ({ sessions: [], coverage: {} }),
    readMetrics: async () => ({ samples: [...history, ...recent.slice(0, 3)], coverage: {} }), deliver: async item => item.delivery });
  assert.equal((await readRecord(stateFile)).incidents.old.resolutionType, 'baseline_recalibrated',
    'old small-sample trend alerts are withdrawn by the new sample rule, without claiming improvement');

  const popOld = populationTrendCandidates(population.map(s => s.responseAt >= now - DAY
    ? { ...s, metrics: { injectionChars: 16000 } } : s), now)[0];
  const legacyPopulation = { ...legacy, ...popOld, id: 'old', notification: legacy.notification };
  delete legacyPopulation.baselinePolicyKey;
  await writeDurableJson(stateFile, { ...state, incidents: { old: legacyPopulation } });
  await processSessionDiagnostics({ config, now, stateFile,
    readSessions: async () => ({ sessions: [], coverage: {} }),
    readMetrics: async () => ({ samples: population, coverage: {} }), deliver: async item => item.delivery });
  assert.equal((await readRecord(stateFile)).incidents.old.resolutionType, 'baseline_recalibrated',
    'population incidents also use the corrected reference, even when they no longer alarm');
} finally { await rm(root, { recursive: true, force: true }); }
console.log('Metric references: complete dates, explicit rest dates, supported rebound, sparse lows and original-card correction passed');

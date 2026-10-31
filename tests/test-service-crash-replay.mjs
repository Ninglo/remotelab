import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeServiceJournal, mergeServiceCycles, serviceIncidentAttention, SERVICE_STABLE_MS } from '../chat/service-incidents.mjs';
import { dispatchMonitoringAlerts, renderMonitoringAlert } from '../chat/monitoring-alerts.mjs';

const unit = 'remotelab-sg-feishu-bot-2.service';
const rows = process.argv[2] ? (await readFile(process.argv[2], 'utf8')).trim().split('\n').map(JSON.parse)
  : Array.from({ length: 153 }, (_, i) => ({ MESSAGE: 'FATAL ERROR: JavaScript heap out of memory',
    __CURSOR: `cursor-${i}`, _SYSTEMD_INVOCATION_ID: `invocation-${i}`,
    __REALTIME_TIMESTAMP: String(Date.parse('2026-10-31T12:21:09Z') * 1000 + i * 13000_000) }));
const root = await mkdtemp(join(tmpdir(), 'incident-replay-'));
let ledger = null, sends = 0, edits = 0;
const events = mergeServiceJournal([], rows, unit);
const cycles = mergeServiceCycles([], events);
assert.equal(events.length, 153); assert.equal(cycles.length, 1); assert.equal(cycles[0].count, 153);
assert.deepEqual(mergeServiceCycles(cycles, events), cycles, 'cold replay preserves one cycle and count');
const last = Date.parse(cycles[0].lastAt);
const startedAt = new Date(last + 1000).toISOString();
const service = { unit, status: 'healthy', pid: 123, lastRunAt: startedAt };
const repair = { incidentId: cycles[0].id, unit, commit: 'a'.repeat(40), deployment: {
  commit: 'a'.repeat(40), pid: 123, startedAt,
  verifiedAt: new Date(last + 10_000).toISOString(), evidence: ['isolated deployment/version receipt'] } };
const attention = (now, repairs = [], gaps = []) => serviceIncidentAttention(cycles, [service], { now, repairs, gaps });
async function dispatch(items, now) {
  return dispatchMonitoringAlerts({ stateFile: join(root, 'alerts.json'), now,
    config: { enabled: true, noisePolicy: { mode: 'risk_only' } },
    snapshot: { generatedAt: new Date(now).toISOString(), attention: items, services: [service],
      accounts: [], disks: [], automations: { items: [] }, coverage: { gaps: [] } },
    load: async () => structuredClone(ledger), save: async (_, value) => { ledger = structuredClone(value); },
    send: async () => { sends++; return 'om_one_original_message'; },
    update: async (_, __, id) => { assert.equal(id, 'om_one_original_message'); edits++; return id; },
  });
}
try {
  await dispatch(attention(last + 10_000), last + 10_000);
  assert.equal(sends, 1); assert.equal(Object.keys(ledger.incidents).length, 1);
  const stableAt = last + SERVICE_STABLE_MS + 2000;
  const recovered = attention(stableAt);
  assert.equal(recovered[0].state, 'recovered'); assert.equal(recovered[0].repair, undefined);
  await dispatch(recovered, stableAt); assert.equal(edits, 1);
  assert.match(renderMonitoringAlert(recovered, {}), /根因修复待确认/);
  assert.equal(attention(stableAt, [{ ...repair, deployment: { ...repair.deployment, evidence: [] } }])[0].state, 'recovered');
  assert.equal(attention(stableAt, [{ ...repair, deployment: { ...repair.deployment, commit: 'b'.repeat(40) } }])[0].state, 'recovered');
  assert.equal(attention(stableAt, [repair], [{ source: `serviceJournal:${unit}` }])[0].state, 'active');
  const fixed = attention(stableAt, [repair]); assert.equal(fixed[0].state, 'fixed');
  await dispatch(fixed, stableAt + 1); assert.equal(sends, 1); assert.equal(edits, 2);
  await dispatch(fixed, stableAt + 2); assert.equal(edits, 2, 'confirmation is not repeatedly published');
  assert.match(renderMonitoringAlert(fixed, {}), /已修复/);
  const recurring = mergeServiceCycles(cycles, [{ ...events.at(-1), id: 'recurrence', at: new Date(last + 20_000).toISOString() }]);
  assert.equal(serviceIncidentAttention(recurring, [service], { now: stableAt, repairs: [repair] })[0].state, 'active', 'older deployment cannot close a later crash');
  console.log(JSON.stringify({ journalRows: rows.length, crashes: events.length, incidents: cycles.length,
    sends, updates: edits, transitions: ['active', 'recovered', 'fixed'], sameMessage: true }));
} finally { await rm(root, { recursive: true, force: true }); }

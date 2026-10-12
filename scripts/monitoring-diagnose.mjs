#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { monitoringDiagnosticReport } from '../lib/monitoring-policy.mjs';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, kind: { type: 'string' }, id: { type: 'string' } } });
if (values.help) {
  console.log('Usage: node scripts/monitoring-diagnose.mjs [--kind service|disk|api|automation|accountContinuity|coverage] [--id ID]\nRead-only local diagnosis. No recovery admission, account switching, provider probes, sending, deletion or service restart.');
} else {
  if (values.kind && !['service', 'disk', 'api', 'automation', 'accountContinuity', 'coverage'].includes(values.kind)) throw new Error('INVALID_KIND');
  if (values.id && !values.kind) throw new Error('KIND_REQUIRED_WITH_ID');
  // Reuse bounded local collectors; usage aggregation is unnecessary here.
  // Some legacy transitive imports announce tool discovery. Keep machine-readable
  // stdout clean in this standalone CLI, without changing the server logger.
  const log = console.log;
  let createMonitoringReader;
  try {
    console.log = (...args) => console.error(...args);
    ({ createMonitoringReader } = await import('../chat/monitoring.mjs'));
  } finally { console.log = log; }
  const snapshot = await createMonitoringReader({ getUsage: async () => null })();
  console.log(JSON.stringify(monitoringDiagnosticReport(snapshot, values), null, 2));
}

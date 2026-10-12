#!/usr/bin/env node
import { readRecord } from '../lib/durable-records.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { join } from 'node:path';

const log = console.log;
let createMonitoringReader, processSessionDiagnostics;
try { console.log = (...args) => console.error(...args);
  ({createMonitoringReader} = await import('../chat/monitoring.mjs'));
  ({processSessionDiagnostics} = await import('../chat/session-diagnostics.mjs'));
} finally { console.log = log; }
const dryRun = process.argv.includes('--dry-run');
if (!dryRun || process.argv.some(a => a.startsWith('--') && a !== '--dry-run')) {
  console.error('Usage: node scripts/session-diagnose.mjs --dry-run\nPreview session diagnosis candidates without sending, writing state or admitting work. The existing monitoring observer owns live processing.');
  process.exitCode=2;
} else {
  const config=await readRecord(join(CONFIG_DIR,'monitoring.json'));
  const snapshot=await createMonitoringReader({getUsage:async()=>null})();
  console.log(JSON.stringify(await processSessionDiagnostics({config:{...config?.sessionDiagnostics,enabled:true},snapshot,dryRun}),null,2));
}

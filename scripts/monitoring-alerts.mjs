import { runMonitoringAlerts } from '../chat/monitoring-alerts.mjs';
console.log(JSON.stringify(await runMonitoringAlerts({ baseline: process.argv.includes('--baseline'), dryRun: process.argv.includes('--dry-run') })));

import { parentPort } from 'node:worker_threads';
import { readSessionMonitoring, readDashboardSessions } from './monitoring-sessions.mjs';

// Runs the file-scanning Session monitoring readers in their own V8 heap. Their
// projection caches stay here, so dashboard scans never become resident in the
// core service that receives messages.
parentPort.on('message', async ({ id, days, dashboard }) => {
  try {
    const data = await (dashboard ? readDashboardSessions : readSessionMonitoring)({ days, dashboard });
    parentPort.postMessage({ id, data });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error) });
  }
});

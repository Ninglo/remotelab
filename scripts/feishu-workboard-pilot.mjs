#!/usr/bin/env node
// Fail closed: an old service must never become a second card writer.
console.error('Standalone Feishu card services are retired. Stop and disable this unit, preserve its receipt state, and restart the Feishu connector. See notes/current/feishu-workboard-pilot.md.');
process.exitCode = 0;

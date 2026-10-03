import { CONFIG_DIR } from '../lib/config.mjs';
import { captureMonitoringSnapshot } from '../lib/monitoring-snapshot.mjs';

const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes('--help')) {
  console.log('Capture urgent issues and account allowance from the authenticated monitoring UI.\nUsage: node scripts/monitoring-snapshot.mjs --output <prefix> --base-url <instance> [--days 1|7|30] [--upload]\nWrites PNG, source JSON and a receipt. --upload uploads as the configured Bot and writes an image-key Markdown block for the existing daily reply. Never sends a message.');
} else {
  const output = argument('--output', null), baseUrl = argument('--base-url', process.env.REMOTELAB_CHAT_BASE_URL);
  if (!output || !baseUrl) throw new Error('Provide --output and --base-url');
  console.log(JSON.stringify(await captureMonitoringSnapshot({ output, baseUrl, days: Number(argument('--days', '1')), configDir: CONFIG_DIR, upload: args.includes('--upload') })));
}

import { readFile } from 'node:fs/promises';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';
export async function runInflightTrialCommand(argv = [], io = {}) {
  const out = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help')) {
    out.write('Usage: remotelab input-trial inspect --request-id <id> [--include-text] [--json]\n  remotelab input-trial reply --file <json> [--json]\n  remotelab input-trial stop --request-id <id> --expected-run <runId> [--json]\nPersonal Feishu v1 tool trial. Enable/disable with message-replies input-trial on|off|status.\n'); return 0;
  }
  const [action, ...args] = argv;
  if (!['inspect', 'reply', 'stop'].includes(action)) throw new Error('Unknown input-trial action');
  const body = { runId: io.runId || process.env.REMOTELAB_RUN_ID };
  let file;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--include-text' && action === 'inspect') body.includeText = true;
    else if (args[i] === '--request-id') body.sourceRequestId = args[++i];
    else if (args[i] === '--expected-run' && action === 'stop') body.expectedRunId = args[++i];
    else if (args[i] === '--file' && action === 'reply') file = args[++i];
    else throw new Error('Invalid input-trial argument');
  }
  if (file) Object.assign(body, JSON.parse(await readFile(file, 'utf8')), { runId: body.runId });
  if (!body.runId || !body.sourceRequestId) throw new Error('Current run and explicit sourceRequestId are required');
  const result = await (io.client || createRemoteLabHttpClient()).request('/api/input-trial/' + action, { method: 'POST', body });
  if (!result.response.ok) throw new Error(result.json?.error || result.text);
  out.write(JSON.stringify(result.json) + '\n'); return 0;
}

import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

const help = `Usage:
  remotelab message-replies strict-start|input-trial|parallel-work|self-review status|on|off [--json]
  remotelab message-replies strict-start on --rule-version v1|v2|v3 [--json]

Uses the current REMOTELAB_RUN_ID's verified human Request. Only that Person's
selected personal trial changes; opening/checklist/progress choices are retained.
Use on/off only when the requester explicitly asks to change this setting.
New work uses the saved setting; already accepted work retains its snapshot.
Select a rule version only when the requester authorizes that rule change.
Turning input-trial off immediately disables its tools as well.
`;

export async function runMessageReplyCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help')) { stdout.write(help); return 0; }
  const [setting, action, ...flags] = argv;
  let ruleVersion;
  const remaining = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--rule-version') {
      if (ruleVersion || setting !== 'strict-start' || action !== 'on' || !['v1', 'v2', 'v3'].includes(flags[i + 1])) {
        throw new Error('Use strict-start on --rule-version v1|v2|v3');
      }
      ruleVersion = flags[++i];
    } else remaining.push(flags[i]);
  }
  if (!['strict-start', 'input-trial', 'parallel-work', 'routing', 'self-review'].includes(setting) || !['status', 'on', 'off'].includes(action)
      || remaining.some(flag => flag !== '--json')) throw new Error('Use message-replies strict-start|input-trial|parallel-work|self-review status, on or off');
  const runId = io.runId || process.env.REMOTELAB_RUN_ID;
  if (!runId) throw new Error('A current accepted human Run is required');
  const client = io.client || createRemoteLabHttpClient();
  const path = '/api/message-reply-settings/current-run';
  let result = await client.request(path + '?' + new URLSearchParams({ runId, setting }));
  if (!result.response.ok) throw new Error(result.json?.error || result.text);
  if (action !== 'status') {
    result = await client.request(path, { method: 'POST', body: { runId, setting,
      ...(ruleVersion ? { ruleVersion } : {}),
      expectedRevision: result.json.settings.revision, confirm: true, enabled: action === 'on' } });
    if (!result.response.ok) throw new Error(result.json?.error || result.text);
  }
  stdout.write(JSON.stringify(result.json, null, flags.includes('--json') ? 0 : 2) + '\n');
  return 0;
}

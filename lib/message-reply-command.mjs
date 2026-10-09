import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

const help = `Usage:
  remotelab message-replies strict-start status|on|off [--json]

Uses the current REMOTELAB_RUN_ID's verified human Request. Only that Person's
strict work-start check changes; opening/checklist/progress choices are retained.
Use on/off only when the requester explicitly asks to change this setting.
New work uses the saved setting; already accepted work retains its snapshot.
`;

export async function runMessageReplyCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!argv.length || argv.includes('--help')) { stdout.write(help); return 0; }
  const [setting, action, ...flags] = argv;
  if (setting !== 'strict-start' || !['status', 'on', 'off'].includes(action)
      || flags.some(flag => flag !== '--json')) throw new Error('Use message-replies strict-start status, on or off');
  const runId = io.runId || process.env.REMOTELAB_RUN_ID;
  if (!runId) throw new Error('A current accepted human Run is required');
  const client = io.client || createRemoteLabHttpClient();
  const path = '/api/message-reply-settings/current-run';
  let result = await client.request(path + '?' + new URLSearchParams({ runId }));
  if (!result.response.ok) throw new Error(result.json?.error || result.text);
  if (action !== 'status') {
    result = await client.request(path, { method: 'POST', body: { runId,
      expectedRevision: result.json.settings.revision, confirm: true, enabled: action === 'on' } });
    if (!result.response.ok) throw new Error(result.json?.error || result.text);
  }
  stdout.write(JSON.stringify(result.json, null, flags.includes('--json') ? 0 : 2) + '\n');
  return 0;
}

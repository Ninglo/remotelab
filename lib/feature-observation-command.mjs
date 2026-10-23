import { readFile } from 'node:fs/promises';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

export async function runFeatureObservationCommand(args, io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!args.length || args.includes('--help')) {
    stdout.write('Usage: remotelab feature-observation begin|finish --request-id <accepted-input> [--file <result.json>]\nRecords one review stage for enabled self-review; configured observation cohorts aggregate it. No setting changes.\n'); return 0;
  }
  const [action, ...flags] = args;
  if (!['begin','finish'].includes(action) || flags.length % 2) throw new Error('Use begin or finish');
  const values = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--request-id','--file'].includes(flags[i]) || values[flags[i]]) throw new Error('Unknown or duplicate flag');
    values[flags[i]] = flags[i + 1];
  }
  const runId = io.runId || process.env.REMOTELAB_RUN_ID;
  if (!runId || !values['--request-id']) throw new Error('Current Run and accepted Request are required');
  if (action === 'finish' && !values['--file'] || action === 'begin' && values['--file']) throw new Error('Only finish requires --file');
  const result = action === 'finish' ? JSON.parse(await readFile(values['--file'], 'utf8')) : {};
  if (Object.keys(result).some(k => !['outcome','metrics','checks'].includes(k))) throw new Error('Unknown result field');
  const response = await (io.client || createRemoteLabHttpClient()).request('/api/monitoring/feature-observations', {
    method: 'POST', body: { ...result, action, runId, requestId: values['--request-id'] } });
  if (!response.response.ok) throw new Error(response.json?.error || 'Observation failed');
  stdout.write(JSON.stringify(response.json) + '\n'); return 0;
}

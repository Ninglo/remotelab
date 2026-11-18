import { readFile } from 'node:fs/promises';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

export async function runHrAccessCommand(args, io = {}) {
  const stdout = io.stdout || process.stdout;
  if (!args.length || args.includes('--help')) {
    stdout.write('Usage: remotelab hr-access show | change --file <change.json> | feedback --file <review.json>\n'
      + 'Uses the current accepted human Run. Change: {action:add|remove|bind|roles|scope,target,expectedVersion,reason,roles?|scope?|subject?|binding?}.\n'
      + 'Review: {candidateId,interviewId,text,score?,append?}. Only the authenticated interviewer can submit their own review.\n'
      + 'Only HR1 manages existing users. Only the owner adds/removes users or completes a verified Feishu binding. No RemoteLab credentials are issued.\n');
    return 0;
  }
  if (!(args.length === 1 && args[0] === 'show') && !(args.length === 3 && ['change','feedback'].includes(args[0]) && args[1] === '--file')) throw new Error('Invalid hr-access command');
  const runId = io.runId || process.env.REMOTELAB_RUN_ID;
  if (!runId) throw new Error('An active authenticated human Run is required');
  const change = ['change','feedback'].includes(args[0]) ? JSON.parse(await readFile(args[2],'utf8')) : undefined;
  const result = await (io.client || createRemoteLabHttpClient()).request(args[0]==='feedback' ? '/api/hr-access/feedback' : '/api/hr-access/policy', {
    method:'POST',body:{runId,...(change ? {[args[0]]:change} : {})}});
  if (!result.response.ok) throw new Error(result.json?.error || 'HR access unavailable');
  stdout.write(JSON.stringify(result.json)+'\n'); return 0;
}

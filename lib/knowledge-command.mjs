import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

export async function runKnowledgeCommand(args,io={}) {
  const stdout=io.stdout || process.stdout;
  if (!args.length || args.includes('--help')) {
    stdout.write('Usage: remotelab knowledge search --query <problem> | read --page <file.md> | report --file <effect.json> [--request-id <accepted-input>] [--operation-id <retry-id>]\nOnly for an explicitly enabled requester. Reads are versioned and measured; no corpus writes.\n');return 0;
  }
  const [action,...flags]=args, values={};
  if (!['search','read','report'].includes(action) || flags.length%2) throw new Error('Use search, read or report');
  for(let i=0;i<flags.length;i+=2) {
    if(!['--query','--page','--file','--request-id','--operation-id'].includes(flags[i]) || values[flags[i]]) throw new Error('Unknown or duplicate flag');
    values[flags[i]]=flags[i+1];
  }
  const requestId=values['--request-id'] || io.requestId || process.env.REMOTELAB_REQUEST_ID;
  const runId=io.runId || process.env.REMOTELAB_RUN_ID;
  if(!requestId || !runId) throw new Error('Current accepted Request and Run required');
  if(!values[{search:'--query',read:'--page',report:'--file'}[action]]) throw new Error('Missing action argument');
  const body={action,runId,requestId,operationId:values['--operation-id'] || randomUUID(),
    ...(action==='search'?{query:values['--query']}:action==='read'?{page:values['--page']}:{report:JSON.parse(await readFile(values['--file'],'utf8'))})};
  const result=await (io.client || createRemoteLabHttpClient()).request('/api/knowledge-pilot',{method:'POST',body});
  if(!result.response.ok) throw new Error(result.json?.error || 'Knowledge request failed');
  stdout.write(JSON.stringify(result.json)+'\n');return 0;
}

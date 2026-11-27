import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { PERSONAL_ANTIGRAVITY_API } from './personal-antigravity.mjs';

try {
  const { response, json } = await createRemoteLabHttpClient().request(PERSONAL_ANTIGRAVITY_API + '/run', {
    method: 'POST',
    body: { runId: process.env.REMOTELAB_RUN_ID },
    signal: AbortSignal.timeout(250_000),
  });
  if (!response.ok || typeof json?.response !== 'string') throw new Error(json?.error || '本机 Antigravity 没有返回结果。');
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: json.response } }));
} catch (error) {
  console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: error.message } }));
  process.exitCode = 1;
}

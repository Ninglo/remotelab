import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';

// Only the trusted application boundary signs identity. Neither model text nor
// an upstream caller can supply a key, endpoint or actor to this transport.
export async function queryHrService(config, query, actor, {messageId = randomUUID(), fetchImpl = fetch, now = Date.now()} = {}) {
  if (!config?.endpoint?.startsWith('https://')) throw new Error('HR service is not configured');
  const credentials = JSON.parse(await readFile(config.credentialsPath, 'utf8'));
  const body = JSON.stringify({version:1, appId:config.appId, tenantKey:config.tenant,
    senderOpenId:actor?.openId || actor?.id || 'policy-service', ...(actor ? {subjectId:actor.id} : {}),
    messageId, issuedAt:now, query});
  const response = await fetchImpl(config.endpoint, {method:'POST', redirect:'error', body,
    headers:{'Content-Type':'application/json', Authorization:`Bearer ${credentials.apiKey}`,
      'X-Interview-Signature':createHmac('sha256',credentials.signingKey).update(body).digest('hex')},
    signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`HR service unavailable (${response.status})`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('Invalid HR service response');
  const packet = JSON.parse(text);
  return packet.data || packet;
}

import { readFile } from 'node:fs/promises';

export function protectedSourceAttribution(options = {}) {
  const source = options.sourceContext || {};
  return { feishuConnectorAuthenticated: options.feishuConnectorAuthenticated === true,
    sourceContext: { connector: source.connector, sourceRouteId: source.sourceRouteId,
      tenantKey: source.tenantKey, chatType: source.chatType,
      sender: source.sender && { senderType: source.sender.senderType, openId: source.sender.openId } } };
}

// Only server-authenticated attribution belongs here. Display names, browser
// administrator roles and the Session creator are deliberately irrelevant.
export function confidentialActorAllowed(config, options = {}) {
  const source = options.sourceContext || {};
  if (options.feishuConnectorAuthenticated === true && source.connector === 'feishu') {
    return source.sender?.senderType === 'user' && (config.allowFeishu || []).some(entry =>
      entry.route === source.sourceRouteId && entry.tenant === source.tenantKey && entry.openId === source.sender.openId);
  }
  return (config.allowPairs || []).some(([person, identity]) => person && identity
    && person === options.viewPersonId && identity === options.initiatedByIdentityId);
}

export async function checkHrSourceCaller(caller, configPath = process.env.REMOTELAB_REQUEST_ACCESS_GUARD) {
  if (!configPath) return false;
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (![1, 2].includes(config.version) || !config.policyId || !Array.isArray(config.allowPairs)) return false;
  const options = { viewPersonId: caller?.personId, initiatedByIdentityId: caller?.identityId,
    feishuConnectorAuthenticated: caller?.feishuConnectorAuthenticated, sourceContext: caller?.sourceContext };
  // A task-specific group maintenance grant does not authorize HR data output.
  if (options.feishuConnectorAuthenticated && options.sourceContext?.connector === 'feishu'
      && !['p2p', 'private'].includes(options.sourceContext.chatType)) return false;
  return confidentialActorAllowed(config, options);
}

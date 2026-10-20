import { findIdentity, loadAuthDocument, updateAuthDocument } from '../lib/auth-config.mjs';

const fail = (message, status = 403) => { throw Object.assign(new Error(message), { status }); };
function personFor(document, actor) {
  const identity = findIdentity(document, actor?.identityId);
  if (!actor?.personId || identity?.person.id !== actor.personId || actor.authKind === 'service') fail('需要已核实的本人身份。');
  return identity.person;
}
const settingsFor = person => ({ version: 1, revision: 0, enabled: false,
  ...(person.preferences?.inflightTrial || {}), personId: person.id });
export async function loadInflightTrial(actor) {
  return settingsFor(personFor(await loadAuthDocument({ persistMigration: false }), actor));
}
export async function changeInflightTrial(input, actor) {
  if (typeof input.enabled !== 'boolean' || input.confirm !== true) fail('请明确开启或关闭运行中输入试用。', 400);
  return (await updateAuthDocument(document => {
    const person = personFor(document, actor), previous = settingsFor(person);
    if (input.expectedRevision !== previous.revision) fail('试用设置已变化，请重新读取。', 409);
    if (previous.enabled === input.enabled) return previous;
    const next = { version: 1, revision: previous.revision + 1, enabled: input.enabled,
      changedAt: new Date().toISOString(), source: { sessionId: actor.sessionId, requestId: actor.requestId,
        runId: actor.runId, identityId: actor.identityId } };
    person.preferences = { ...person.preferences, inflightTrial: next };
    return settingsFor(person);
  })).result;
}
export async function captureInflightTrial(options) {
  if (options.internalOperation || options.automationTitle || options.workReference || options.recordUserMessage === false
      || !options.feishuConnectorAuthenticated || options.sourceContext?.connector !== 'feishu'
      || !['p2p', 'group'].includes(options.sourceContext.chatType) || !options.sourceContext.sender?.openId
      || options.sourceDelivery?.connector !== 'feishu' || options.sourceDelivery.target?.chatId !== options.sourceContext.chatId
      || options.sourceDelivery.sourceRouteId !== options.sourceContext.sourceRouteId
      || !options.sourceContext?.messageId || ['bot', 'app'].includes(options.sourceContext?.sender?.senderType)) return null;
  try {
    const settings = await loadInflightTrial({ personId: options.viewPersonId, identityId: options.initiatedByIdentityId });
    return settings.enabled && settings.version === 1 ? { version: 1, enabled: true,
      personId: settings.personId, identityId: options.initiatedByIdentityId, revision: settings.revision } : null;
  } catch { return null; }
}
export function inflightTrialEnabled(options) {
  const trial = options?.inflightTrial;
  return trial?.version === 1 && trial.enabled === true && trial.personId === options.viewPersonId
    && trial.identityId === options.initiatedByIdentityId;
}
export function inflightTrialPrompt(options) {
  if (!inflightTrialEnabled(options)) return '';
  return `This sender has opted into in-flight input tools v1 (Person ${options.viewPersonId}, setting revision ${options.inflightTrial.revision}), only for their Feishu inputs in work they started. Others do not inherit it; it does not erase shared model history.
Trigger: need an input/receipt or interrupted-question lookup, an outbox supplementary reply, or an explicit whole-run stop. Before using input-trial, read $REMOTELAB_PROJECT_ROOT/docs/inflight-input-tools.md for the exact operation. Ordinary replies need no lookup; do not poll or reread the whole conversation.
Keep unresolved questions and consent boundaries. Silence or a side answer is not permission. Never send the same answer through both tool and native replies; the main task still needs its final. No extra worker, fixed wait or draft gate.`;
}

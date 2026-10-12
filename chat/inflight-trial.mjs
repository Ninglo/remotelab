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
  return `This sender has opted into in-flight input tools v1 (Person ${options.viewPersonId}, setting revision ${options.inflightTrial.revision}). This capability is limited to that person's Feishu inputs in work they started. Other participants do not inherit it. It does not erase shared model history.
Use node "$REMOTELAB_PROJECT_ROOT/cli.js" input-trial inspect --request-id <current-input-id> --json only when useful. It reads input IDs, delivery receipts and retained unanswered questions; it never injects or resends user input. Text is omitted unless explicitly requested with --include-text. Do not poll it or reread the whole conversation routinely.
For a useful supplementary answer, input-trial reply --file <json> --json accepts {sourceRequestId,replyId,requestIds,text}. Pick a stable replyId, associate one or several of this person's accepted inputs, and reuse exactly the same packet after uncertain tool results. It uses the existing outbox; do not repeat that answer in a reply tag or final message. The main task still needs its final result. Ordinary native replies remain available; do not use both paths for the same answer.
A new message does not require a separate answer. Reply promptly with information already established; combine compatible questions when useful, and do not wait for a slow extra query. Revise a draft if new information invalidates it. Do not introduce fixed waits, a draft gate, a classifier, a separate task or repeated context injection.
For an explicit instruction to stop the entire current execution, input-trial stop --request-id <the-stop-input-id> --expected-run <current-run-id> --json invokes the existing cancellation path for that exact run. It does not change participation mode or stop external jobs. Do not use it when the user only cancels one step. A stop request is not proof of terminal completion.
An interrupted native question can be returned unanswered and its old buttons retired. Preserve unresolved requirements; inspect only the needed retained question and ask again if it is still necessary. Never treat an insertion, silence or a side answer as permission. There is no parallel answer worker or automatic draft withholding in v1.`;
}

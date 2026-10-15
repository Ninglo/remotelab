import { loadAuthDocument } from '../../lib/auth-config.mjs';
import { routingPilotCardScope } from '../../lib/group-routing-pilot.mjs';
import { loadPersonMessageReplies, changePersonMessageReplies } from '../../chat/person-message-replies.mjs';

// Called only after the signed connector callback, current card and chat are
// checked by group-configuration. Never accept a Person ID from card payloads.
export async function personalRoutingCardAction(runtime, record, openId, action, eventId) {
  try {
    const scope = await routingPilotCardScope({ connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId, target: record.source });
    if (!scope?.personalOptIn) throw Error('本群尚未开放个人分流试用。');
    const document = await loadAuthDocument({ persistMigration: false });
    const matches = document.people.flatMap(person => (person.identities || [])
      .filter(identity => identity.kind === 'feishu' && identity.realm === runtime.config.sourceRouteId && identity.subjectId === openId)
      .map(identity => ({ personId: person.id, identityId: identity.id, authKind: 'feishu-card', eventId, chatId: record.source.chatId, messageId: record.cardMessageId })));
    if (matches.length !== 1) throw Error('尚未核对你的个人身份，请先在本群向机器人发一条消息，再点击按钮。');
    if (!eventId) throw Error('缺少卡片操作标识，请重新点击。');
    const actor = matches[0];
    let settings = await loadPersonMessageReplies(actor);
    if (action !== 'routing-status') {
      const enabled = action === 'routing-on';
      if ((settings.choices.routing === 'experimental') !== enabled) {
        settings = await changePersonMessageReplies({ action: 'routing', enabled, confirm: true, expectedRevision: settings.revision }, actor);
      }
    }
    return { toast: { type: 'success', content: `你本人的分流试用${settings.choices.routing === 'experimental' ? '已开启' : '已关闭'}。仅影响你的后续输入，其他成员不变。` } };
  } catch (error) {
    return { toast: { type: 'error', content: error.message } };
  }
}

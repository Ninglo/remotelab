import { join } from 'node:path';
import { readRecord } from '../../lib/durable-records.mjs';
import { createMeetingCli, materialError } from './meeting-materials.mjs';

// Enterprise discovery and artifact ACLs are capabilities, not participation.
// Use the provider's exact source chat, never a title, organizer, forwarded
// link, caller-provided chat or ingestion destination.
export function createMeetingScopeChecker(runtime, api, options = {}) {
  const cli = options.cli || createMeetingCli(runtime);
  return async function checkScope(policy, discovery) {
    const result = (allowed, reason, evidence = {}) => ({ allowed, reason, ...evidence });
    if (policy.scope?.mode !== 'participating') return result(false, 'participation_scope_required');
    const saved = await readRecord(join(runtime.config.storageDir, 'meeting-observer', `${discovery.meetingId}.json`));
    if (saved?.meetingId === discovery.meetingId && saved.appId === policy.appId
      && saved.tenantKey === policy.tenantKey && Number.isFinite(Date.parse(saved.joinVerifiedAt))) {
      return result(true, 'bot_attended', { verifiedAt: saved.joinVerifiedAt, evidence: 'observer_events_read' });
    }
    const data = await api({ method: 'GET', url: `/open-apis/vc/v1/meetings/${discovery.meetingId}`,
      params: { with_participants: true, user_id_type: 'open_id' } });
    if (data.meeting?.id !== discovery.meetingId) return result(false, 'meeting_identity_unverified');
    const botOpenId = runtime.botIdentity?.openId;
    const participant = botOpenId && data.meeting.participants?.find(p =>
      p.id === botOpenId && (Number(p.in_meeting_duration) > 0 || Number(p.first_join_time) > 0));
    if (participant) return result(true, 'bot_attended', {
      botOpenId, firstJoinTime: participant.first_join_time, evidence: 'meeting_participant_snapshot',
    });
    const chatId = data.meeting.chat_id;
    if (/^oc_[A-Za-z0-9]+$/.test(chatId || '')) {
      const membership = await api({ method: 'GET',
        url: `/open-apis/im/v1/chats/${chatId}/members/is_in_chat` });
      if (membership.is_in_chat === true) return result(true, 'source_group_member', {
        chatId, evidence: 'meeting_source_chat_and_bot_membership',
      });
      // Optional, explicitly authorized metadata lookup using this profile's
      // existing user session. No artifact content or ACL operation is involved.
      const members = policy.scope.groupMemberOpenIds || [];
      if (policy.scope.userGroupLookup === true && members.length) {
        const seen = new Set(); let pageToken;
        try {
          do {
            const page = await cli(['im', 'chat.members', 'get', '--params', JSON.stringify({
              chat_id: chatId, member_id_type: 'open_id', page_size: 100,
              ...(pageToken ? { page_token: pageToken } : {}),
            })], 'user');
            const match = page.items?.find(m => m.member_id_type === 'open_id'
              && m.tenant_key === policy.tenantKey && members.includes(m.member_id));
            if (match) return result(true, 'authorized_source_group_member', {
              chatId, memberOpenId: match.member_id, evidence: 'meeting_source_chat_and_user_member_list',
            });
            if (!page.has_more) break;
            pageToken = page.page_token;
            if (!pageToken || seen.has(pageToken)) throw Error('Incomplete group member pagination');
            seen.add(pageToken);
          } while (true);
        } catch (error) {
          return result(false, 'source_group_membership_unavailable', { chatId, error: materialError(error) });
        }
      }
    }
    return result(false, 'no_participation_evidence');
  };
}

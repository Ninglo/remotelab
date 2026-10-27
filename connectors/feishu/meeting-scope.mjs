import { join } from 'node:path';
import { readRecord } from '../../lib/durable-records.mjs';
import { createMeetingCli, materialError } from './meeting-materials.mjs';

// Enterprise discovery and artifact ACLs are capabilities, not participation.
// Use the provider's exact source chat or explicitly authorized organizer, never a title, forwarded
// link, caller-provided chat or ingestion destination.
export function createMeetingScopeChecker(runtime, api, options = {}) {
  const cli = options.cli || createMeetingCli(runtime);
  return async function checkScope(policy, discovery) {
    const result = (allowed, reason, evidence = {}) => ({ allowed, reason, ...evidence });
    const organizerMode = policy.scope?.mode === 'source_group_or_organizer';
    if (!organizerMode && policy.scope?.mode !== 'participating') return result(false, 'participation_scope_required');
    if (discovery.appId !== policy.appId || discovery.tenantKey !== policy.tenantKey)
      return result(false, 'meeting_identity_unverified');
    const saved = await readRecord(join(runtime.config.storageDir, 'meeting-observer', `${discovery.meetingId}.json`));
    const savedMatches = saved?.meetingId === discovery.meetingId && saved.appId === policy.appId
      && saved.tenantKey === policy.tenantKey;
    if (!organizerMode && savedMatches && Number.isFinite(Date.parse(saved.joinVerifiedAt))) {
      return result(true, 'bot_attended', { verifiedAt: saved.joinVerifiedAt, evidence: 'observer_events_read' });
    }
    const data = await api({ method: 'GET', url: `/open-apis/vc/v1/meetings/${discovery.meetingId}`,
      params: { with_participants: true, user_id_type: 'open_id' } });
    if (data.meeting?.id !== discovery.meetingId) return result(false, 'meeting_identity_unverified');
    const botOpenId = runtime.botIdentity?.openId;
    const participant = botOpenId && data.meeting.participants?.find(p =>
      p.id === botOpenId && (Number(p.in_meeting_duration) > 0 || Number(p.first_join_time) > 0));
    if (!organizerMode && participant) return result(true, 'bot_attended', {
      botOpenId, firstJoinTime: participant.first_join_time, evidence: 'meeting_participant_snapshot',
    });
    // owner is the organizer. host_user and participants cannot substitute.
    const owner = data.meeting.owner?.id;
    const ownerOpenId = (typeof owner === 'string' ? owner : owner?.open_id)
      || (savedMatches ? saved.ownerOpenId : '');
    const organizerIds = policy.scope.organizerOpenIds || [];
    const endedAt = /^\d+$/.test(String(discovery.endedAt)) ? Number(discovery.endedAt) * 1000 : Date.parse(discovery.endedAt);
    const organizerEligible = organizerMode && organizerIds.length > 0
      && (!policy.scope.organizerNotBefore || endedAt >= Date.parse(policy.scope.organizerNotBefore));
    if (organizerEligible && organizerIds.includes(ownerOpenId)) return result(true, 'authorized_organizer', {
      organizerOpenId: ownerOpenId, evidence: owner ? 'meeting_owner' : 'observer_owner',
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
      if (!organizerMode && policy.scope.userGroupLookup === true && members.length) {
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
    if (organizerEligible && !ownerOpenId && policy.scope.userOrganizerLookup === true) {
      // Provider-filtered organizer search can resolve missing owner fields.
      // Match the exact meeting ID, paginate, and never infer from a host/name.
      const start = Number(data.meeting.start_time) * 1000;
      if (Number.isFinite(start) && start > 0 && Number.isFinite(endedAt)) {
        const seen = new Set(); let pageToken;
        try {
          do {
            const page = await cli(['vc', '+search', '--organizer-ids', organizerIds.join(','),
              '--start', new Date(start - 60000).toISOString(), '--end', new Date(endedAt + 60000).toISOString(),
              '--page-size', '30', ...(pageToken ? ['--page-token', pageToken] : [])], 'user');
            if (page.items?.some(m => (m.meeting_id || m.id) === discovery.meetingId)) return result(true, 'authorized_organizer', {
              organizerOpenIds: organizerIds, evidence: 'provider_organizer_filtered_search',
            });
            if (!page.has_more) break;
            pageToken = page.page_token;
            if (!pageToken || seen.has(pageToken)) throw Error('Incomplete organizer pagination');
            seen.add(pageToken);
          } while (true);
        } catch (error) { return result(false, 'organizer_lookup_unavailable', { chatId, error: materialError(error) }); }
      }
    }
    if (organizerMode) return result(false, ownerOpenId ? 'outside_source_group_and_organizers' : 'organizer_unverified', { chatId });
    return result(false, 'no_participation_evidence');
  };
}

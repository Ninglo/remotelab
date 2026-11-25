import { materialError } from './meeting-materials.mjs';

const chatPattern = /^oc_[A-Za-z0-9]+$/;
const eventPattern = /^([A-Za-z0-9-]+)_(0|[1-9]\d*)$/;
const calendarPattern = /^[A-Za-z0-9_.@-]{1,250}$/;
const calendarPath = id => `/open-apis/calendar/v4/calendars/${encodeURIComponent(id)}/events`;
const joinIds = participants => new Set((Array.isArray(participants) ? participants : [])
  .filter(p => Number(p?.first_join_time) > 0 || Number(p?.in_meeting_duration) > 0)
  .map(p => typeof p.id === 'string' ? p.id : p.id?.open_id));

// This adds only designated calendar sources. A card is a locator, not proof
// that this occurrence invited the chat. No personal identity or calendar scan.
export async function checkCalendarMeetingSource(policy, meeting, saved, endedAt, api) {
  const config = policy.scope.calendarSource;
  const cutoff = Date.parse(config?.notBefore);
  if (!Number.isFinite(cutoff) || !(endedAt >= cutoff)) return null;
  const detailId = meeting.calendar_event_id;
  const observerId = saved?.calendarEventId;
  const detail = eventPattern.exec(detailId || '');
  const observer = eventPattern.exec(observerId || '');
  // The provider can give a series master in one view and the exact instance
  // in the other. Distinct occurrences or unrelated series are not equivalent.
  const eventId = detail?.[2] === '0' && observer?.[1] === detail[1] ? observerId : (detailId || observerId);
  const uid = eventPattern.exec(eventId || '')?.[1];
  const target = uid && config.targets && Object.hasOwn(config.targets, uid) && config.targets[uid];
  if (!target || !chatPattern.test(target.chatId || '')) return null;
  const evidence = { chatId: target.chatId, calendarEventId: eventId };
  const reject = (reason, extra = {}) => ({ allowed: false, reason, ...evidence, ...extra });
  if (detailId && observerId && detailId !== observerId
    && (!detail || !observer || detail[1] !== observer[1] || (detail[2] !== '0' && observer[2] !== '0')))
    return reject('calendar_instance_unverified');
  const required = config.requiredParticipantOpenIds;
  const participantMatch = config.participantMatch === undefined ? 'all' : config.participantMatch;
  if (!Array.isArray(required) || !required.length || !required.every(id => /^ou_[A-Za-z0-9_]+$/.test(id))
    || !['any', 'all'].includes(participantMatch)) return reject('calendar_participation_unconfigured');
  evidence.participantMatch = participantMatch;
  const attended = joinIds(meeting.participants);
  const present = id => attended.has(id);
  if (!(participantMatch === 'any' ? required.some(present) : required.every(present)))
    return reject('calendar_required_attendees_unverified');

  const get = (url, params) => api({ method: 'GET', url, params });
  let stage = 'source_locator';
  try {
    // Registered organizer confirmation is a separate scoped authorization,
    // only a fallback for a denied attendee read, never for a known non-invite.
    const confirmed = /^feishu:om_[A-Za-z0-9]+$/.test(target.confirmedBinding?.sourceRef || '')
      && calendarPattern.test(target.confirmedBinding?.organizerCalendarId || '');
    let calendarId;
    if (/^om_[A-Za-z0-9]+$/.test(target.cardMessageId || '')) {
      const { items } = await get(`/open-apis/im/v1/messages/${target.cardMessageId}`);
      const card = items?.find(item => item.message_id === target.cardMessageId && item.chat_id === target.chatId
        && item.msg_type === 'share_calendar_event' && !item.deleted);
      let body;
      try { if (card) body = JSON.parse(card.body?.content); } catch { /* Unusable provider card. */ }
      if (eventPattern.exec(body?.open_event_id || '')?.[1] !== uid || !calendarPattern.test(body?.open_calendar_id || ''))
        return reject('calendar_source_card_unverified');
      evidence.calendarCardMessageId = target.cardMessageId;
      stage = 'organizer_calendar';
      const { event } = await get(`${calendarPath(body.open_calendar_id)}/${body.open_event_id}`);
      if (event?.event_id !== body.open_event_id || !calendarPattern.test(event.organizer_calendar_id || ''))
        return reject('calendar_organizer_unverified');
      calendarId = event.organizer_calendar_id;
      if (confirmed && calendarId !== target.confirmedBinding.organizerCalendarId)
        return reject('calendar_organizer_unverified');
    } else if (confirmed) calendarId = target.confirmedBinding.organizerCalendarId;
    else return reject('calendar_source_locator_unconfigured');

    stage = 'calendar_occurrence';
    const base = calendarPath(calendarId);
    let { event } = await get(`${base}/${eventId}`);
    if (event?.event_id !== eventId) return reject('calendar_instance_unverified');
    if (eventId.endsWith('_0') && event.recurrence) {
      // A recurring master is not the occurrence. Restrict the view to this
      // meeting's time and reject ambiguity rather than guessing by title/time.
      const start = Number(meeting.start_time);
      const end = Math.floor(endedAt / 1000);
      if (!(start > 0 && end > start && end - start < 86400)) return reject('calendar_instance_unverified');
      const { items } = await get(`${base}/instance_view`, { start_time: String(start), end_time: String(end) });
      const matches = (items || []).filter(item => eventPattern.exec(item.event_id || '')?.[1] === uid
        && !item.event_id.endsWith('_0') && item.status === 'confirmed'
        && Number(item.start_time?.timestamp) < end && Number(item.end_time?.timestamp) > start);
      if (matches.length !== 1) return reject('calendar_instance_unverified');
      const exactId = matches[0].event_id;
      ({ event } = await get(`${base}/${exactId}`));
      if (event?.event_id !== exactId) return reject('calendar_instance_unverified');
    }
    if (event.status !== 'confirmed') return reject('calendar_instance_unverified');
    evidence.calendarInstanceId = event.event_id;

    stage = 'calendar_attendee_list';
    let source = 'calendar_invited_source_group';
    try {
      let pageToken;
      let groupFound = false;
      const seen = new Set();
      do {
        const page = await get(`${base}/${event.event_id}/attendees`, { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) });
        if (!Array.isArray(page.items)) return reject('calendar_invite_list_incomplete');
        groupFound = page.items.some(row => row.type === 'chat' && row.chat_id === target.chatId
          && !row.is_removed && row.rsvp_status !== 'removed');
        if (groupFound || page.has_more === false) break;
        pageToken = page.page_token;
        if (!pageToken || seen.has(pageToken)) return reject('calendar_invite_list_incomplete');
        seen.add(pageToken);
      } while (true);
      if (!groupFound) return reject('calendar_source_group_not_invited');
    } catch (error) {
      if (Number(materialError(error).code) !== 194001) throw error;
      if (!confirmed) return reject('calendar_invite_lookup_denied', { stage, error: materialError(error) });
      evidence.calendarBindingSource = target.confirmedBinding.sourceRef;
      source = 'calendar_confirmed_source_binding';
    }
    stage = 'bot_source_group_membership';
    const member = await get(`/open-apis/im/v1/chats/${target.chatId}/members/is_in_chat`);
    if (member.is_in_chat !== true) return reject('calendar_bot_not_in_source_group');
    return { allowed: true, reason: source, ...evidence, evidence: 'exact_calendar_occurrence_actual_attendance_and_bot_membership' };
  } catch (error) {
    return reject('calendar_source_lookup_failed', { stage, error: materialError(error) });
  }
}

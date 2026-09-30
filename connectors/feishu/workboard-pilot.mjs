const trim = value => typeof value === 'string' ? value.trim() : '';

export function isFeishuWorkboardPilotSession(session, pilot) {
  const conversation = session?.conversation;
  const target = conversation?.target;
  return session?.workboardPilot === true
    && conversation?.connector === 'feishu'
    && conversation?.sourceRouteId === pilot?.sourceRouteId
    && target?.chatType === 'p2p'
    && target?.conversationKind === 'main'
    && target?.chatId === pilot?.chatId;
}

export function collectFeishuWorkboardCycles(events, pilot) {
  const cycles = [];
  let active = null;
  let authorizedUser = false;
  for (const event of Array.isArray(events) ? events : []) {
    if (!Number.isInteger(event?.seq) || event.seq <= pilot.startedAfterSeq) continue;
    if (event.type !== 'message') continue;
    if (event.role === 'user') {
      authorizedUser = trim(event.sourceContext?.sender?.openId) === pilot.senderOpenId;
      if (!authorizedUser) active = null;
      continue;
    }
    if (event.role !== 'assistant') continue;
    if (event.source === 'workboard_checklist') {
      if (!authorizedUser || !trim(event.content)) continue;
      if (!active) {
        active = { anchorSeq: event.seq, latestSeq: event.seq, content: event.content, closed: false };
        cycles.push(active);
      } else {
        active.latestSeq = event.seq;
        active.content = event.content;
      }
      continue;
    }
    if (active) active.closed = true;
    active = null;
  }
  return cycles;
}

export async function publishFeishuWorkboardCycle(cycle, { pilot, app, persist, verifyMessage }) {
  const contentFor = text => JSON.stringify({ text });
  let card = pilot.cards.find(item => item.anchorSeq === cycle.anchorSeq);
  if (!card) {
    // A completed Run that finished before this worker observed it has already
    // sent its result. Never place a late checklist after that result.
    if (cycle.closed) return null;
    const uuid = `rl_wb_${createHash('sha256').update(`${pilot.sessionId}:${cycle.anchorSeq}`).digest('hex').slice(0, 32)}`;
    card = { anchorSeq: cycle.anchorSeq, uuid, messageId: '', pendingCreate: true, latestSeq: 0 };
    pilot.cards.push(card);
    await persist();
    const response = await app.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: pilot.chatId, msg_type: 'text', content: contentFor(cycle.content), uuid },
    });
    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(response?.msg || 'Feishu workboard create failed');
    }
    card.messageId = response.data.message_id;
    card.pendingCreate = false;
    card.latestSeq = cycle.latestSeq;
    await persist();
    await verifyMessage(card.messageId, contentFor(cycle.content));
    return { action: 'created', anchorSeq: card.anchorSeq, revision: card.latestSeq };
  }
  if (!card.messageId) {
    throw new Error(`Feishu workboard create outcome is unknown for anchor ${card.anchorSeq}; inspect before retrying`);
  }
  if (cycle.latestSeq <= card.latestSeq) return null;
  const response = await app.im.v1.message.update({
    path: { message_id: card.messageId },
    data: { msg_type: 'text', content: contentFor(cycle.content) },
  });
  if (response?.code !== 0) throw new Error(response?.msg || 'Feishu workboard update failed');
  await verifyMessage(card.messageId, contentFor(cycle.content));
  card.latestSeq = cycle.latestSeq;
  await persist();
  return { action: 'updated', anchorSeq: card.anchorSeq, revision: card.latestSeq };
}
import { createHash } from 'node:crypto';

import { createHash } from 'node:crypto';

const trim = value => typeof value === 'string' ? value.trim() : '';

export function buildFeishuWorkboardCard(text) {
  const lines = String(text || '').split(/\r?\n/).map(trim).filter(Boolean);
  const goal = lines.find(line => /^目标[：:]/.test(line)) || '目标：完成当前任务并核对结果。';
  const parsedItems = lines.flatMap(line => {
    const match = line.match(/^\[([ xX])\]\s*(.+?)\s+—\s+(.+)$/);
    return match ? [{ done: match[1].toLowerCase() === 'x', title: match[2], condition: match[3] }] : [];
  });
  const completeParse = parsedItems.length > 0 && parsedItems.length <= 5
    && lines.every(line => !/^\[[ xX]\]/.test(line)
      || /^\[([ xX])\]\s*(.+?)\s+—\s+(.+)$/.test(line));
  const items = completeParse ? parsedItems : [];
  const completed = items.filter(item => item.done).length;
  const elements = [
    { tag: 'div', text: { tag: 'plain_text', content: goal } },
    ...(items.length ? [{ tag: 'markdown',
      content: `**${completed}/${items.length} · ${completed === items.length ? '已完成' : '进行中'}**` }] : []),
    ...(items.length ? items.map(item => ({
      tag: 'div', text: { tag: 'plain_text',
        content: `${item.done ? '✓' : '○'} ${item.title} — ${item.condition}` },
    })) : [{ tag: 'div', text: { tag: 'plain_text',
      content: lines.filter(line => line !== goal).join('\n') || trim(text) } }]),
  ];
  return {
    schema: '2.0', config: { update_multi: true },
    header: { template: items.length && completed === items.length ? 'green' : 'blue',
      title: { tag: 'plain_text', content: '交付清单' } },
    body: { elements },
  };
}

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

export function isFeishuWorkboardGroupSession(session, pilot) {
  const conversation = session?.conversation;
  const target = conversation?.target;
  return pilot?.groupEnabled === true
    && session?.workboardPilot === true
    && session?.workboardOptInPersonId === pilot?.personId
    && session?.groupFeed !== true
    && conversation?.connector === 'feishu'
    && conversation?.sourceRouteId === pilot?.sourceRouteId
    && target?.chatType === 'group'
    && ['main', 'thread'].includes(target?.conversationKind)
    && Boolean(trim(target?.chatId));
}

export function collectFeishuGroupWorkboardCycles(events, pilot, session) {
  if (!isFeishuWorkboardGroupSession(session, pilot)) return [];
  const target = session.conversation.target;
  const authorizedRuns = new Map();
  const cycles = [];
  const active = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!Number.isInteger(event?.seq) || event.seq <= (pilot.startedAfterSeq || 0)
        || event.type !== 'message' || !trim(event.runId)) continue;
    if (event.role === 'user') {
      const source = event.sourceContext;
      if (trim(source?.sender?.openId) === pilot.senderOpenId
          && source?.connector === 'feishu'
          && source?.chatType === 'group'
          && source?.chatId === target.chatId
          && source?.sourceRouteId === pilot.sourceRouteId
          && (!trim(target.tenantKey) || source?.tenantKey === target.tenantKey)
          && trim(source?.messageId)) {
        authorizedRuns.set(event.runId, source.messageId);
      } else {
        authorizedRuns.delete(event.runId);
      }
      continue;
    }
    if (event.role !== 'assistant' || !authorizedRuns.has(event.runId)) continue;
    if (event.source === 'workboard_checklist' && trim(event.content)) {
      const prior = active.get(event.runId);
      if (prior) {
        prior.latestSeq = event.seq;
        prior.content = event.content;
      } else {
        const cycle = { anchorSeq: event.seq, latestSeq: event.seq,
          content: event.content, closed: false,
          ...(target.conversationKind === 'thread'
            ? { replyMessageId: authorizedRuns.get(event.runId) } : {}) };
        cycles.push(cycle);
        active.set(event.runId, cycle);
      }
    } else if (active.has(event.runId)) {
      active.get(event.runId).closed = true;
      active.delete(event.runId);
    }
  }
  return cycles;
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
  const contentFor = text => JSON.stringify(buildFeishuWorkboardCard(text));
  let card = pilot.cards.find(item => item.anchorSeq === cycle.anchorSeq);
  if (!card) {
    // A completed Run that finished before this worker observed it has already
    // sent its result. Never place a late checklist after that result.
    if (cycle.closed) return null;
    const uuid = `rl_wb_${createHash('sha256').update(`${pilot.sessionId}:${cycle.anchorSeq}`).digest('hex').slice(0, 32)}`;
    card = { anchorSeq: cycle.anchorSeq, uuid, messageId: '', pendingCreate: true, latestSeq: 0 };
    pilot.cards.push(card);
    await persist();
    const response = cycle.replyMessageId
      ? await app.im.v1.message.reply({
        path: { message_id: cycle.replyMessageId },
        data: { msg_type: 'interactive', content: contentFor(cycle.content), reply_in_thread: true, uuid },
      })
      : await app.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: pilot.chatId, msg_type: 'interactive', content: contentFor(cycle.content), uuid },
      });
    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(response?.msg || 'Feishu workboard create failed');
    }
    card.messageId = response.data.message_id;
    card.pendingCreate = false;
    card.latestSeq = cycle.latestSeq;
    await persist();
    await verifyMessage(card.messageId, { updated: false });
    return { action: 'created', anchorSeq: card.anchorSeq, revision: card.latestSeq };
  }
  if (!card.messageId) {
    throw new Error(`Feishu workboard create outcome is unknown for anchor ${card.anchorSeq}; inspect before retrying`);
  }
  if (cycle.latestSeq <= card.latestSeq) return null;
  const response = await app.im.v1.message.patch({
    path: { message_id: card.messageId },
    data: { content: contentFor(cycle.content) },
  });
  if (response?.code !== 0) throw new Error(response?.msg || 'Feishu workboard update failed');
  await verifyMessage(card.messageId, { updated: true });
  card.latestSeq = cycle.latestSeq;
  await persist();
  return { action: 'updated', anchorSeq: card.anchorSeq, revision: card.latestSeq };
}

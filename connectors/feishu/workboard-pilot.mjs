import { createHash } from 'node:crypto';
import { projectWorkboards, workboardStatusLabel } from '../../lib/workboard-state.mjs';
import { parseProgressMessage } from '../../lib/assistant-surface-messages.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';

export function buildFeishuWorkboardCard(text, board = null, progress = null) {
  const lines = String(text || '').split(/\r?\n/).map(trim).filter(Boolean);
  const goal = lines.find(line => /^目标[：:]/.test(line)) || '目标：完成当前任务并核对结果。';
  const parsedItems = lines.flatMap(line => {
    const match = line.match(/^\[([ xX])\]\s*(.+?)\s+—\s+(.+)$/);
    return match ? [{ done: match[1].toLowerCase() === 'x', title: match[2], condition: match[3] }] : [];
  });
  const completeParse = parsedItems.length > 0 && parsedItems.length <= 5
    && lines.every(line => !/^\[[ xX]\]/.test(line)
      || /^\[([ xX])\]\s*(.+?)\s+—\s+(.+)$/.test(line));
  const items = board ? board.items.map(item => ({ ...item, done: item.status === 'done' })) : completeParse ? parsedItems : [];
  const completed = items.filter(item => item.done).length;
  const elements = [
    ...(items.length ? [{ tag: 'markdown',
      content: `**${completed}/${items.length} · ${board ? workboardStatusLabel(board) : completed === items.length ? '已完成' : '进行中'}**` }] : []),
    ...(items.length ? items.map(item => ({
      tag: 'div', text: { tag: 'plain_text',
        content: `${item.done ? '✓' : '○'} ${item.title} — ${item.condition}` },
    })) : [{ tag: 'div', text: { tag: 'plain_text',
      content: lines.filter(line => line !== goal).join('\n') || trim(text) } }]),
    { tag: 'hr' },
    { tag: 'markdown', content: '**目前进展**' },
    { tag: 'markdown', content: progress?.content || '暂无进度更新' },
  ];
  return {
    schema: '2.0', config: { update_multi: true },
    header: { template: (board ? board.status === 'completed' : items.length && completed === items.length) ? 'green' : 'blue',
      title: { tag: 'plain_text', content: board?.goal || goal.replace(/^目标[：:]\s*/, '') } },
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

function collectAuthorizedCycles(events, pilot, session = null) {
  const allowed = new Map();
  const localRuns = new Set();
  const authorizedTasks = new Set();
  const target = session?.conversation?.target;
  let authorizedUser = false;
  const history = [];
  for (const event of events || []) {
    if (!Number.isInteger(event.seq) || event.seq <= (pilot.startedAfterSeq || 0)) continue;
    if (event.type === 'message' && event.role === 'user') {
      const source = event.sourceContext;
      if (!source && event.runId) localRuns.add(event.runId);
      authorizedUser = trim(source?.sender?.openId) === pilot.senderOpenId
        && (!target || (source?.connector === 'feishu' && source.chatType === 'group'
          && source.chatId === target.chatId && source.sourceRouteId === pilot.sourceRouteId
          && (!trim(target.tenantKey) || source.tenantKey === target.tenantKey)));
      if (event.runId) {
        if (authorizedUser) allowed.set(event.runId, source?.messageId || '');
        else allowed.delete(event.runId);
      }
      history.push(event);
    } else if (event.source !== 'workboard_checklist') {
      // Progress has the same sender boundary as the task card. Unrelated
      // group Runs must not update an opted-in Person's existing card.
      const progress = event.type === 'message' && event.role === 'assistant'
        && !['final', 'final_answer'].includes(event.phase) && parseProgressMessage(event.content).progress;
      if (!progress || (event.runId ? allowed.has(event.runId) || localRuns.has(event.runId) : authorizedUser)) history.push(event);
    }
    else {
      const ownSource = event.runId ? allowed.has(event.runId) : authorizedUser;
      // A Session owner can resume an existing explicitly identified task from
      // the local Session surface. This never creates a new opt-in task, and
      // does not grant other Feishu senders access through the same Run.
      const taskId = event.workboard?.taskId || (event.runId ? `wb_${event.runId}` : `wb_seq_${event.seq}`);
      if (ownSource || (event.workboard && localRuns.has(event.runId) && authorizedTasks.has(taskId))) {
        history.push(event);
        authorizedTasks.add(taskId);
      }
    }
  }
  return projectWorkboards(history).map(task => {
    const anchor = history.find(event => event.seq === task.anchorSeq);
    const final = history.some(event => event.type === 'message' && event.role === 'assistant'
      && ['final', 'final_answer'].includes(event.phase)
      && (anchor.runId ? event.runId === anchor.runId : event.seq > task.latestSeq));
    return { ...task, closed: final,
      ...(target?.conversationKind === 'thread' ? { replyMessageId: allowed.get(anchor.runId) } : {}) };
  });
}
export function collectFeishuGroupWorkboardCycles(events, pilot, session) {
  return isFeishuWorkboardGroupSession(session, pilot) ? collectAuthorizedCycles(events, pilot, session) : [];
}
export function collectFeishuWorkboardCycles(events, pilot) {
  return collectAuthorizedCycles(events, pilot);
}
// Replay each verified checkpoint rather than collapsing a burst to all-done.
export function expandFeishuWorkboardUpdates(cycles) {
  return cycles.flatMap(cycle => cycle.updates.map(update => ({ ...cycle,
    latestSeq: update.seq, content: update.content, board: update.workboard, progress: update.progress })));
}

export async function publishFeishuWorkboardCycle(cycle, { pilot, app, persist, verifyMessage }) {
  const content = JSON.stringify(buildFeishuWorkboardCard(cycle.content, cycle.board, cycle.progress));
  const contentHash = createHash('sha256').update(content).digest('hex');
  let card = pilot.cards.find(item => item.anchorSeq === cycle.anchorSeq)
    || pilot.cards.find(item => cycle.taskId && item.taskId === cycle.taskId);
  if (cycle.latestSeq <= (pilot.protocolAfterSeq || 0)) return null;
  if (!card) {
    // A completed Run that finished before this worker observed it has already
    // sent its result. Never place a late checklist after that result.
    if (cycle.closed && (!cycle.board || cycle.board.legacy)) return null;
    const uuid = `rl_wb_${createHash('sha256').update(`${pilot.sessionId}:${cycle.anchorSeq}`).digest('hex').slice(0, 32)}`;
    card = { taskId: cycle.taskId, anchorSeq: cycle.anchorSeq, uuid, messageId: '', pendingCreate: true, latestSeq: 0 };
    pilot.cards.push(card);
    await persist();
    const response = cycle.replyMessageId
      ? await app.im.v1.message.reply({
        path: { message_id: cycle.replyMessageId },
        data: { msg_type: 'interactive', content, reply_in_thread: true, uuid },
      })
      : await app.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: pilot.chatId, msg_type: 'interactive', content, uuid },
      });
    if (response?.code !== 0 || !response.data?.message_id) {
      throw new Error(response?.msg || 'Feishu workboard create failed');
    }
    card.messageId = response.data.message_id;
    card.pendingCreate = false;
    await persist();
    await verifyMessage(card.messageId, { updated: false });
    card.latestSeq = cycle.latestSeq;
    card.contentHash = contentHash;
    await persist();
    return { action: 'created', anchorSeq: card.anchorSeq, revision: card.latestSeq };
  }
  if (!card.messageId) {
    throw new Error(`Feishu workboard create outcome is unknown for anchor ${card.anchorSeq}; inspect before retrying`);
  }
  if (cycle.latestSeq < card.latestSeq || (cycle.latestSeq === card.latestSeq && card.contentHash === contentHash)) return null;
  // A renderer upgrade may change the same acknowledged snapshot. Patch its
  // existing message once, then persist the hash so restart cannot repeat it.
  const response = await app.im.v1.message.patch({
    path: { message_id: card.messageId },
    data: { content },
  });
  if (response?.code !== 0) throw new Error(response?.msg || 'Feishu workboard update failed');
  await verifyMessage(card.messageId, { updated: true });
  card.latestSeq = cycle.latestSeq;
  card.taskId = cycle.taskId;
  card.contentHash = contentHash;
  await persist();
  return { action: 'updated', anchorSeq: card.anchorSeq, revision: card.latestSeq };
}

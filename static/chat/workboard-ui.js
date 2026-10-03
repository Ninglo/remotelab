"use strict";

let sessionWorkboardSession = null;
let sessionWorkboardEvents = [];
let sessionWorkboardRun = null;
let sessionWorkboardRunRequest = null;
let sessionWorkboardStallTimer = null;
const SESSION_WORKBOARD_STALL_MS = 5 * 60 * 1000;

function isSessionWorkboardMessage(event) {
  return sessionWorkboardSession?.workboardPilot === true
    && sessionWorkboardSession.id === currentSessionId
    && event?.type === "message" && event.role === "assistant"
    && (event.messageKind === "todo_list" || event.source === "workboard_checklist");
}

function parseSessionChecklistContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  const taskTitle = lines.find(line => /^\s*(?:目标|任务)[：:]\s*\S/.test(line))
    ?.replace(/^\s*(?:目标|任务)[：:]\s*/, "").trim() || "";
  const description = lines.find(line => /^\s*说明[：:]\s*\S/.test(line))?.replace(/^\s*说明[：:]\s*/, "").trim() || "";
  const items = lines.map(line => {
    const match = /^\s*(?:[-*]\s*)?\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    const parts = /^(.+?)\s+—\s+(.+)$/.exec(match[2]);
    return {
      done: match[1].toLowerCase() === "x",
      title: parts ? parts[1].trim() : match[2],
      detail: parts ? parts[2].trim() : "",
    };
  }).filter(Boolean);
  return { taskTitle, description, items };
}

function sessionWorkboardSnapshotInfo(events) {
  const latestUserSeq = [...events].reverse().find(event => event?.type === "message" && event.role === "user")?.seq || 0;
  const updateSeq = events.filter(isSessionWorkboardMessage).reduce((seq, event) =>
    Math.max(seq, event.workboardUpdateSeq || event.seq || 0), 0);
  return { latestUserSeq, updateSeq };
}

function projectSessionWorkboardTranscriptEvents(sessionId, events) {
  if (sessionWorkboardSession?.id !== sessionId || sessionWorkboardSession.workboardPilot !== true) return events;
  if (events.some(event => event.workboard)) {
    // The server already projects task identities, outcomes and revisions.
    return events.filter(event => event.messageKind !== "todo_list").map(event => event.workboard
      ? { ...event, workboardCurrentTurn: event.workboardLastRunId === (sessionWorkboardRun?.id || sessionWorkboardSession?.activeRunId) }
      : event);
  }
  const projected = [];
  let turn = [];
  const flushTurn = () => {
    if (!turn.length) return;
    const updates = turn.filter(isSessionWorkboardMessage);
    if (!updates.length) {
      projected.push(...turn);
      turn = [];
      return;
    }
    const first = updates[0];
    const latest = updates[updates.length - 1];
    const thinkingBlocks = turn.filter(event => event?.type === "thinking_block");
    const firstThinking = thinkingBlocks[0];
    const lastThinking = thinkingBlocks[thinkingBlocks.length - 1];
    const mergedThinking = firstThinking ? {
      ...firstThinking,
      blockStartSeq: firstThinking.blockStartSeq || firstThinking.seq,
      blockEndSeq: lastThinking.blockEndSeq || lastThinking.seq,
      state: lastThinking.state || firstThinking.state,
      label: lastThinking.label || firstThinking.label,
      hiddenEventCount: thinkingBlocks.reduce((total, block) => total + (block.hiddenEventCount || 0), 0),
      toolNames: [...new Set(thinkingBlocks.flatMap(block => block.toolNames || []))],
    } : null;
    const boundary = turn.reduce((max, event) => Math.max(
      max, event.displayBoundarySeq || event.blockEndSeq || event.workboardUpdateSeq || event.seq || 0,
    ), 0);
    let inserted = false;
    let insertedThinking = false;
    for (const event of turn) {
      // Raw revisions stay in Session history; one disclosure retains the full thinking range.
      if (event.type === "thinking_block") {
        if (!insertedThinking) projected.push(mergedThinking);
        insertedThinking = true;
        continue;
      }
      if (isSessionWorkboardMessage(event)) {
        if (!inserted) {
          projected.push({
            ...latest,
            seq: first.seq,
            workboardUpdateSeq: latest.workboardUpdateSeq || latest.seq,
            workboardCurrentTurn: false,
          });
          inserted = true;
        }
        continue;
      }
      projected.push(event);
    }
    const lastIndex = projected.length - 1;
    projected[lastIndex] = { ...projected[lastIndex], displayBoundarySeq: boundary };
    turn = [];
  };
  for (const event of events) {
    if (event?.type === "message" && event.role === "user") flushTurn();
    turn.push(event);
  }
  flushTurn();
  // A steering message starts a new Run, but may continue the same unfinished task.
  // Keep its revisions on the original checklist until a normal result closes it.
  const transcript = [];
  let activeChecklistIndex = -1;
  for (const event of projected) {
    if (isSessionWorkboardMessage(event)) {
      if (activeChecklistIndex >= 0) {
        const previous = transcript[activeChecklistIndex];
        transcript[activeChecklistIndex] = {
          ...event,
          seq: previous.seq,
          workboardUpdateSeq: event.workboardUpdateSeq || event.seq,
        };
      } else {
        activeChecklistIndex = transcript.length;
        transcript.push(event);
      }
      continue;
    }
    transcript.push(event);
    if (event?.type === "message" && event.role === "assistant") activeChecklistIndex = -1;
  }
  if (activeChecklistIndex >= 0) transcript[activeChecklistIndex].workboardCurrentTurn = true;
  return transcript;
}

function sessionWorkboardRunLabel() {
  const session = sessionWorkboardSession;
  if (session?.workState?.workflow?.state === "waiting_user") return "需要你处理";
  const activity = session && typeof getSessionActivity === "function" ? getSessionActivity(session) : null;
  if (activity?.run?.state === "running") {
    if (activity.run.cancelRequested) return "正在停止";
    const eventAt = typeof session.lastEventAt === "number" ? session.lastEventAt : Date.parse(session.lastEventAt || "") || 0;
    const lastProgressAt = Math.max(eventAt, Date.parse(activity.run.startedAt || "") || 0);
    return lastProgressAt && Date.now() - lastProgressAt >= SESSION_WORKBOARD_STALL_MS ? "疑似停滞" : "运行中";
  }
  const state = sessionWorkboardRun?.state || activity?.run?.state;
  return ({
    completed: "运行完成", failed: "运行失败",
    cancelled: "已取消", canceled: "已取消",
    "状态不可读": "状态不可读",
  })[state] || "执行已结束";
}

function syncSessionWorkboardRunLabel() {
  const badges = document.querySelectorAll?.('.session-workboard-inline[data-current-turn="true"] .session-workboard-run-state') || [];
  for (const badge of badges) if (!badge.dataset.taskState) badge.textContent = sessionWorkboardRunLabel();
}

function scheduleSessionWorkboardStallCheck() {
  if (sessionWorkboardStallTimer) clearTimeout(sessionWorkboardStallTimer);
  sessionWorkboardStallTimer = null;
  const session = sessionWorkboardSession;
  if (!session?.workboardPilot || session.id !== currentSessionId) return;
  const activity = getSessionActivity(session);
  if (activity.run.state !== "running") return;
  const eventAt = typeof session.lastEventAt === "number" ? session.lastEventAt : Date.parse(session.lastEventAt || "") || 0;
  const lastProgressAt = Math.max(eventAt, Date.parse(activity.run.startedAt || "") || 0);
  const remaining = lastProgressAt + SESSION_WORKBOARD_STALL_MS - Date.now();
  if (!lastProgressAt || remaining <= 0) return;
  sessionWorkboardStallTimer = setTimeout(() => {
    sessionWorkboardStallTimer = null;
    syncSessionWorkboardRunLabel();
  }, remaining);
}

function refreshSessionWorkboardRun() {
  const session = sessionWorkboardSession;
  if (!session?.workboardPilot || session.id !== currentSessionId) return;
  const runId = [...sessionWorkboardEvents].reverse()
    .find(event => event?.type === "message" && event.role === "user")?.runId;
  if (!runId || getSessionActivity(session).run.state === "running") return;
  if (sessionWorkboardRun?.id === runId && sessionWorkboardRun.state !== "running") return;
  if (sessionWorkboardRunRequest?.runId === runId) return;
  const request = fetchJsonOrRedirect("/api/runs/" + encodeURIComponent(runId))
    .then(data => {
      if (sessionWorkboardSession?.id !== session.id) return;
      sessionWorkboardRun = data?.run || null;
      syncSessionWorkboardRunLabel();
    })
    .catch(() => {
      if (sessionWorkboardSession?.id !== session.id) return;
      sessionWorkboardRun = { id: runId, state: "状态不可读" };
      syncSessionWorkboardRunLabel();
    })
    .finally(() => { if (sessionWorkboardRunRequest?.promise === request) sessionWorkboardRunRequest = null; });
  sessionWorkboardRunRequest = { runId, promise: request };
}

function updateSessionWorkboardSession(session) {
  if (sessionWorkboardSession?.id !== session?.id) {
    sessionWorkboardEvents = [];
    sessionWorkboardRun = null;
    sessionWorkboardRunRequest = null;
  }
  sessionWorkboardSession = session;
  syncSessionWorkboardRunLabel();
  scheduleSessionWorkboardStallCheck();
  refreshSessionWorkboardRun();
}

function updateSessionWorkboardEvents(sessionId, events) {
  if (sessionWorkboardSession?.id !== sessionId || sessionWorkboardSession.workboardPilot !== true) return events;
  const nextEvents = Array.isArray(events) ? events : [];
  const previous = sessionWorkboardSnapshotInfo(sessionWorkboardEvents);
  const next = sessionWorkboardSnapshotInfo(nextEvents);
  if (next.latestUserSeq < previous.latestUserSeq
    || (next.latestUserSeq === previous.latestUserSeq && next.updateSeq < previous.updateSeq)) return sessionWorkboardEvents;
  sessionWorkboardEvents = nextEvents;
  scheduleSessionWorkboardStallCheck();
  refreshSessionWorkboardRun();
  return nextEvents;
}

function renderSessionWorkboardMessage(container, event) {
  const { taskTitle, description, items } = event.workboard ? {
    taskTitle: event.workboard.goal, description: event.workboard.reason,
    items: event.workboard.items.map(item => ({ ...item, done: item.status === "done", detail: item.condition })),
  } : parseSessionChecklistContent(event.content);
  const card = document.createElement("section");
  card.className = "session-workboard-inline";
  card.setAttribute("aria-label", "任务进度");
  if (event.workboard?.taskId) card.dataset.taskId = event.workboard.taskId;
  card.dataset.anchorSeq = String(event.seq || 0);
  if (event.workboardCurrentTurn) card.dataset.currentTurn = "true";

  const heading = document.createElement("div");
  heading.className = "session-workboard-heading";
  const title = document.createElement("strong");
  title.textContent = "目标：" + (taskTitle || "交付清单");
  heading.appendChild(title);
  const count = document.createElement("span");
  count.className = "session-workboard-count";
  count.textContent = items.filter(item => item.done).length + "/" + items.length;
  heading.appendChild(count);
  card.appendChild(heading);

  if (description) {
    const explanation = document.createElement("p");
    explanation.className = "session-workboard-description";
    explanation.textContent = "说明：" + description;
    card.appendChild(explanation);
  }
  const list = document.createElement("ul");
  list.className = "session-workboard-list";
  for (const item of items) {
    const row = document.createElement("li");
    row.className = item.done ? "done" : "";
    const state = document.createElement("span");
    state.className = "session-workboard-item-state";
    state.textContent = item.done ? "✓" : "○";
    row.appendChild(state);
    const copy = document.createElement("span");
    copy.className = "session-workboard-item-copy";
    const itemTitle = document.createElement("strong");
    itemTitle.textContent = item.title;
    copy.appendChild(itemTitle);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = "session-workboard-item-detail";
      detail.textContent = " — " + item.detail;
      copy.appendChild(detail);
    }
    row.appendChild(copy);
    list.appendChild(row);
  }
  card.appendChild(list);
  const progress = document.createElement("section");
  progress.className = "session-workboard-progress";
  progress.setAttribute("aria-label", "目前进展");
  const progressTitle = document.createElement("strong");
  progressTitle.textContent = "目前进展";
  progress.appendChild(progressTitle);
  const current = document.createElement("div");
  current.className = "session-workboard-progress-current md-content";
  current.setAttribute("aria-live", "polite");
  const content = event.workboardProgress?.content || "暂无进度更新";
  if (typeof renderMarkdownIntoNode === "function") renderMarkdownIntoNode(current, content);
  else current.textContent = content;
  progress.appendChild(current);
  const previousProgress = (event.workboardProgressHistory || []).filter(update =>
    event.workboardProgress?.derivedFromOutcome || update.seq !== event.workboardProgress?.seq);
  if (previousProgress.length) {
    const history = document.createElement("details");
    history.className = "session-workboard-progress-history";
    const summary = document.createElement("summary");
    summary.textContent = "之前的进展（" + previousProgress.length + "）";
    history.appendChild(summary);
    for (const update of previousProgress) {
      const entry = document.createElement("div");
      entry.className = "md-content";
      if (typeof renderMarkdownIntoNode === "function") renderMarkdownIntoNode(entry, update.content);
      else entry.textContent = update.content;
      history.appendChild(entry);
    }
    progress.appendChild(history);
  }
  card.appendChild(progress);
  if (event.workboard || event.workboardCurrentTurn) {
    const status = document.createElement("div");
    status.className = "session-workboard-run-state";
    if (event.workboard) status.dataset.taskState = event.workboard.status;
    status.textContent = event.workboardStatusLabel || sessionWorkboardRunLabel();
    card.appendChild(status);
  }
  container.appendChild(card);
  return card;
}

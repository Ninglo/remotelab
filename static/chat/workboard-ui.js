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
  const taskTitle = lines.find(line => /^\s*任务[：:]\s*\S/.test(line))?.replace(/^\s*任务[：:]\s*/, "").trim() || "";
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
  const latest = [...events].reverse().find(isSessionWorkboardMessage);
  return { latestUserSeq, updateSeq: latest?.workboardUpdateSeq || latest?.seq || 0 };
}

function projectSessionWorkboardTranscriptEvents(sessionId, events) {
  if (sessionWorkboardSession?.id !== sessionId || sessionWorkboardSession.workboardPilot !== true) return events;
  const latestUserSeq = [...events].reverse().find(event => event?.type === "message" && event.role === "user")?.seq || 0;
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
    const boundary = turn.reduce((max, event) => Math.max(max, event.blockEndSeq || event.seq || 0), 0);
    let inserted = false;
    for (const event of turn) {
      // Raw revisions and thinking remain in Session history.
      if (event.type === "thinking_block") continue;
      if (isSessionWorkboardMessage(event)) {
        if (!inserted) {
          projected.push({
            ...latest,
            seq: first.seq,
            workboardUpdateSeq: latest.workboardUpdateSeq || latest.seq,
            workboardCurrentTurn: first.seq > latestUserSeq,
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
  return projected;
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
  for (const badge of badges) badge.textContent = sessionWorkboardRunLabel();
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
  const { taskTitle, description, items } = parseSessionChecklistContent(event.content);
  const card = document.createElement("section");
  card.className = "session-workboard-inline";
  card.setAttribute("aria-label", "交付清单");
  if (event.workboardCurrentTurn) card.dataset.currentTurn = "true";

  const heading = document.createElement("div");
  heading.className = "session-workboard-heading";
  const title = document.createElement("strong");
  title.textContent = "任务：" + (taskTitle || "交付清单");
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
  if (event.workboardCurrentTurn) {
    const status = document.createElement("div");
    status.className = "session-workboard-run-state";
    status.textContent = sessionWorkboardRunLabel();
    card.appendChild(status);
  }
  container.appendChild(card);
  return card;
}

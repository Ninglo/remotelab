"use strict";

const sessionWorkboardPanel = document.getElementById("sessionWorkboardPanel");
let sessionWorkboardSession = null;
let sessionWorkboardEvents = [];
let sessionWorkboardRun = null;
let sessionWorkboardRunRequest = null;
let sessionWorkboardStallTimer = null;
const SESSION_WORKBOARD_STALL_MS = 5 * 60 * 1000;

function isSessionWorkboardMessage(event) {
  if (sessionWorkboardSession?.workboardPilot !== true
    || sessionWorkboardSession.id !== currentSessionId
    || event?.type !== "message" || event.role !== "assistant"
    || (event.messageKind !== "todo_list" && event.source !== "workboard_checklist")) return false;
  const latestUserSeq = parseSessionChecklist(sessionWorkboardEvents).latestUserSeq;
  if (event.seq > latestUserSeq) return true;
  const index = sessionWorkboardEvents.findIndex(item => item?.seq === event.seq
    && item.type === "message" && item.role === "assistant");
  if (index < 0) return false;
  for (const next of sessionWorkboardEvents.slice(index + 1)) {
    if (next?.type === "message" && next.role === "user") break;
    if (next?.type === "message" && next.role === "assistant"
      && (next.messageKind === "todo_list" || next.source === "workboard_checklist")) return true;
  }
  return false;
}

function sessionWorkboardLastProgressAt(session, activity) {
  const eventAt = typeof session?.lastEventAt === "number" && Number.isFinite(session.lastEventAt)
    ? session.lastEventAt : Date.parse(session?.lastEventAt || "") || 0;
  return Math.max(
    eventAt,
    Date.parse(activity?.run?.startedAt || "") || 0,
  );
}

function scheduleSessionWorkboardStallCheck() {
  if (sessionWorkboardStallTimer) clearTimeout(sessionWorkboardStallTimer);
  sessionWorkboardStallTimer = null;
  const session = sessionWorkboardSession;
  if (!session?.workboardPilot || session.id !== currentSessionId) return;
  const activity = getSessionActivity(session);
  if (activity.run.state !== "running") return;
  const lastProgressAt = sessionWorkboardLastProgressAt(session, activity);
  if (!lastProgressAt) return;
  const remaining = lastProgressAt + SESSION_WORKBOARD_STALL_MS - Date.now();
  if (remaining <= 0) return;
  sessionWorkboardStallTimer = setTimeout(() => {
    sessionWorkboardStallTimer = null;
    renderSessionWorkboard();
  }, remaining);
}

function parseSessionChecklist(events) {
  const latestUserSeq = [...events].reverse().find(event => event?.type === "message" && event.role === "user")?.seq || 0;
  const latest = [...events].reverse().find(event => event?.seq > latestUserSeq
    && event?.type === "message" && event.role === "assistant"
    && (event.messageKind === "todo_list" || event.source === "workboard_checklist"));
  const lines = String(latest?.content || "").split(/\r?\n/);
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
  return {
    items, taskTitle, description, latestUserSeq,
    updateSeq: latest?.workboardUpdateSeq || latest?.seq || 0,
    runId: [...events].reverse().find(event => event?.type === "message" && event.role === "user")?.runId || "",
  };
}

function renderSessionWorkboard() {
  const panel = sessionWorkboardPanel;
  const session = sessionWorkboardSession;
  if (!panel) return;
  if (!session?.workboardPilot || session.id !== currentSessionId) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const activity = getSessionActivity(session);
  const { items, taskTitle, description, runId } = parseSessionChecklist(sessionWorkboardEvents);
  const gate = session.workboardGate;
  const hasGate = gate?.needsChecklist === true;
  const active = activity.run.state === "running";
  const waitingUser = session.workState?.workflow?.state === "waiting_user";
  const lastProgressAt = sessionWorkboardLastProgressAt(session, activity);
  const stalled = active && lastProgressAt > 0 && Date.now() - lastProgressAt >= SESSION_WORKBOARD_STALL_MS;
  if (!items.length && !hasGate && !active && !waitingUser && !sessionWorkboardRun) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  panel.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "session-workboard-heading";
  heading.textContent = taskTitle || "交付清单与监视器";
  panel.appendChild(heading);

  if (description) {
    const explanation = document.createElement("p");
    explanation.className = "session-workboard-description";
    explanation.textContent = description;
    panel.appendChild(explanation);
  }

  if (items.length || hasGate) {
    const listHeading = document.createElement("div");
    listHeading.className = "session-workboard-label";
    listHeading.textContent = `清单${items.length ? ` · ${items.filter(item => item.done).length}/${items.length}` : ""}`;
    panel.appendChild(listHeading);
    if (items.length) {
      const progress = document.createElement("progress");
      progress.max = items.length;
      progress.value = items.filter(item => item.done).length;
      progress.setAttribute("aria-label", "交付清单完成进度");
      panel.appendChild(progress);
      const list = document.createElement("ul");
      list.className = "session-workboard-list";
      for (const item of items) {
        const row = document.createElement("li");
        row.className = item.done ? "done" : "";
        const state = document.createElement("span");
        state.className = "session-workboard-item-state";
        state.textContent = item.done ? "✓" : "○";
        row.appendChild(state);
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item.title;
        copy.appendChild(title);
        if (item.detail) {
          const detail = document.createElement("p");
          detail.className = "session-workboard-item-detail";
          detail.textContent = item.detail;
          copy.appendChild(detail);
        }
        row.appendChild(copy);
        list.appendChild(row);
      }
      panel.appendChild(list);
    } else {
      const pending = document.createElement("div");
      pending.className = "session-workboard-pending";
      pending.textContent = active ? "Jev 已判断需要清单，等待 Harness 发布。" : "Jev 已判断需要清单；本轮尚未发布。";
      panel.appendChild(pending);
    }
  }

  if (runId || activity.run.runId || waitingUser) {
    const monitoredRunId = activity.run.runId || runId;
    const runState = waitingUser ? "需要你处理" : active ? (activity.run.cancelRequested ? "正在停止" : stalled ? "疑似停滞（5 分钟无新事件）" : "运行中")
      : sessionWorkboardRun?.id === monitoredRunId
        ? ({ completed: "已完成", failed: "失败", cancelled: "已取消", canceled: "已取消" }[sessionWorkboardRun.state] || sessionWorkboardRun.state)
        : "读取中";
    const monitor = document.createElement("div");
    monitor.className = "session-workboard-monitor";
    const label = document.createElement("span");
    label.textContent = `监视器 · ${runState} · `;
    monitor.appendChild(label);
    if (monitoredRunId) {
      const link = document.createElement("a");
      link.href = `/api/runs/${encodeURIComponent(monitoredRunId)}`;
      link.textContent = monitoredRunId.slice(0, 8);
      link.title = "查看原始 Run 状态";
      link.target = "_blank";
      link.rel = "noopener";
      monitor.appendChild(link);
    }
    if (active && !activity.run.cancelRequested) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "停止";
      stop.addEventListener("click", () => cancelBtn?.click());
      monitor.appendChild(stop);
    }
    if (sessionWorkboardRun?.id === monitoredRunId && sessionWorkboardRun.state === "状态不可读") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试";
      retry.addEventListener("click", () => {
        sessionWorkboardRun = null;
        renderSessionWorkboard();
        refreshSessionWorkboardRun();
      });
      monitor.appendChild(retry);
    }
    panel.appendChild(monitor);
  }
}

function refreshSessionWorkboardRun() {
  const session = sessionWorkboardSession;
  if (!session?.workboardPilot || session.id !== currentSessionId) return;
  const { runId } = parseSessionChecklist(sessionWorkboardEvents);
  if (!runId || getSessionActivity(session).run.state === "running") return;
  if (sessionWorkboardRun?.id === runId && sessionWorkboardRun.state !== "running") return;
  if (sessionWorkboardRunRequest?.runId === runId) return;
  const request = fetchJsonOrRedirect(`/api/runs/${encodeURIComponent(runId)}`)
    .then(data => {
      if (sessionWorkboardSession?.id !== session.id) return;
      sessionWorkboardRun = data?.run || null;
      renderSessionWorkboard();
    })
    .catch(() => {
      if (sessionWorkboardSession?.id !== session.id) return;
      sessionWorkboardRun = { id: runId, state: "状态不可读" };
      renderSessionWorkboard();
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
  renderSessionWorkboard();
  scheduleSessionWorkboardStallCheck();
  refreshSessionWorkboardRun();
}

function updateSessionWorkboardEvents(sessionId, events) {
  if (sessionWorkboardSession?.id !== sessionId) return;
  const nextEvents = Array.isArray(events) ? events : [];
  const previous = parseSessionChecklist(sessionWorkboardEvents);
  const next = parseSessionChecklist(nextEvents);
  if (next.latestUserSeq < previous.latestUserSeq
    || (next.latestUserSeq === previous.latestUserSeq && next.updateSeq < previous.updateSeq)) return;
  sessionWorkboardEvents = nextEvents;
  renderSessionWorkboard();
  scheduleSessionWorkboardStallCheck();
  refreshSessionWorkboardRun();
}

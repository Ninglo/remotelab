"use strict";

(function attachRemoteLabSessionStateModel(root) {
  const fallbackStrings = {
    "status.idle": "idle",
    "status.running": "running",
    "workflow.priority.high": "High",
    "workflow.priority.highTitle": "Needs user attention soon.",
    "workflow.priority.medium": "Medium",
    "workflow.priority.mediumTitle": "Worth checking soon, but not urgent.",
    "workflow.priority.low": "Low",
    "workflow.priority.lowTitle": "Safe to leave for later.",
    "workflow.status.waiting": "needs user",
    "workflow.status.waitingTitle": "Blocked on user input",
    "workflow.status.done": "done",
    "workflow.status.doneTitle": "Current task complete",
    "workflow.status.parked": "parked",
    "workflow.status.parkedTitle": "Parked for later",
    "workflow.status.queued": "queued",
    "workflow.status.queuedTitle": "{count} follow-up{suffix} queued",
    "workflow.status.compacting": "compacting",
    "workflow.status.renaming": "renaming",
    "workflow.status.renameFailed": "rename failed",
    "workflow.status.renameFailedTitle": "Session rename failed",
    "workflow.status.unread": "new",
    "workflow.status.unreadTitle": "Updated since you last reviewed this session",
  };

  function fallbackTranslate(key, vars = {}) {
    const template = fallbackStrings[key];
    if (!template) return key;
    return template.replace(/\{(\w+)\}/g, (match, token) => (
      Object.prototype.hasOwnProperty.call(vars, token) ? String(vars[token]) : match
    ));
  }

  const t = root.remotelabT
    ? (key, vars) => root.remotelabT(key, vars)
    : fallbackTranslate;
  const workflowPrioritySpecs = {
    high: {
      key: "high",
      label: t("workflow.priority.high"),
      rank: 3,
      className: "workflow-priority-high",
      title: t("workflow.priority.highTitle"),
    },
    medium: {
      key: "medium",
      label: t("workflow.priority.medium"),
      rank: 2,
      className: "workflow-priority-medium",
      title: t("workflow.priority.mediumTitle"),
    },
    low: {
      key: "low",
      label: t("workflow.priority.low"),
      rank: 1,
      className: "workflow-priority-low",
      title: t("workflow.priority.lowTitle"),
    },
  };

  const workflowStatusSpecs = {
    waiting_user: {
      key: "waiting_user",
      label: t("workflow.status.waiting"),
      className: "status-waiting-user",
      dotClass: "",
      itemClass: "",
      title: t("workflow.status.waitingTitle"),
    },
    done: {
      key: "done",
      label: t("workflow.status.done"),
      className: "status-done",
      dotClass: "",
      itemClass: "",
      title: t("workflow.status.doneTitle"),
    },
    parked: {
      key: "parked",
      label: t("workflow.status.parked"),
      className: "status-parked",
      dotClass: "",
      itemClass: "",
      title: t("workflow.status.parkedTitle"),
    },
  };

  function createEmptyStatus() {
    return {
      key: "idle",
      label: "",
      className: "",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  function createStatus(key, label, className = "", dotClass = "", itemClass = "", title = "") {
    return {
      key,
      label,
      className,
      dotClass,
      itemClass,
      title,
    };
  }

  function normalizeSessionWorkflowState(value) {
    const normalized = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    if (!normalized) return "";
    if (["waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input"].includes(normalized)) {
      return "waiting_user";
    }
    if (["done", "complete", "completed", "finished"].includes(normalized)) {
      return "done";
    }
    if (["parked", "paused", "pause", "backlog", "todo"].includes(normalized)) {
      return "parked";
    }
    return "";
  }

  function normalizeSessionWorkflowPriority(value) {
    const normalized = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    if (!normalized) return "";
    if (["high", "urgent", "asap", "important", "critical", "top", "top_priority", "p1"].includes(normalized)) {
      return "high";
    }
    if (["medium", "normal", "default", "standard", "soon", "next", "p2"].includes(normalized)) {
      return "medium";
    }
    if (["low", "later", "backlog", "deferred", "eventually", "p3"].includes(normalized)) {
      return "low";
    }
    return "";
  }

  function getWorkflowPriorityInfo(value) {
    const normalized = normalizeSessionWorkflowPriority(value);
    if (!normalized || !workflowPrioritySpecs[normalized]) return null;
    return { ...workflowPrioritySpecs[normalized] };
  }

  function getWorkflowStatusInfo(value) {
    const normalized = normalizeSessionWorkflowState(value);
    if (!normalized || !workflowStatusSpecs[normalized]) return null;
    return { ...workflowStatusSpecs[normalized] };
  }

  function parseSessionTime(value) {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function getSessionLatestChangeTime(session) {
    const stamp = session?.lastEventAt || session?.updatedAt || session?.created || "";
    return parseSessionTime(stamp);
  }

  function getSessionUnreadUpdateTime(session) {
    return parseSessionTime(session?.lastAssistantMessageAt);
  }

  function getSessionReviewTime(session) {
    return Math.max(
      parseSessionTime(session?.lastReviewedAt),
      parseSessionTime(session?.localReviewedAt),
      parseSessionTime(session?.reviewBaselineAt),
    );
  }

  function getSessionSortTime(session) {
    const activity = normalizeSessionActivity(session);
    if (activity.run.state === "running" && activity.run.startedAt) {
      const startedAt = parseSessionTime(activity.run.startedAt);
      if (startedAt > 0) return startedAt;
    }
    return getSessionLatestChangeTime(session);
  }

  function normalizeSessionSidebarOrder(value) {
    const parsed = typeof value === "number"
      ? value
      : Number.parseInt(String(value || "").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }

  function normalizeSessionActivity(session) {
    const raw = session?.activity || {};
    const rawRunState = raw?.run?.state;
    const runState =
      rawRunState === "running"
        ? rawRunState
        : "idle";
    const queueCount = Number.isInteger(raw?.queue?.count)
      ? raw.queue.count
      : 0;
    const queueState = raw?.queue?.state === "queued" && queueCount > 0
      ? "queued"
      : "idle";
    const renameState = raw?.rename?.state === "pending" || raw?.rename?.state === "failed"
      ? raw.rename.state
      : "idle";
    const compactState = raw?.compact?.state === "pending"
      ? "pending"
      : "idle";

    return {
      run: {
        state: runState,
        phase: typeof raw?.run?.phase === "string" ? raw.run.phase : null,
        startedAt: typeof raw?.run?.startedAt === "string" ? raw.run.startedAt : null,
        runId: typeof raw?.run?.runId === "string" ? raw.run.runId : null,
        cancelRequested: raw?.run?.cancelRequested === true,
      },
      queue: {
        state: queueState,
        count: queueCount,
      },
      rename: {
        state: renameState,
        error: typeof raw?.rename?.error === "string" ? raw.rename.error : "",
      },
      compact: {
        state: compactState,
      },
    };
  }

  function isSessionBusy(session) {
    const activity = normalizeSessionActivity(session);
    return activity.run.state === "running"
      || activity.queue.state === "queued"
      || activity.compact.state === "pending";
  }

  function getSessionPrimaryStatus(session, options = {}) {
    if (!session) {
      return createEmptyStatus();
    }

    const indicators = getSessionStatusSummary(session, options).indicators;
    return indicators[0] || createStatus("idle", t("status.idle"));
  }

  function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
    const activity = normalizeSessionActivity(session);
    const indicators = [];

    if (activity.run.state === "running") {
      indicators.push(createStatus("running", t("status.running"), "status-running", "running"));
    }

    if (activity.queue.state === "queued") {
      indicators.push(createStatus(
        "queued",
        t("workflow.status.queued"),
        "status-queued",
        "queued",
        "",
        activity.queue.count > 0
          ? t("workflow.status.queuedTitle", {
            count: activity.queue.count,
            suffix: activity.queue.count === 1 ? "" : "s",
          })
          : "",
      ));
    }

    if (activity.compact.state === "pending") {
      indicators.push(createStatus("compacting", t("workflow.status.compacting"), "status-compacting", "compacting"));
    }

    if (activity.rename.state === "pending") {
      indicators.push(createStatus("renaming", t("workflow.status.renaming"), "status-renaming", "renaming"));
    }

    if (activity.rename.state === "failed") {
      indicators.push(createStatus(
        "rename-failed",
        t("workflow.status.renameFailed"),
        "status-rename-failed",
        "rename-failed",
        "",
        activity.rename.error || t("workflow.status.renameFailedTitle"),
      ));
    }

    const primary = indicators[0] || (
      session?.tool && includeToolFallback
        ? createStatus("tool", session.tool)
        : createStatus("idle", t("status.idle"))
    );

    return {
      primary,
      indicators: indicators.length > 0 || !primary.label ? indicators : [primary],
    };
  }

  function getSessionVisualStatus(session, options = {}) {
    return getSessionStatusSummary(session, options).primary;
  }

  function getSessionWorkflowPriorityInfo(session) {
    const explicitPriority = getWorkflowPriorityInfo(session?.workflowPriority);
    if (explicitPriority) return explicitPriority;
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    if (workflowState === "waiting_user") return getWorkflowPriorityInfo("high");
    if (workflowState === "done") return getWorkflowPriorityInfo("low");
    return getWorkflowPriorityInfo("medium");
  }

  function hasSessionUnreadUpdate(session) {
    if (!session) return false;
    if (isSessionBusy(session)) return false;
    const unreadUpdateTime = getSessionUnreadUpdateTime(session);
    if (unreadUpdateTime <= 0) return false;
    return unreadUpdateTime > getSessionReviewTime(session);
  }

  function getSessionReviewStatusInfo(session) {
    if (!hasSessionUnreadUpdate(session)) return null;
    return createStatus(
      "unread",
      t("workflow.status.unread"),
      "status-unread",
      "",
      "",
      t("workflow.status.unreadTitle"),
    );
  }

  function isSessionCompleteAndReviewed(session) {
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    return workflowState === "done"
      && !isSessionBusy(session)
      && !hasSessionUnreadUpdate(session);
  }

  function getSessionAttentionBand(session) {
    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    const busy = isSessionBusy(session);
    const unread = hasSessionUnreadUpdate(session);

    if (unread && workflowState === "waiting_user") return 0;
    if (unread) return 1;
    if (workflowState === "waiting_user") return 2;
    if (!busy && workflowState !== "done" && workflowState !== "parked") return 3;
    if (busy) return 4;
    if (workflowState === "parked") return 5;
    if (workflowState === "done") return 6;
    return 3;
  }

  function compareSessionListSessions(a, b) {
    const sidebarOrderA = normalizeSessionSidebarOrder(a?.sidebarOrder);
    const sidebarOrderB = normalizeSessionSidebarOrder(b?.sidebarOrder);
    if (sidebarOrderA && sidebarOrderB && sidebarOrderA !== sidebarOrderB) {
      return sidebarOrderA - sidebarOrderB;
    }

    const attentionBandDiff = getSessionAttentionBand(a) - getSessionAttentionBand(b);
    if (attentionBandDiff) return attentionBandDiff;

    const priorityDiff = (getSessionWorkflowPriorityInfo(b)?.rank || 0) - (getSessionWorkflowPriorityInfo(a)?.rank || 0);
    if (priorityDiff) return priorityDiff;

    const pinDiff = (b?.pinned === true ? 1 : 0) - (a?.pinned === true ? 1 : 0);
    if (pinDiff) return pinDiff;

    return getSessionSortTime(b) - getSessionSortTime(a);
  }

  root.RemoteLabSessionStateModel = {
    createEmptyStatus,
    normalizeSessionWorkflowPriority,
    normalizeSessionWorkflowState,
    normalizeSessionActivity,
    isSessionBusy,
    getSessionSortTime,
    getWorkflowStatusInfo,
    getSessionPrimaryStatus,
    getSessionStatusSummary,
    getSessionVisualStatus,
    hasSessionUnreadUpdate,
    getSessionReviewStatusInfo,
    isSessionCompleteAndReviewed,
    getSessionWorkflowPriorityInfo,
    getSessionAttentionBand,
    compareSessionListSessions,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

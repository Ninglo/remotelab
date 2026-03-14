"use strict";

(function attachRemoteLabSessionStateModel(root) {
  const boardColumns = [
    {
      key: "parked",
      label: "Parked",
      title: "Paused or parked work that is not currently waiting on the user.",
      emptyText: "No parked sessions",
    },
    {
      key: "running",
      label: "Running",
      title: "Sessions actively executing, compacting, or draining queued follow-ups.",
      emptyText: "No running sessions",
    },
    {
      key: "waiting_user",
      label: "Waiting",
      title: "Sessions blocked on user input, approval, files, or manual validation.",
      emptyText: "Nothing waiting for you",
    },
    {
      key: "done",
      label: "Done",
      title: "Sessions whose current task looks complete.",
      emptyText: "No completed sessions",
    },
  ];

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
    return indicators[0] || createStatus("idle", "idle");
  }

  function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
    const activity = normalizeSessionActivity(session);
    const indicators = [];

    if (activity.run.state === "running") {
      indicators.push(createStatus("running", "running", "status-running", "running"));
    }

    if (activity.queue.state === "queued") {
      indicators.push(createStatus(
        "queued",
        "queued",
        "status-queued",
        "queued",
        "",
        activity.queue.count > 0
          ? `${activity.queue.count} follow-up${activity.queue.count === 1 ? "" : "s"} queued`
          : "",
      ));
    }

    if (activity.compact.state === "pending") {
      indicators.push(createStatus("compacting", "compacting", "status-compacting", "compacting"));
    }

    if (activity.rename.state === "pending") {
      indicators.push(createStatus("renaming", "renaming", "status-renaming", "renaming"));
    }

    if (activity.rename.state === "failed") {
      indicators.push(createStatus(
        "rename-failed",
        "rename failed",
        "status-rename-failed",
        "rename-failed",
        "",
        activity.rename.error || "Session rename failed",
      ));
    }

    const primary = indicators[0] || (
      session?.tool && includeToolFallback
        ? createStatus("tool", session.tool)
        : createStatus("idle", "idle")
    );

    return {
      primary,
      indicators: indicators.length > 0 || !primary.label ? indicators : [primary],
    };
  }

  function getSessionVisualStatus(session, options = {}) {
    return getSessionStatusSummary(session, options).primary;
  }

  function getBoardColumns() {
    return boardColumns.map((column) => ({ ...column }));
  }

  function getSessionBoardColumn(session) {
    if (isSessionBusy(session)) {
      return boardColumns[1];
    }

    const workflowState = normalizeSessionWorkflowState(session?.workflowState || "");
    if (workflowState === "waiting_user") {
      return boardColumns[2];
    }
    if (workflowState === "done") {
      return boardColumns[3];
    }
    return boardColumns[0];
  }

  root.RemoteLabSessionStateModel = {
    createEmptyStatus,
    normalizeSessionWorkflowState,
    normalizeSessionActivity,
    isSessionBusy,
    getSessionPrimaryStatus,
    getSessionStatusSummary,
    getSessionVisualStatus,
    getBoardColumns,
    getSessionBoardColumn,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

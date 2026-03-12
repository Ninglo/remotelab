"use strict";

(function attachRemoteLabSessionStateModel(root) {
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

  function getQueuedStatusLabel(count) {
    const total = Number.isInteger(count) ? count : Number(count) || 0;
    return total === 1 ? "1 queued" : `${total} queued`;
  }

  function normalizePendingDeliveryState(value) {
    if (value === "accepted" || value === "failed") return value;
    return "sending";
  }

  function normalizePendingMessage(message) {
    if (!message || typeof message !== "object") return null;
    const text = typeof message.text === "string" ? message.text : "";
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const timestamp = Number.isFinite(message.timestamp)
      ? message.timestamp
      : Date.now();
    return {
      text,
      requestId,
      timestamp,
      deliveryState: normalizePendingDeliveryState(message.deliveryState),
    };
  }

  function isSessionBusy(session) {
    return session?.status === "running" || session?.pendingCompact === true;
  }

  function shouldKeepPendingMessagePending(message, session) {
    const pending = normalizePendingMessage(message);
    if (!pending) return false;
    if (pending.deliveryState === "failed") return false;
    return isSessionBusy(session);
  }

  function getSessionPrimaryStatus(session, options = {}) {
    if (!session) {
      return createEmptyStatus();
    }

    const queuedCount = Number.isInteger(session.queuedMessageCount)
      ? session.queuedMessageCount
      : 0;

    if (queuedCount > 0) {
      return {
        key: "queued",
        label: getQueuedStatusLabel(queuedCount),
        className: "status-queued",
        dotClass: "queued",
        itemClass: "",
        title: "Queued follow-up messages waiting for the next turn",
      };
    }

    if (session.pendingCompact === true) {
      return {
        key: "compacting",
        label: "compressing",
        className: "status-running",
        dotClass: "running",
        itemClass: "",
        title: "Auto Compress is condensing older context into a fresh handoff",
      };
    }

    if (session.status === "running") {
      return {
        key: "running",
        label: "running",
        className: "status-running",
        dotClass: "running",
        itemClass: "",
        title: "",
      };
    }

    if (session.status === "done") {
      const read = typeof options.isRead === "function"
        ? options.isRead(session)
        : false;
      return {
        key: read ? "done-read" : "done-unread",
        label: read ? "read" : "unread",
        className: read ? "status-done-read" : "status-done-unread",
        dotClass: read ? "done-read" : "done-unread",
        itemClass: read ? "is-complete-read" : "is-complete-unread",
        title: "",
      };
    }

    if (session.status === "interrupted") {
      return {
        key: "interrupted",
        label: "interrupted",
        className: "status-interrupted",
        dotClass: "interrupted",
        itemClass: "",
        title: "",
      };
    }

    if (session.archived === true) {
      return {
        key: "archived",
        label: "archived",
        className: "status-archived",
        dotClass: "",
        itemClass: "",
        title: "",
      };
    }

    return createEmptyStatus();
  }

  function getSessionIssueStatus(session, options = {}) {
    if (!session) {
      return createEmptyStatus();
    }

    const renameError =
      typeof session.renameError === "string" ? session.renameError.trim() : "";

    if (options.hasSendFailure === true) {
      return {
        key: "send-failed",
        label: "send issue",
        className: "status-send-failed",
        dotClass: "send-failed",
        itemClass: "",
        title: "A local outgoing message still needs retry or recovery",
      };
    }

    if (session.renameState === "pending") {
      return {
        key: "renaming",
        label: "renaming",
        className: "status-renaming",
        dotClass: "renaming",
        itemClass: "",
        title: "",
      };
    }

    if (session.renameState === "failed") {
      return {
        key: "rename-failed",
        label: "rename issue",
        className: "status-rename-failed",
        dotClass: "rename-failed",
        itemClass: "",
        title: renameError || "Rename suggestion could not be applied",
      };
    }

    return createEmptyStatus();
  }

  function getToolFallbackStatus(session) {
    if (!session?.tool || !session?.name) {
      return createEmptyStatus();
    }

    return {
      key: "tool",
      label: session.tool,
      className: "",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  function getSessionStatusSummary(session, options = {}) {
    const primary = getSessionPrimaryStatus(session, options);
    const issue = getSessionIssueStatus(session, options);
    const indicators = [];

    if (primary.key !== "idle") {
      indicators.push(primary);
    }
    if (issue.key !== "idle" && issue.key !== primary.key) {
      indicators.push(issue);
    }
    if (indicators.length === 0 && options.includeToolFallback) {
      const toolFallback = getToolFallbackStatus(session);
      if (toolFallback.key !== "idle") {
        indicators.push(toolFallback);
      }
    }

    return {
      primary: indicators[0] || createEmptyStatus(),
      indicators,
    };
  }

  function getSessionVisualStatus(session, options = {}) {
    return getSessionStatusSummary(session, options).primary;
  }

  root.RemoteLabSessionStateModel = {
    createEmptyStatus,
    normalizePendingDeliveryState,
    normalizePendingMessage,
    isSessionBusy,
    shouldKeepPendingMessagePending,
    getQueuedStatusLabel,
    getSessionPrimaryStatus,
    getSessionIssueStatus,
    getSessionStatusSummary,
    getSessionVisualStatus,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);

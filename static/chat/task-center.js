"use strict";

(function attachTaskCenter(globalScope) {
  const panel = document.getElementById("taskCenterPanel");
  if (!panel) return;

  const createToggle = document.getElementById("taskCenterCreateToggle");
  const form = document.getElementById("taskCenterForm");
  const titleInput = document.getElementById("taskCenterTitle");
  const promptInput = document.getElementById("taskCenterPrompt");
  const kindSelect = document.getElementById("taskCenterKind");
  const onceField = document.getElementById("taskCenterOnceField");
  const scheduledAtInput = document.getElementById("taskCenterScheduledAt");
  const recurringFields = document.getElementById("taskCenterRecurringFields");
  const cadenceSelect = document.getElementById("taskCenterCadence");
  const cronField = document.getElementById("taskCenterCronField");
  const cronInput = document.getElementById("taskCenterCron");
  const intervalField = document.getElementById("taskCenterIntervalField");
  const everySecondsInput = document.getElementById("taskCenterEverySeconds");
  const timezoneField = document.getElementById("taskCenterTimezoneField");
  const timezoneInput = document.getElementById("taskCenterTimezone");
  const lifetimeFields = document.getElementById("taskCenterLifetimeFields");
  const lifetimeSelect = document.getElementById("taskCenterLifetime");
  const maxExecutionsField = document.getElementById("taskCenterMaxExecutionsField");
  const maxExecutionsInput = document.getElementById("taskCenterMaxExecutions");
  const gateFields = document.getElementById("taskCenterGateFields");
  const gateModeSelect = document.getElementById("taskCenterGateMode");
  const gateRuntimeField = document.getElementById("taskCenterGateRuntimeField");
  const gateRuntimeSelect = document.getElementById("taskCenterGateRuntime");
  const gateScriptFields = document.getElementById("taskCenterGateScriptFields");
  const gateSourceInput = document.getElementById("taskCenterGateSource");
  const gateTimeoutInput = document.getElementById("taskCenterGateTimeout");
  const gateCooldownInput = document.getElementById("taskCenterGateCooldown");
  const targetModeSelect = document.getElementById("taskCenterTargetMode");
  const sessionSelect = document.getElementById("taskCenterSession");
  const sessionLabel = document.getElementById("taskCenterSessionLabel");
  const sessionHelp = document.getElementById("taskCenterSessionHelp");
  const runtimePolicySelect = document.getElementById("taskCenterRuntimePolicy");
  const runtimeHelp = document.getElementById("taskCenterRuntimeHelp");
  const notificationSelect = document.getElementById("taskCenterNotification");
  const createCancel = document.getElementById("taskCenterCreateCancel");
  const createSubmit = document.getElementById("taskCenterCreateSubmit");
  const formStatus = document.getElementById("taskCenterFormStatus");
  const filterSelect = document.getElementById("taskCenterFilter");
  const refreshButton = document.getElementById("taskCenterRefresh");
  const list = document.getElementById("taskCenterList");

  const viewTabs = document.getElementById("taskCenterViews");
  let selectedView = "timeline";
  let requestedTaskId = new URLSearchParams(window.location.search).get("task") || "";
  let tasks = [];
  let backgroundMechanisms = [];
  let automationFlows = { groups: [] };
  let selectedFlow = "memory";
  const openFlowNotes = new Set();
  let flowTaskIds = null;
  const flowsPanel = document.getElementById("taskCenterFlows");
  const timelinePanel = document.getElementById("taskCenterTimeline");
  const openTimelineRows = new Set();
  let loaded = false;
  let loading = false;
  let actionTaskId = "";
  let loadError = "";
  const openTaskIds = new Set();
  const executionHistory = new Map();
  const visibleTaskLimits = new Map();
  const closedPurposeSections = new Set();
  const openDayIds = new Set();
  const openExecutionIds = new Set();
  const openSettingsIds = new Set();
  const openDefinitionIds = new Set();
  let selectedFilter = "recurring";
  const overview = globalScope.RemoteLabAutomationOverview;

  function translate(key, fallback = key, vars = undefined) {
    const value = typeof globalScope.remotelabT === "function"
      ? globalScope.remotelabT(key, vars)
      : key;
    return value === key ? fallback : value;
  }

  function flowTranslate(key, fallback = key, vars = undefined) {
    const value = globalScope.remotelabT?.(key, vars, automationFlows.language || globalScope.remotelabGetActiveUiLanguage?.()) || key;
    return value === key ? fallback : value;
  }

  function renderViews() {
    for (const button of viewTabs?.querySelectorAll("[data-task-view]") || []) {
      const active = button.dataset.taskView === selectedView;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      button.textContent = flowTranslate("tasks.views." + button.dataset.taskView);
      document.getElementById(button.getAttribute("aria-controls")).hidden = !active;
    }
    viewTabs?.setAttribute("aria-label", flowTranslate("tasks.views.label"));
    const status = document.getElementById("taskViewStatus");
    if (status) {
      status.textContent = loadError || (!loaded ? flowTranslate("tasks.loading") : "");
      status.hidden = selectedView === "tasks" || !status.textContent;
    }
  }

  function selectView(view, { focus = false } = {}) {
    selectedView = view;
    renderViews();
    if (focus) viewTabs?.querySelector('[aria-selected="true"]')?.focus();
  }

  function flowState(task) {
    const business = overview.businessStatus(task);
    return business ? flowTranslate('tasks.business.' + business, business)
      : flowTranslate('tasks.state.' + task.state, task.state);
  }

  function activeSessions() {
    const source = typeof sessions !== "undefined" && Array.isArray(sessions) ? sessions : [];
    return source.filter((session) => session?.id && !session.archived && !session.internalRole);
  }

  function sessionName(sessionId) {
    const session = activeSessions().find((entry) => entry.id === sessionId)
      || (typeof sessions !== "undefined" && Array.isArray(sessions)
        ? sessions.find((entry) => entry?.id === sessionId)
        : null);
    return session?.name || sessionId || translate("tasks.session.unknown", "Unknown Session");
  }

  function creatorName(identityId) {
    const normalized = typeof identityId === "string" ? identityId.trim() : "";
    if (!normalized || typeof getPeopleDirectory !== "function") return "";
    const person = getPeopleDirectory().find((entry) => (entry.identities || []).some(
      (identity) => identity.id === normalized,
    ));
    return person?.name || person?.handle || "";
  }

  function formatDateTime(value) {
    const parsed = new Date(value || "");
    if (!Number.isFinite(parsed.getTime())) return translate("tasks.time.none", "Not scheduled");
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(parsed);
  }

  function toLocalDateTimeInput(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function createNode(tagName, className = "", text = "") {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function setFormStatus(message = "", { error = false } = {}) {
    if (!formStatus) return;
    formStatus.textContent = message;
    formStatus.classList.toggle("error", error);
  }

  function syncTimingFields() {
    const recurring = kindSelect?.value === "recurring";
    if (onceField) onceField.hidden = recurring;
    if (recurringFields) recurringFields.hidden = !recurring;
    if (lifetimeFields) lifetimeFields.hidden = !recurring;
    if (gateFields) gateFields.hidden = !recurring;
    if (scheduledAtInput) scheduledAtInput.required = !recurring;
    syncCadenceFields();
    syncLifetimeFields();
    syncGateFields();
  }

  function syncCadenceFields() {
    const recurring = kindSelect?.value === "recurring";
    const interval = cadenceSelect?.value === "interval";
    if (cronField) cronField.hidden = !recurring || interval;
    if (intervalField) intervalField.hidden = !recurring || !interval;
    if (timezoneField) timezoneField.hidden = !recurring || interval;
    if (cronInput) cronInput.required = recurring && !interval;
    if (timezoneInput) timezoneInput.required = recurring && !interval;
    if (everySecondsInput) everySecondsInput.required = recurring && interval;
  }

  function syncLifetimeFields() {
    const bounded = kindSelect?.value === "recurring" && lifetimeSelect?.value === "bounded";
    if (maxExecutionsField) maxExecutionsField.hidden = !bounded;
    if (maxExecutionsInput) maxExecutionsInput.required = bounded;
  }

  function syncGateFields() {
    const scripted = kindSelect?.value === "recurring" && gateModeSelect?.value === "script";
    if (gateRuntimeField) gateRuntimeField.hidden = !scripted;
    if (gateScriptFields) gateScriptFields.hidden = !scripted;
    if (gateSourceInput) gateSourceInput.required = scripted;
  }

  function syncTargetFields() {
    const fixed = targetModeSelect?.value === "fixed_session";
    if (sessionLabel) {
      sessionLabel.textContent = fixed
        ? translate("tasks.form.session", "Session")
        : translate("tasks.form.sourceSession", "Template Session");
    }
    if (sessionHelp) {
      sessionHelp.textContent = fixed
        ? translate("tasks.form.fixedHelp", "Each run is queued into this Session.")
        : translate("tasks.form.newHelp", "Each run creates a new Session in the template's folder; model policy is configured below.");
    }
    syncRuntimeHelp();
  }

  function syncRuntimeHelp() {
    if (!runtimeHelp) return;
    const source = activeSessions().find(entry => entry.id === sessionSelect?.value);
    runtimeHelp.textContent = runtimePolicySelect?.value === "fixed"
      ? [source?.tool, source?.model, source?.effort].filter(Boolean).join(" · ")
      : translate("tasks.runtime.help", "Each new Session starts from Auto. Reused Sessions keep their own runtime.");
  }

  function renderSessionOptions() {
    if (!sessionSelect) return;
    const previous = sessionSelect.value;
    const candidates = activeSessions();
    sessionSelect.replaceChildren();
    if (candidates.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = translate("tasks.form.noSessions", "No active Sessions available");
      sessionSelect.appendChild(option);
      sessionSelect.disabled = true;
      if (createSubmit) createSubmit.disabled = true;
      return;
    }
    sessionSelect.disabled = false;
    if (createSubmit && !loading) createSubmit.disabled = false;
    for (const session of candidates) {
      const option = document.createElement("option");
      option.value = session.id;
      option.textContent = session.name || session.id;
      sessionSelect.appendChild(option);
    }
    const preferred = candidates.some((entry) => entry.id === previous)
      ? previous
      : candidates.some((entry) => entry.id === (typeof currentSessionId === "string" ? currentSessionId : ""))
        ? currentSessionId
        : candidates[0].id;
    sessionSelect.value = preferred;
    syncRuntimeHelp();
  }

  function setFormVisible(visible) {
    if (!form) return;
    form.hidden = !visible;
    if (visible) {
      renderSessionOptions();
      if (scheduledAtInput && !scheduledAtInput.value) {
        scheduledAtInput.value = toLocalDateTimeInput(new Date(Date.now() + 60 * 60 * 1000));
      }
      if (timezoneInput && !timezoneInput.value) {
        timezoneInput.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
      }
      syncTimingFields();
      syncTargetFields();
      titleInput?.focus();
    }
    setFormStatus();
  }

  function stateLabel(state) {
    return translate(`tasks.state.${state}`, state || translate("tasks.state.unknown", "Unknown"));
  }

  function taskScheduleText(task, tr = translate) {
    if (task?.kind !== "recurring") return task.members?.length > 1
      ? tr("tasks.summary.followup", "Follow-ups for this task") : formatDateTime(task?.schedule?.scheduledAt);
    if (task.schedule?.type === "interval") {
      const seconds = task.schedule.everySeconds;
      const [count, unit] = seconds % 86400 === 0 ? [seconds / 86400, "days"]
        : seconds % 3600 === 0 ? [seconds / 3600, "hours"]
          : seconds % 60 === 0 ? [seconds / 60, "minutes"] : [seconds, "seconds"];
      return tr(`tasks.summary.every.${unit}`, `Every ${count} ${unit}`, { count });
    }
    const [minute, hours, date, month, weekdays] = (task.schedule?.cron || "").split(/\s+/);
    const simpleTimes = /^\d+$/.test(minute) && /^\d+(?:,\d+)*$/.test(hours) && date === "*" && month === "*";
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const withZone = text => task.schedule?.timezone && task.schedule.timezone !== localZone ? `${text} · ${task.schedule.timezone}` : text;
    if (simpleTimes) {
      const times = hours.split(",").map(hour => `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`).join(" / ");
      if (weekdays === "*") return withZone(tr("tasks.summary.daily", "Daily at {times}", { times }));
      if (weekdays === "1-5") return withZone(tr("tasks.summary.weekdays", "Weekdays at {times}", { times }));
      if (/^[0-7](?:,[0-7])*$/.test(weekdays)) {
        const days = weekdays.split(",").map(day => tr(`tasks.summary.day.${Number(day) % 7}`, day)).join(" / ");
        return withZone(tr("tasks.summary.weekly", "{days} at {times}", { days, times }));
      }
    }
    if (/^\d+$/.test(minute) && [hours, date, month, weekdays].every(v => v === "*"))
      return withZone(tr("tasks.flows.hourly", "Hourly at :{minute}", { minute: minute.padStart(2, "0") }));
    return withZone(tr("tasks.flows.custom", "Schedule {cron}", { cron: task.schedule?.cron || "—" }));
  }

  function taskTargetText(task) {
    const target = task?.target || {};
    if (target.mode === "fixed_session") {
      return translate("tasks.target.fixedValue", "Fixed · {session}", {
        session: sessionName(target.sessionId),
      });
    }
    if (target.mode === "calendar_day_session") {
      return translate("tasks.target.dailyValue", "One Session per day · {session}", {
        session: sessionName(target.sourceSessionId),
      });
    }
    return translate("tasks.target.newValue", "New each run · from {session}", {
      session: sessionName(target.sourceSessionId),
    });
  }

  function notificationText(task, { compact = false, tr = translate } = {}) {
    const notification = task?.resultDelivery || task?.notification || {};
    if (notification.mode !== "conversation") {
      return tr("tasks.notification.remotelab", "RemoteLab only");
    }
    const connector = notification.connector || tr("tasks.notification.external", "External source");
    const target = notification.target || {};
    const destination = target.chatName || target.name || target.label || target.chatId || target.openId || target.email || "";
    if (compact) {
      const provider = tr(`tasks.notification.${connector}`, connector);
      const named = target.chatName || target.name || target.label || target.email;
      const address = named || (target.chatId ? tr("tasks.notification.chat", "Chat")
        + ` · …${target.chatId.slice(-8)}` : destination);
      return [provider, address, target.threadId ? tr("tasks.notification.thread", "Topic") : ""].filter(Boolean).join(" · ");
    }
    return [connector, destination, target.threadId, notification.sourceRouteId].filter(Boolean).join(" · ");
  }

  function lifetimeText(task) {
    const lifetime = task?.lifetime || {};
    if (lifetime.mode !== "bounded") return translate("tasks.lifetime.continuous", "Continuous");
    const parts = [];
    if (lifetime.maxExecutions) {
      const admitted = task?.counters?.admittedExecutions || 0;
      parts.push(translate("tasks.lifetime.admissions", `${admitted}/${lifetime.maxExecutions} Agent admissions`, {
        admitted,
        max: lifetime.maxExecutions,
      }));
    }
    if (lifetime.maxChecks) {
      const checks = task?.counters?.checks || 0;
      parts.push(translate("tasks.lifetime.checks", `${checks}/${lifetime.maxChecks} checks`, {
        checks,
        max: lifetime.maxChecks,
      }));
    }
    if (lifetime.endsAt) {
      const time = formatDateTime(lifetime.endsAt);
      parts.push(translate("tasks.lifetime.until", `until ${time}`, { time }));
    }
    return parts.join(" · ") || translate("tasks.lifetime.finite", "Finite");
  }

  function gateText(task) {
    if (task?.gate?.mode !== "script") return translate("tasks.gate.direct", "Direct");
    const checks = task?.counters?.checks || 0;
    const matches = task?.counters?.matches || 0;
    const runtime = task.gate.runtime || "script";
    return translate("tasks.gate.scriptStats", `${runtime} · ${matches}/${checks} matched`, {
      runtime,
      matches,
      checks,
    });
  }

  function addMetaRow(container, label, value, { link = "" } = {}) {
    const row = createNode("div", "task-meta-row");
    row.appendChild(createNode("span", "task-meta-label", label));
    const valueNode = createNode("span", "task-meta-value");
    if (link) {
      const anchor = document.createElement("a");
      anchor.href = typeof globalScope.remotelabResolveProductPath === "function"
        ? globalScope.remotelabResolveProductPath(link)
        : link;
      anchor.textContent = value;
      valueNode.appendChild(anchor);
    } else {
      valueNode.textContent = value;
    }
    row.appendChild(valueNode);
    container.appendChild(row);
  }

  function executionText(execution) {
    if (!execution) return translate("tasks.execution.none", "No execution yet");
    if (execution.triggerStatus === "delivered" && execution.runAvailable === false && ["admitted", "accepted"].includes(execution.state)) {
      return translate("tasks.execution.unverified", "Execution state not verified");
    }
    const stamp = execution.completedAt || execution.admittedAt || execution.attemptedAt || execution.scheduledAt;
    return `${stateLabel(execution.state)} · ${formatDateTime(stamp)}`;
  }

  async function applyAction(task, action) {
    if (!task?.id || actionTaskId) return;
    if (action === "cancel") {
      const confirmed = globalScope.confirm(translate(
        "tasks.cancel.confirm",
        "Cancel this task? Future runs will be stopped, but an active run will continue.",
      ));
      if (!confirmed) return;
    }
    actionTaskId = task.id;
    renderTasks();
    try {
      const payload = await fetchJsonOrRedirect(
        `/api/automation-tasks/${encodeURIComponent(task.id)}/${action}`,
        { method: "POST", revalidate: false },
      );
      const next = payload?.task;
      if (next?.id) {
        tasks = tasks.map((entry) => entry.id === next.id ? { ...next, package: entry.package } : entry);
        executionHistory.clear();
      } else {
        await refreshTasks({ force: true });
      }
    } catch (error) {
      if (typeof showSystemToast === "function") {
        showSystemToast(error?.message || translate("tasks.action.failed", "Automation update failed"), "error");
      }
    } finally {
      actionTaskId = "";
      renderTasks();
    }
  }

  function actionLabel(action) {
    return translate(`tasks.action.${action}`, action);
  }

  function displayTasks() {
    const groups = new Map();
    // Preserve the original list order; failures do not change package placement.
    for (const task of tasks) {
      const key = task.package?.id || task.id;
      const members = groups.get(key) || []; members.push(task); groups.set(key, members);
    }
    return [...groups.entries()].map(([id, members]) => {
      const parent = members.find(item => item.kind === "recurring" && item.state === "active")
        || members.find(item => item.kind === "recurring" && item.state === "paused")
        || members.find(item => item.kind === "recurring") || members[0];
      const latest = members.map(item => item.lastExecution).filter(Boolean)
        .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt))[0];
      const next = members.map(item => item.nextRunAt).filter(Boolean).sort()[0] || "";
      const original = [...members].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
      return { ...parent, id, members, historyTaskId: parent.id,
        title: parent.package?.title || taskTitle(original),
        prompt: parent.kind === "recurring" ? parent.prompt : original.prompt,
        lastExecution: latest, nextRunAt: next,
        executionCount: members.reduce((sum, item) => sum + (item.executionCount || 0), 0),
        summary: {
          day: parent.summary?.day, timezone: parent.summary?.timezone,
          latestExecution: members.map(item => item.summary?.latestExecution).filter(Boolean)
            .sort((a, b) => Date.parse(executionTime(b)) - Date.parse(executionTime(a)))[0] || null,
          firstRunAt: members.map(item => item.summary?.firstRunAt).filter(Boolean).sort()[0] || "",
          inspection: members.some(item => item.summary?.inspection) ? {
            total: members.reduce((sum, item) => sum + (item.summary?.inspection?.total || 0), 0),
            failed: members.reduce((sum, item) => sum + (item.summary?.inspection?.failed || 0), 0),
            latest: members.map(item => item.summary?.inspection?.latest).filter(Boolean)
              .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null,
          } : null,
          totalRuns: members.reduce((sum, item) => sum + (item.summary?.totalRuns || 0), 0),
          failedRuns: members.reduce((sum, item) => sum + (item.summary?.failedRuns || 0), 0),
          today: Object.fromEntries(["runs", "completed", "failed", "running", "cancelled", "unverified"]
            .map(key => [key, members.reduce((sum, item) => sum + (item.summary?.today?.[key] || 0), 0)]).concat([
              ["checked", members.some(item => item.summary?.today?.checked)],
              ["checkFailed", members.some(item => item.summary?.today?.checkFailed)],
            ])),
        },
        actions: parent.kind === "recurring" ? parent.actions : [],
        health: { ...parent.health, recordedFailures: members.reduce((sum, item) => sum + (item.health?.recordedFailures || 0), 0) } };
    });
  }

  function taskTitle(task) {
    if (task.title && !["One-time task", "Recurring task"].includes(task.title)) return task.title;
    return (task.prompt || translate("tasks.untitled", "Untitled automation")).slice(0, 70);
  }

  function createExecutionRow(execution) {
    const row = createNode("li", "task-execution"); row.dataset.state = execution.state;
    const detail = createNode("details", "task-execution-detail");
    const toggle = createNode("summary", "task-execution-heading");
    toggle.append(createNode("time", "", formatDateTime(execution.attemptedAt || execution.admittedAt || execution.scheduledAt)),
      createNode("span", "task-state-pill", executionText(execution)));
    detail.appendChild(toggle);
    detail.open = openExecutionIds.has(execution.id);
    detail.addEventListener("toggle", () => {
      if (detail.open) openExecutionIds.add(execution.id); else openExecutionIds.delete(execution.id);
    });
    const content = createNode("div", "task-execution-content");
    const heading = createNode("div", "task-execution-heading");
    const date = createNode("time", "", formatDateTime(execution.scheduledAt));
    if (execution.scheduledAt) date.dateTime = execution.scheduledAt;
    heading.append(date, createNode("span", "task-state-pill", executionText(execution)));
    content.appendChild(heading);
    if (execution.title) content.appendChild(createNode("p", "task-history-note", execution.title));
    const meta = createNode("div", "task-card-meta");
    for (const [key, value] of [["scheduled", execution.scheduledAt], ["attempted", execution.attemptedAt],
      ["admitted", execution.admittedAt], ["completed", execution.completedAt]]) {
      if (value) addMetaRow(meta, translate(`tasks.record.${key}`, key), formatDateTime(value));
    }
    if (execution.runtime) addMetaRow(meta, translate("tasks.runtime.last", "Run configuration"),
      [execution.runtime.tool, execution.runtime.model, execution.runtime.effort].filter(Boolean).join(" · "));
    if (execution.id) addMetaRow(meta, translate("tasks.record.triggerId", "Trigger ID"), execution.id);
    if (execution.taskId) addMetaRow(meta, translate("tasks.record.taskId", "Task ID"), execution.taskId);
    if (execution.runId) addMetaRow(meta, translate("tasks.record.runId", "Run ID"), execution.runId);
    if (execution.sessionId) addMetaRow(meta, translate("tasks.record.sessionId", "Session ID"), execution.sessionId);
    content.appendChild(meta);

    if (execution.error) {
      content.appendChild(createNode("pre", "task-execution-error", execution.error));
    }
    if (execution.sessionId) {
      const link = createNode("a", "task-execution-link", translate("tasks.history.logs", "Open execution Session and logs"));
      const path = `/?session=${encodeURIComponent(execution.sessionId)}&tab=sessions`;
      link.href = globalScope.remotelabResolveProductPath?.(path) || path;
      content.appendChild(link);
    } else if (execution.triggerStatus === "delivered") {
      content.appendChild(createNode("p", "task-history-note", translate("tasks.history.noLogs", "No retained execution Session; completion cannot be verified.")));
    }
    const producer = tasks.find(item => item.id === execution.taskId && item.kind === "one_time");
    if (producer?.actions?.length) {
      const actions = createNode("div", "task-trigger-actions");
      for (const action of producer.actions) {
        const button = createNode("button", `task-center-action${action === "cancel" ? " danger" : ""}`, actionLabel(action));
        button.type = "button"; button.disabled = Boolean(actionTaskId);
        button.addEventListener("click", () => void applyAction(producer, action)); actions.appendChild(button);
      }
      content.appendChild(actions);
    }
    detail.appendChild(content); row.appendChild(detail);
    return row;
  }

  async function loadExecutionHistory(task, { more = false, failedOnly = false } = {}) {
    let history = executionHistory.get(task.id);
    if (history?.loading) return;
    const status = failedOnly ? "failed" : "all";
    if (!more || history?.status !== status) history = { entries: [], nextCursor: "", status };
    executionHistory.set(task.id, history); history.loading = true; history.error = "";
    renderTasks();
    try {
      const query = new URLSearchParams({ limit: "25", status, scope: "package" });
      if (more && history.nextCursor) query.set("cursor", history.nextCursor);
      const payload = await fetchJsonOrRedirect(`/api/automation-tasks/${encodeURIComponent(task.historyTaskId || task.id)}/executions?${query}`, { revalidate: false, cache: "no-store" });
      const seen = new Set(history.entries.map(item => item.id));
      history.entries.push(...(payload.executions || []).filter(item => !seen.has(item.id)));
      history.nextCursor = payload.nextCursor || "";
      history.loaded = true;
    } catch (error) { history.error = error.message || translate("tasks.history.failed", "Could not load execution history."); }
    finally { history.loading = false; renderTasks(); }
  }

  function createHistory(task) {
    const root = createNode("section", "task-history");
    const toolbar = createNode("div", "task-history-toolbar");
    toolbar.appendChild(createNode("h3", "", translate("tasks.history.title", "Trigger timeline")));
    const history = executionHistory.get(task.id);
    const failedOnly = history?.status === "failed";
    const filter = createNode("button", "task-center-action", translate("tasks.history.failures", "Failures only"));
    filter.type = "button"; filter.setAttribute("aria-pressed", String(failedOnly));
    filter.disabled = Boolean(history?.loading);
    filter.addEventListener("click", () => void loadExecutionHistory(task, { failedOnly: !failedOnly }));
    toolbar.appendChild(filter); root.appendChild(toolbar);
    if (task.summary?.inspection?.total) {
      root.appendChild(createNode("p", "task-history-note", translate("tasks.summary.inspectionScope",
        "{checks} checks ({checkFailures} failed); {runs} AI executions ({runFailures} failed). Checks keep totals and their latest result; the timeline below lists AI executions.", {
          checks: task.summary.inspection.total, checkFailures: task.summary.inspection.failed,
          runs: task.summary.totalRuns, runFailures: task.summary.failedRuns,
        })));
      const check = task.summary.inspection.latest;
      if (check) root.appendChild(createNode("p", "task-history-note", translate("tasks.summary.latestCheck", "Latest check") + " · " + formatDateTime(check.at)));
      if (check?.error && check.error !== task.check?.error) root.appendChild(createNode("pre", "task-execution-error", check.error));
    }
    if (task.check?.error) {
      root.appendChild(createNode("p", "task-history-note", translate("tasks.history.checkError", "Latest scheduler/check error") + " · " + formatDateTime(task.check.errorAt)));
      root.appendChild(createNode("pre", "task-execution-error", task.check.error));
    }
    const entries = history?.entries || [];
    const timeline = createNode("ol", "task-execution-timeline");
    const timezone = task.summary?.timezone || task.schedule?.timezone || "Asia/Shanghai";
    root.appendChild(createNode("p", "task-history-note", translate("tasks.history.dayScope",
      "Dates use {timezone}; {count} records loaded. Earlier records remain available below.", { timezone, count: entries.length })));
    for (const group of overview.days(entries, timezone)) {
      const dayRow = createNode("li", "task-history-day");
      const detail = createNode("details", "task-day-detail");
      const key = `${task.id}:${group.day}`;
      detail.dataset.day = group.day; detail.open = openDayIds.has(key);
      const counts = new Map();
      for (const execution of group.records) {
        const state = ["accepted", "admitted"].includes(execution.state) && !execution.runAvailable ? "unverified" : execution.state;
        counts.set(state, (counts.get(state) || 0) + 1);
      }
      const outcomes = [...counts].map(([state, count]) => `${state === "unverified" ? translate("tasks.execution.unverified", "Unverified") : stateLabel(state)} ${count}`).join(" · ");
      const heading = createNode("summary", "task-day-heading");
      heading.append(createNode("span", "", group.day === "unknown" ? translate("tasks.record.unknownDate", "Date not recorded") : group.day),
        createNode("span", "task-day-outcomes", translate(history?.nextCursor ? "tasks.history.loadedCount" : "tasks.history.recordCount",
          "{count} records", { count: group.records.length }) + " · " + outcomes));
      detail.appendChild(heading);
      const records = createNode("ol", "task-execution-timeline");
      group.records.forEach(execution => records.appendChild(createExecutionRow(execution)));
      detail.appendChild(records);
      detail.addEventListener("toggle", () => { if (detail.open) openDayIds.add(key); else openDayIds.delete(key); });
      dayRow.appendChild(detail); timeline.appendChild(dayRow);
    }
    root.appendChild(timeline);
    if (!entries.length) root.appendChild(createNode("p", "task-history-note", translate(history?.loading ? "tasks.loading" : failedOnly ? "tasks.history.noFailures" : "tasks.execution.none", history?.loading ? "Loading…" : failedOnly ? "No recorded failed triggers." : "No execution yet")));
    if (history?.error) root.appendChild(createNode("p", "task-execution-error", history.error));
    if (history?.nextCursor || history?.error) {
      const more = createNode("button", "task-center-action", translate(history.error ? "tasks.history.retry" : "tasks.history.more", history.error ? "Retry" : "Earlier triggers"));
      more.type = "button"; more.disabled = Boolean(history.loading);
      more.addEventListener("click", () => void loadExecutionHistory(task, { more: Boolean(history.nextCursor), failedOnly }));
      root.appendChild(more);
    }
    return root;
  }

  function lifecycle(task) {
    return overview.category(task);
  }

  function executionTime(execution) {
    return execution?.attemptedAt || execution?.admittedAt || execution?.scheduledAt || "";
  }

  function latestActivity(task) {
    const execution = task.summary?.latestExecution;
    const inspection = task.summary?.inspection?.latest;
    if (inspection && (!execution || Date.parse(inspection.at) > Date.parse(executionTime(execution)))) {
      return { at: inspection.at, result: translate(inspection.state === "failed" ? "tasks.summary.checkFailed" : "tasks.summary.checkCompleted", "Check completed") };
    }
    return execution ? { at: executionTime(execution), result: ["admitted", "accepted"].includes(execution.state) && !execution.runAvailable
      ? translate("tasks.execution.unverified", "Execution state not verified") : stateLabel(execution.state) } : null;
  }

  function cumulativeText(task) {
    const summary = task.summary;
    if (!summary) return "—";
    const checks = summary.inspection?.total || 0;
    if (checks) return translate("tasks.summary.checkCount", "{count} checks", { count: checks });
    return summary.totalRuns ? translate("tasks.summary.count", "{count} runs", { count: summary.totalRuns })
      : translate("tasks.summary.noRecords", "No execution records");
  }

  function createTaskDefinition(task) {
    const root = createNode("section", "task-definition-content");
    const main = createNode("div", "task-card-main");
    const heading = createNode("div", "task-card-heading");
    heading.append(createNode("h4", "task-card-title", taskTitle(task)), createNode("span", "task-state-pill", stateLabel(task.state)));
    main.appendChild(heading);
    if (task.prompt) main.appendChild(createNode("div", "task-card-prompt", task.prompt));
    const meta = createNode("div", "task-card-meta");
    const creator = creatorName(task.createdByIdentityId);
    addMetaRow(meta, translate("tasks.meta.creator", "Creator"), creator || translate("tasks.meta.notRecorded", "Not recorded"));
    if (task.createdAt) addMetaRow(meta, translate("tasks.meta.created", "Created"), formatDateTime(task.createdAt));
    if (task.updatedAt) addMetaRow(meta, translate("tasks.meta.updated", "Updated"), formatDateTime(task.updatedAt));
    if (task.sourceSessionId) addMetaRow(meta, translate("tasks.session.sourceDiscussion", "Original discussion (reference)"), sessionName(task.sourceSessionId),
      { link: `/?session=${encodeURIComponent(task.sourceSessionId)}&tab=sessions` });
    addMetaRow(meta, translate("tasks.record.taskId", "Task ID"), task.id);
    addMetaRow(
      meta,
      translate("tasks.meta.schedule", "Schedule"),
      task.kind === "recurring" && task.schedule?.cron
        ? `${task.schedule.cron} · ${task.schedule.timezone}` : taskScheduleText(task),
    );
    addMetaRow(
      meta,
      translate("tasks.meta.next", "Next"),
      task.nextRunAt ? formatDateTime(task.nextRunAt) : translate("tasks.time.none", "Not scheduled"),
    );
    addMetaRow(meta, translate("tasks.meta.execution", "Execution"), taskTargetText(task));
    const runtime = task.runtime;
    addMetaRow(meta, translate("tasks.runtime.label", "Model policy"),
      runtime?.runtimePolicy === "auto" || runtime?.runtimePolicy === "follow_default"
        ? translate("tasks.runtime.follow", "Auto for each new Session") + " · " + translate("tasks.runtime.help", "Each new Session starts from Auto. Reused Sessions keep their own runtime.")
        : translate("tasks.runtime.fixed", "Fixed") + " · " + [runtime?.tool, runtime?.model, runtime?.effort].filter(Boolean).join(" · "));
    addMetaRow(meta, translate("tasks.meta.delivery", "Delivery"), notificationText(task));
    if (task.kind === "recurring") {
      addMetaRow(meta, translate("tasks.meta.lifetime", "Lifetime"), lifetimeText(task));
      addMetaRow(meta, translate("tasks.meta.admission", "Admission"), gateText(task));
      if (task.wakeOn?.includes("foreground_idle")) {
        addMetaRow(meta, translate("tasks.meta.eventWake", "Event wake-up"),
          translate("tasks.wake.foreground_idle", "Check conditions when all Sessions become idle; schedule remains a fallback"));
        if (task.check?.cause) addMetaRow(meta, translate("tasks.meta.checkCause", "Last check cause"),
          translate(`tasks.wake.${task.check.cause}`, task.check.cause));
      }
      if (task.automationPolicy?.minIdleSeconds) {
        addMetaRow(meta, translate("tasks.meta.idleWindow", "Continuous idle"), `${task.automationPolicy.minIdleSeconds}s`);
      }
      if (task.gate?.mode === "script") {
        addMetaRow(meta, translate("tasks.meta.gateSnapshot", "Condition snapshot"), task.gate.snapshotSha256 || "—");
        addMetaRow(meta, translate("tasks.meta.gateTimeout", "Condition timeout"), `${task.gate.timeoutSeconds}s`);
        addMetaRow(meta, translate("tasks.meta.gateCooldown", "Condition cooldown"), `${task.gate.cooldownSeconds}s`);
      }
    }
    addMetaRow(meta, translate("tasks.meta.alerts", "Alerts"), [task.alerts?.mode,
      ...(task.alerts?.on || []).map(event => translate(`tasks.alert.${event}`, event))].filter(Boolean).join(" · ") || "—");
    const execution = task.lastExecution;
    if (execution?.runtime) addMetaRow(meta, translate("tasks.runtime.last", "Last run configuration"),
      [execution.runtime.tool, execution.runtime.model, execution.runtime.effort].filter(Boolean).join(" · "));
    addMetaRow(
      meta,
      translate("tasks.meta.lastRun", "Last run"),
      executionText(execution),
      execution?.sessionId
        ? { link: `/?session=${encodeURIComponent(execution.sessionId)}&tab=sessions` }
        : {},
    );
    main.appendChild(meta);
    if (execution?.error || task.lastError) addMetaRow(meta, translate("tasks.meta.error", "Error"), execution?.error || task.lastError);
    root.appendChild(main);
    if (Array.isArray(task.actions) && task.actions.length > 0) {
      const actions = createNode("div", "task-card-actions");
      if (runtime?.runtimePolicy === "fixed") {
        const useAuto = createNode("button", "task-center-action", translate("tasks.runtime.useAuto", "Use Auto for future new Sessions"));
        useAuto.type = "button";
        useAuto.disabled = Boolean(actionTaskId);
        useAuto.addEventListener("click", () => void useAutoRuntime(task));
        actions.appendChild(useAuto);
      }
      for (const action of task.actions) {
        const button = createNode("button", `task-center-action${action === "cancel" ? " danger" : ""}`, actionLabel(action));
        button.type = "button";
        button.disabled = Boolean(actionTaskId);
        button.addEventListener("click", () => void applyAction(task, action));
        actions.appendChild(button);
      }
      root.appendChild(actions);
    }
    return root;
  }

  function createTaskCard(task) {
    const category = lifecycle(task);
    const card = createNode("article", "task-card");
    card.dataset.state = category === "recurring" ? "active" : task.state;
    card.dataset.taskId = task.id;
    const main = createNode("div", "task-card-main");
    const heading = createNode("div", "task-card-heading");
    heading.appendChild(createNode("div", "task-card-title", taskTitle(task)));
    const failureCount = (task.summary?.failedRuns || 0) + (task.summary?.inspection?.failed || 0);
    if (failureCount > 0 || (task.members || [task]).some(item => item.check?.error)) {
      const dot = createNode("span", "task-package-failure-dot");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", translate("tasks.summary.hasFailures", "Failure records available"));
      dot.title = translate("tasks.summary.hasFailures", "Failure records available"); heading.appendChild(dot);
    }
    const business = overview.businessStatus(task);
    heading.appendChild(createNode("span", "task-state-pill", business
      ? translate(`tasks.business.${business}`, business) : stateLabel(task.state)));
    main.appendChild(heading);
    if (business) addMetaRow(main, translate("tasks.business.reason", "Current condition"),
      translate(`tasks.condition.${(task.check?.reason || '').replaceAll(' ', '_')}`, ""));
    const brief = (task.prompt || "").split(/\n/).map(line => line.trim()).find(line => line && !/^#|^</.test(line));
    if (brief) main.appendChild(createNode("p", "task-summary-description", brief.split(/[。！？]/)[0].slice(0, 120)));
    main.appendChild(createNode("p", "task-summary-plan", taskScheduleText(task)));
    const context = createNode("div", "task-summary-context");
    const members = task.members || [task];
    const creators = [...new Set(members.map(member => creatorName(member.createdByIdentityId)
      || translate("tasks.meta.notRecorded", "Not recorded")))];
    addMetaRow(context, translate("tasks.overview.initiator", "Initiator"), creators.join(" · "));
    const sourceId = task.package?.sourceSessionId || task.sourceSessionId;
    addMetaRow(context, translate("tasks.session.sourceDiscussion", "Original discussion (reference)"), task.package?.sourceSessionName || sessionName(sourceId),
      sourceId ? { link: `/?session=${encodeURIComponent(sourceId)}&tab=sessions` } : {});
    addMetaRow(context, translate("tasks.overview.delivery", "Results go to"), [...new Set(members.map(member => notificationText(member, { compact: true })))].join(" · "));
    if (task.kind === "recurring" && task.lifetime?.mode === "bounded") addMetaRow(context, translate("tasks.meta.lifetime", "Lifetime"), lifetimeText(task));
    if (!members.some(item => item.homeSessionId) && members.some(item => item.sessionCollection === "automations")) {
      const execution = overview.latestExecutionSession(task);
      if (execution) addMetaRow(context, translate("tasks.session.execution", "Execution Session"),
        translate("tasks.session.openLatest", "Open latest execution"),
        { link: `/?session=${encodeURIComponent(execution.sessionId)}&tab=sessions` });
      else addMetaRow(context, translate("tasks.session.execution", "Execution Session"),
        translate("tasks.session.notStarted", "Available after the first run"));
    }
    for (const member of members) if (member.homeSessionId) addMetaRow(context,
      translate("tasks.session.home", "Automation home"), translate("tasks.session.openHome", "Open automation home"),
      { link: `/?session=${encodeURIComponent(member.homeSessionId)}&tab=sessions` });
    main.appendChild(context);
    const stats = createNode("dl", "task-summary-stats");
    const latest = latestActivity(task);
    const fields = [
      ["latest", latest ? formatDateTime(latest.at) : translate("tasks.summary.noRecords", "No execution records")],
      ["next", task.nextRunAt ? formatDateTime(task.nextRunAt) : translate(task.state === "paused" ? "tasks.summary.pausedNext" : "tasks.time.none", task.state === "paused" ? "Paused" : "Not scheduled")],
      ["total", cumulativeText(task)],
      ["failures", task.summary && (task.summary.totalRuns || task.summary.inspection?.total) ? translate("tasks.summary.count", "{count} runs", { count: failureCount }) : "—"],
    ];
    for (const [key, value] of fields) {
      const field = createNode("div", "task-summary-stat"); field.dataset.metric = key;
      const amount = createNode("dd", "", value);
      if (key === "latest" && latest) amount.appendChild(createNode("span", "task-summary-result", latest.result));
      field.append(createNode("dt", "", translate(`tasks.summary.${key}`, key)), amount); stats.appendChild(field);
    }
    main.appendChild(stats);
    const detail = createNode("details", "task-trigger-history");
    detail.appendChild(createNode("summary", "", translate("tasks.summary.details", "Records and settings")));
    if (openTaskIds.has(task.id)) {
      detail.open = true; detail.appendChild(createHistory(task));
      detail.appendChild(createNode("p", "task-history-note", translate("tasks.summary.countNote", "Counts all retained executions; future plans and cancellation before execution are excluded.")));
      if (task.summary?.firstRunAt) detail.appendChild(createNode("p", "task-history-note", translate("tasks.summary.historySince", "First retained execution: {time}", { time: formatDateTime(task.summary.firstRunAt) })));
      const definitions = createNode("details", "task-definition");
      definitions.appendChild(createNode("summary", "", translate("tasks.history.settings", "Task settings")));
      definitions.open = openSettingsIds.has(task.id);
      for (const member of members) {
        const setting = createNode("details", "task-definition-record");
        setting.dataset.definitionId = member.id;
        setting.appendChild(createNode("summary", "", `${taskTitle(member)} · ${stateLabel(member.state)}`));
        const content = createNode("div", ""); setting.appendChild(content);
        if (members.length === 1 || openDefinitionIds.has(member.id)) {
          setting.open = true; content.appendChild(createTaskDefinition(member));
        }
        setting.addEventListener("toggle", () => {
          if (!setting.isConnected) return;
          if (setting.open) { openDefinitionIds.add(member.id); if (!content.childElementCount) content.appendChild(createTaskDefinition(member)); }
          else openDefinitionIds.delete(member.id);
        });
        definitions.appendChild(setting);
      }
      definitions.addEventListener("toggle", () => { if (!definitions.isConnected) return; if (definitions.open) openSettingsIds.add(task.id); else openSettingsIds.delete(task.id); });
      detail.appendChild(definitions);
      if (!executionHistory.has(task.id)) queueMicrotask(() => void loadExecutionHistory(task));
    }
    detail.addEventListener("toggle", () => {
      if (!detail.isConnected || detail.open === openTaskIds.has(task.id)) return;
      if (detail.open) openTaskIds.add(task.id); else openTaskIds.delete(task.id);
      renderTasks();
    });
    main.appendChild(detail); card.appendChild(main); return card;
  }

  function renderFlowPlan(plan) {
    const view = createNode("section", "task-flow-plan");
    view.append(createNode("h3", "", plan.title), createNode("p", "task-flow-plan-status", plan.status), createNode("p", "task-flow-plan-summary", plan.summary));
    for (const stage of plan.stages || []) {
      if (stage.connector) {
        const connector = createNode("p", "task-flow-plan-connector");
        const arrow = createNode("span", "", "↓"); arrow.setAttribute("aria-hidden", "true");
        connector.append(arrow, createNode("span", "", stage.connector)); view.appendChild(connector);
      }
      const nodes = createNode("div", "task-flow-plan-stage");
      nodes.dataset.columns = String(stage.nodes.length);
      if (stage.kind) nodes.classList.add("task-flow-plan-" + stage.kind);
      for (const node of stage.nodes) {
        const card = createNode("article", "task-flow-plan-node");
        if (node.label) card.appendChild(createNode("p", "task-flow-label", node.label));
        card.appendChild(createNode("h4", "", node.title));
        for (const line of node.lines || []) card.appendChild(createNode("p", "", line));
        nodes.appendChild(card);
      }
      view.appendChild(nodes);
    }
    if (plan.footer) view.appendChild(createNode("p", "task-flow-plan-footer", plan.footer));
    return view;
  }

  function renderFlows() {
    if (!flowsPanel) return;
    flowsPanel.replaceChildren();
    flowsPanel.lang = automationFlows.language || "";
    const groups = automationFlows.groups || [];
    flowsPanel.hidden = !groups.length && !automationFlows.unavailable;
    if (automationFlows.unavailable) {
      flowsPanel.appendChild(createNode("p", "task-history-note", flowTranslate("tasks.flows.unavailable", "Flow descriptions unavailable; task list remains available.")));
      return;
    }
    if (!groups.length) return;
    if (!groups.some(group => group.id === selectedFlow)) selectedFlow = groups[0].id;
    const nav = createNode("div", "task-flow-tabs");
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", flowTranslate("tasks.flows.title", "Automation flows"));
    for (const group of groups) {
      const button = createNode("button", "task-center-secondary", group.title || flowTranslate(`tasks.flows.${group.id}`, group.id));
      button.type = "button";
      button.setAttribute("aria-pressed", String(selectedFlow === group.id));
      button.addEventListener("click", () => { selectedFlow = group.id; renderFlows(); flowsPanel.querySelector('button[aria-pressed="true"]')?.focus(); });
      nav.appendChild(button);
    }
    const title = createNode("div", "task-flow-intro");
    title.append(createNode("h3", "", flowTranslate("tasks.flows.title", "Automation flows")), createNode("p", "", flowTranslate("tasks.flows.intro", "See when work starts, what it reads, and where results go. Current schedules are shown below.")));
    flowsPanel.append(title, nav);
    const group = groups.find(item => item.id === selectedFlow);
    const diagram = createNode("div", "task-flow-diagram");
    diagram.setAttribute("aria-label", group.title || flowTranslate(`tasks.flows.${group.id}`, group.id));
    let current = diagram;
    if (group.plan) {
      diagram.appendChild(renderFlowPlan(group.plan));
      current = createNode("details", "task-flow-current");
      const key = `current:${group.id}`; current.open = openFlowNotes.has(key);
      current.appendChild(createNode("summary", "", flowTranslate("tasks.flows.current", "Current tasks and execution records")));
      current.addEventListener("toggle", () => { if (!current.isConnected) return; if (current.open) openFlowNotes.add(key); else openFlowNotes.delete(key); });
      diagram.appendChild(current);
    }
    const source = createNode("div", "task-flow-read");
    source.appendChild(createNode("span", "task-flow-label", flowTranslate("tasks.flows.inputs", "Inputs and reuse")));
    if (group.readAt) source.appendChild(createNode("strong", "task-flow-read-time", group.readAt));
    source.appendChild(createNode("p", "", group.read));
    current.appendChild(source);
    if (group.note) {
      const scope = createNode("aside", "task-flow-scope");
      scope.append(createNode("strong", "", flowTranslate("tasks.flows.scope", "Current scope and planned changes")), createNode("p", "", group.note));
      current.appendChild(scope);
    }
    current.appendChild(createNode("p", "task-flow-reading-guide", flowTranslate("tasks.flows.readingGuide", "Read each task from start to delivery. Rows are separate tasks, not a sequence.")));
    const branches = createNode("div", "task-flow-branches");
    current.appendChild(branches); flowsPanel.appendChild(diagram);
    for (const row of group.rows || []) {
      const route = createNode("article", "task-flow-row");
      const heading = createNode("div", "task-flow-step task-flow-heading");
      heading.appendChild(createNode("span", "task-flow-label", flowTranslate("tasks.flows.start", "01 · Start")));
      heading.appendChild(createNode("h4", "", row.title));
      const linked = row.taskIds.map(id => tasks.find(task => task.id === id)).filter(Boolean);
      const background = (row.backgroundIds || []).map(id => backgroundMechanisms.find(item => item.id === id)).filter(Boolean);
      const times = [...new Set(linked.map(task => `${taskScheduleText(task, flowTranslate)} · ${overview.businessStatus(task) ? flowTranslate(`tasks.business.${overview.businessStatus(task)}`, flowState(task)) : flowState(task)}`))];
      times.push(...background.map(item => `${item.trigger} · ${flowTranslate(`tasks.background.${item.state}`, item.state)}`));
      heading.appendChild(createNode("span", "task-flow-time", times.join(" / ") || flowTranslate("tasks.flows.missing", "Task not found")));
      if (row.needsReview) route.appendChild(createNode("p", "task-flow-review", flowTranslate("tasks.flows.review", "Task definition changed or is missing; the explanation below needs review.")));
      const steps = createNode("div", "task-flow-steps");
      steps.appendChild(heading);
      for (const key of ["process", "write", "send"]) {
        const step = createNode("div", "task-flow-step");
        step.append(createNode("span", "task-flow-label", flowTranslate(`tasks.flows.${key}`, key)), createNode("p", "", row[key]));
        if (key === "write") for (const item of row.links || []) {
          // Defense in depth for read-only descriptor links; never render HTML.
          try { if (!["https:", "http:"].includes(new URL(item.url).protocol)) continue; } catch { continue; }
          const link = createNode("a", "task-flow-link", item.title);
          link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; step.appendChild(link);
        }
        if (key === "write" && row.writeDetails) {
          const detail = createNode("details", "task-flow-paths");
          detail.append(createNode("summary", "", flowTranslate("tasks.flows.paths", "File locations")), createNode("p", "", row.writeDetails));
          step.appendChild(detail);
        }
        steps.appendChild(step);
      }
      route.appendChild(steps);
      const bottom = createNode("div", "task-flow-bottom");
      if (row.note) {
        const note = createNode("p", "task-flow-note", row.note);
        bottom.appendChild(note);
      }
      const selected = linked.filter(task => task.sessionCollection === "automations");
      for (const task of selected) {
        if (selected.length > 1) bottom.appendChild(createNode("strong", "", taskTitle(task)));
        appendExecutionEntries(bottom, task, true);
      }
      if (!selected.length || linked.some(task => task.sessionCollection !== "automations")) {
        const locate = createNode("button", "task-center-action", flowTranslate("tasks.flows.locate", "Related tasks"));
        locate.type = "button"; locate.disabled = !linked.length;
        locate.addEventListener("click", () => {
          flowTaskIds = new Set(row.taskIds); selectedFilter = "all";
          closedPurposeSections.clear(); renderTasks(); selectView("tasks", { focus: true }); list.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        if (linked.length || !background.length) bottom.appendChild(locate);
      }
      if (background.length) {
        const inspect = createNode("button", "task-center-action", flowTranslate("tasks.flows.monitor", "Open monitoring overview"));
        inspect.type = "button";
        inspect.addEventListener("click", () => document.getElementById("monitoringOverviewTab")?.click());
        bottom.appendChild(inspect);
      }
      route.appendChild(bottom); branches.appendChild(route);
    }
  }

  function locateTimelineTask(task) {
    const grouped = displayTasks().find(item => item.id === task.id || item.members?.some(member => member.id === task.id));
    openTaskIds.add(grouped?.id || task.id);
    flowTaskIds = new Set([task.id]); selectedFilter = "all";
    closedPurposeSections.clear(); renderTasks(); selectView("tasks", { focus: true }); list.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function appendExecutionEntries(parent, task, collapseContext = false) {
    const actions = createNode("div", "task-entry-actions");
    const history = createNode("button", "task-center-action", flowTranslate("tasks.session.viewHistory", "View execution history"));
    history.type = "button"; history.dataset.automationEntry = "history";
    history.addEventListener("click", () => locateTimelineTask(task)); actions.appendChild(history);
    const execution = overview.latestExecutionSession(task);
    const run = createNode(execution ? "a" : "button", "task-center-action", flowTranslate("tasks.session.viewRun", "View run Session"));
    run.dataset.automationEntry = "run";
    if (execution) run.href = `/?session=${encodeURIComponent(execution.sessionId)}&tab=sessions`;
    else { run.type = "button"; run.disabled = true; }
    actions.appendChild(run); parent.appendChild(actions);
    if (collapseContext) {
      const context = createNode("details", "task-flow-runtime");
      const contextKey = `runtime:${task.id}`; context.open = openFlowNotes.has(contextKey);
      context.appendChild(createNode("summary", "", flowTranslate("tasks.flows.runtime", "How runs continue across Sessions")));
      context.addEventListener("toggle", () => { if (!context.isConnected) return; if (context.open) openFlowNotes.add(contextKey); else openFlowNotes.delete(contextKey); });
      parent.appendChild(context); parent = context;
    }
    const active = execution && ["running", "starting", "queued"].includes(execution.state);
    const timezone = task.target?.timezone || task.schedule?.timezone || "Asia/Shanghai";
    const at = Date.parse(execution?.scheduledAt || execution?.attemptedAt || "");
    const time = Number.isFinite(at) ? new Intl.DateTimeFormat(automationFlows.language || undefined, {
      timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date(at)) + " · " + timezone : flowTranslate("tasks.meta.notRecorded", "Not recorded");
    parent.appendChild(createNode("p", "task-history-note", execution
      ? flowTranslate(active ? "tasks.session.currentRun" : "tasks.session.latestRun", "", {time})
      : flowTranslate("tasks.session.noRun", "No execution Session has been created yet.")));
    parent.appendChild(createNode("p", "task-history-note task-run-transition", flowTranslate("tasks.session.transition", "Trigger → execution record → run Session → result saved in history")));
    const policy = task.target?.mode === "calendar_day_session" ? "dayReuse" : task.target?.mode === "fixed_session" ? "fixedReuse" : "separateRuns";
    parent.appendChild(createNode("p", "task-history-note task-run-policy", flowTranslate("tasks.session." + policy, "", {timezone})));
  }

  function renderTimeline() {
    if (!timelinePanel || !overview.timeline) return;
    timelinePanel.replaceChildren(); timelinePanel.hidden = !loaded || Boolean(loadError);
    if (timelinePanel.hidden) return;
    timelinePanel.lang = automationFlows.language || "";
    const tr = (key, vars) => flowTranslate("tasks.flows." + key, key, vars);
    const plan = overview.timeline(tasks);
    timelinePanel.append(createNode("h3", "", tr("timeline")), createNode("p", "task-timeline-note", tr("timelineNote")),
      createNode("p", "task-timeline-count", tr("scope", { recurring: plan.recurringCount, once: plan.once.length, background: backgroundMechanisms.length })));
    const descriptions = task => (automationFlows.groups || []).flatMap(group =>
      (group.rows || []).filter(row => row.taskIds.includes(task.id)).map(row => ({ ...row, group: group.id })));
    const stamp = value => {
      const date = new Date(value || "");
      return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(automationFlows.language || undefined,
        { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) + " · Asia/Shanghai" : tr("noTime");
    };
    const taskRow = (task, key) => {
      const rows = descriptions(task), details = createNode("details", "task-timeline-task");
      details.dataset.taskId = task.id; details.open = openTimelineRows.has(key);
      const summary = createNode("summary");
      const main = createNode("span", "task-timeline-main");
      main.append(createNode("strong", "", taskTitle(task)), createNode("small", "", task.gate?.mode === "script" ? tr("gate") : tr("direct")));
      summary.append(main, createNode("span", "task-timeline-status", flowState(task))); details.appendChild(summary);
      const body = createNode("div", "task-timeline-detail");
      body.appendChild(createNode("p", "", tr("next", { time: stamp(task.nextRunAt) })));
      if (rows.length) for (const row of rows) {
        if (row.needsReview) body.appendChild(createNode("p", "task-flow-review", flowTranslate("tasks.flows.review")));
        body.append(createNode("p", "", tr("writeLabel") + " · " + row.write), createNode("p", "", tr("sendLabel") + " · " + row.send));
      } else {
        body.append(createNode("p", "", tr("unknownOutput")), createNode("p", "", tr("sendLabel") + " · " + notificationText(task, { compact: true, tr: flowTranslate })));
      }
      if (task.sessionCollection === "automations") appendExecutionEntries(body, task);
      else {
        const button = createNode("button", "task-center-action", tr("showTasks")); button.type = "button";
        button.addEventListener("click", () => locateTimelineTask(task)); body.appendChild(button);
      }
      details.appendChild(body);
      details.addEventListener("toggle", () => { if (!details.isConnected) return; if (details.open) openTimelineRows.add(key); else openTimelineRows.delete(key); });
      return details;
    };
    const section = (label, entries, renderer) => {
      const root = createNode("section", "task-timeline-section"); root.appendChild(createNode("h4", "", label));
      const line = createNode("div", "task-timeline-line"); root.appendChild(line);
      for (const [i, entry] of entries.entries()) {
        const row = createNode("div", "task-timeline-entry"); renderer(row, entry, i); line.appendChild(row);
      }
      if (!entries.length) line.appendChild(createNode("p", "task-timeline-note", tr("empty")));
      timelinePanel.appendChild(root);
    };
    section(tr("daily"), plan.daily, (row, entry) => {
      const time = createNode("div", "task-timeline-time", entry.time); time.appendChild(createNode("small", "", entry.timezone));
      const items = createNode("div", "task-timeline-items"); entry.tasks.forEach(task => items.appendChild(taskRow(task, entry.time + task.id)));
      row.append(time, items);
    });
    section(tr("cycle"), plan.repeating, (row, task) => {
      row.append(createNode("div", "task-timeline-time task-timeline-cadence", taskScheduleText(task, flowTranslate)), taskRow(task, task.id));
    });
    section(tr("once"), plan.once, (row, task) => {
      row.append(createNode("div", "task-timeline-time task-timeline-cadence", stamp(task.schedule?.scheduledAt)), taskRow(task, task.id));
    });
    const background = createNode("details", "task-timeline-background"); background.open = openTimelineRows.has("background");
    background.appendChild(createNode("summary", "", tr("background") + " · " + backgroundMechanisms.length));
    for (const item of backgroundMechanisms) {
      const row = createNode("div", "task-timeline-background-row"); row.dataset.backgroundId = item.id;
      row.append(createNode("strong", "", item.title), createNode("span", "", item.trigger),
        createNode("small", "", flowTranslate("tasks.background." + item.state, item.state)));
      background.appendChild(row);
    }
    background.addEventListener("toggle", () => { if (!background.isConnected) return; if (background.open) openTimelineRows.add("background"); else openTimelineRows.delete("background"); });
    timelinePanel.append(background, createNode("p", "task-timeline-note", tr("inactive") + " · " + plan.stopped.length), createNode("p", "task-timeline-note", tr("coverage")));
  }

  function renderTasks() {
    if (!list) return;
    list.replaceChildren();
    renderTimeline();
    renderFlows();
    renderViews();
    if (loading && !loaded) { list.appendChild(createNode("div", "task-center-empty", translate("tasks.loading", "Loading automations…"))); return; }
    if (loadError && tasks.length === 0) { list.appendChild(createNode("div", "task-center-empty", loadError)); return; }
    const filter = selectedFilter;
    const grouped = displayTasks();
    for (const button of filterSelect?.querySelectorAll("[data-task-filter]") || []) {
      const value = button.dataset.taskFilter;
      const count = grouped.filter(task => value === "all" || lifecycle(task) === value).length;
      button.textContent = translate(value === "all" ? "tasks.filter.all" : `tasks.overview.${value}`, value) + ` (${count})`;
      button.setAttribute("aria-pressed", String(value === filter));
    }
    if (flowTaskIds) {
      const clear = createNode("button", "task-center-secondary", translate("tasks.flows.clear", "Show all tasks"));
      clear.type = "button"; clear.addEventListener("click", () => { flowTaskIds = null; renderTasks(); });
      list.appendChild(clear);
    }
    let visibleCount = 0;
    for (const purpose of overview.displayPurposes) {
      const visible = grouped.filter(task => (filter === "all" || lifecycle(task) === filter) && overview.displayPurpose(task) === purpose && (!flowTaskIds || (task.members || [task]).some(member => flowTaskIds.has(member.id))));
      if (!visible.length) continue;
      visibleCount += visible.length;
      const section = createNode("details", "task-lifecycle-section"); section.dataset.purpose = purpose;
      const title = translate(`tasks.flows.${purpose}`, purpose) + ` (${visible.length})`;
      section.appendChild(createNode("summary", "task-lifecycle-heading", title));
      if (!closedPurposeSections.has(purpose)) {
        section.open = true;
        const cards = createNode("div", "task-lifecycle-cards");
        const limit = visibleTaskLimits.get(purpose) || 40;
        for (const task of visible.slice(0, limit)) cards.appendChild(createTaskCard(task));
        if (visible.length > limit) {
          const more = createNode("button", "task-center-secondary", translate("tasks.history.moreTasks", "More tasks")); more.type = "button";
          more.addEventListener("click", () => { visibleTaskLimits.set(purpose, limit + 40); renderTasks(); }); cards.appendChild(more);
        }
        section.appendChild(cards);
      }
      section.addEventListener("toggle", () => {
        if (!section.isConnected || section.open === !closedPurposeSections.has(purpose)) return;
        if (section.open) closedPurposeSections.delete(purpose); else closedPurposeSections.add(purpose);
        renderTasks();
      });
      list.appendChild(section);
    }
    if (!visibleCount) list.appendChild(createNode("div", "task-center-empty", translate(tasks.length ? "tasks.emptyFiltered" : "tasks.empty", tasks.length ? "No automations match this filter." : "No automations yet.")));
    if (filter === "all" && backgroundMechanisms.length) {
      const section = createNode("details", "task-lifecycle-section");
      section.dataset.background = "true";
      section.appendChild(createNode("summary", "task-lifecycle-heading", translate("tasks.background.title", "Supporting mechanisms") + ` (${backgroundMechanisms.length})`));
      section.appendChild(createNode("p", "task-history-note", translate("tasks.background.note", "Read-only source state; not counted as scheduled AI tasks.")));
      const cards = createNode("div", "task-lifecycle-cards");
      for (const mechanism of backgroundMechanisms) {
        const card = createNode("article", "task-card");
        const heading = createNode("div", "task-card-heading");
        heading.append(createNode("h4", "task-card-title", mechanism.title), createNode("span", "task-state-pill",
          translate(`tasks.background.${mechanism.state}`, mechanism.state)));
        card.appendChild(heading);
        card.appendChild(createNode("p", "task-summary-plan", mechanism.trigger));
        if (mechanism.note) card.appendChild(createNode("p", "task-history-note", mechanism.note));
        cards.appendChild(card);
      }
      section.appendChild(cards); list.appendChild(section);
    }
  }

  async function refreshTasks({ force = false } = {}) {
    if (loading || actionTaskId) return tasks;
    loading = true;
    loadError = "";
    if (refreshButton) refreshButton.disabled = true;
    renderTasks();
    try {
      const payload = await fetchJsonOrRedirect("/api/automation-tasks", {
        cache: force ? "no-store" : "default",
        revalidate: false,
      });
      tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
      backgroundMechanisms = Array.isArray(payload?.backgroundMechanisms) ? payload.backgroundMechanisms : [];
      automationFlows = payload?.automationFlows || { groups: [] };
      executionHistory.clear();
      if (requestedTaskId) {
        const match = tasks.find(item => item.id === requestedTaskId || item.members?.some(member => member.id === requestedTaskId));
        if (match) { flowTaskIds = new Set([requestedTaskId, match.id]); selectedFilter = "all"; selectedView = "tasks"; openTaskIds.add(displayTasks().find(item => item.id === match.id || item.members?.some(member => member.id === match.id))?.id || match.id); }
        requestedTaskId = "";
      }
      loaded = true;
      return tasks;
    } catch (error) {
      loaded = true;
      tasks = [];
      automationFlows = { groups: [] };
      loadError = error?.message || translate("tasks.loadFailed", "Failed to load automations.");
      return tasks;
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = false;
      renderTasks();
    }
  }

  async function submitTask(event) {
    event.preventDefault();
    if (loading || !sessionSelect?.value) return;
    const kind = kindSelect?.value === "recurring" ? "recurring" : "one_time";
    let scheduledAt = "";
    if (kind === "one_time") {
      const parsed = new Date(scheduledAtInput?.value || "");
      if (!Number.isFinite(parsed.getTime())) {
        setFormStatus(translate("tasks.form.invalidTime", "Choose a valid run time."), { error: true });
        return;
      }
      scheduledAt = parsed.toISOString();
    }
    const body = {
      kind,
      runtimePolicy: runtimePolicySelect?.value === "fixed" ? "fixed" : "auto",
      ...(runtimePolicySelect?.value === "fixed" ? (() => {
        const source = activeSessions().find(entry => entry.id === sessionSelect.value);
        return { tool: source?.tool, model: source?.model, effort: source?.effort, thinking: source?.thinking === true };
      })() : {}),
      title: titleInput?.value?.trim() || "",
      prompt: promptInput?.value?.trim() || "",
      target: {
        mode: targetModeSelect?.value === "new_session" ? "new_session" : "fixed_session",
        sessionId: sessionSelect.value,
      },
      notification: {
        mode: notificationSelect?.value === "source_conversation"
          ? "source_conversation"
          : "remotelab",
      },
      ...(kind === "recurring" ? {
        schedule: cadenceSelect?.value === "interval"
          ? { type: "interval", everySeconds: Number(everySecondsInput?.value || 0) }
          : {
            type: "cron",
            cron: cronInput?.value?.trim() || "",
            timezone: timezoneInput?.value?.trim() || "Asia/Shanghai",
          },
        lifetime: lifetimeSelect?.value === "bounded"
          ? { mode: "bounded", maxExecutions: Number(maxExecutionsInput?.value || 0) }
          : { mode: "continuous" },
        gate: gateModeSelect?.value === "script"
          ? {
            mode: "script",
            runtime: gateRuntimeSelect?.value || "bash",
            source: gateSourceInput?.value || "",
            timeoutSeconds: Number(gateTimeoutInput?.value || 5),
            cooldownSeconds: Number(gateCooldownInput?.value || 0),
          }
          : { mode: "direct" },
      } : {
        scheduledAt,
      }),
    };
    loading = true;
    if (createSubmit) createSubmit.disabled = true;
    setFormStatus(translate("tasks.form.creating", "Creating automation…"));
    try {
      const payload = await fetchJsonOrRedirect("/api/automation-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        revalidate: false,
      });
      if (payload?.task?.id) tasks = [payload.task, ...tasks.filter((entry) => entry.id !== payload.task.id)];
      form.reset();
      if (cronInput) cronInput.value = "0 9 * * 1-5";
      if (timezoneInput) timezoneInput.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
      if (scheduledAtInput) scheduledAtInput.value = toLocalDateTimeInput(new Date(Date.now() + 60 * 60 * 1000));
      setFormVisible(false);
    } catch (error) {
      setFormStatus(error?.message || translate("tasks.form.createFailed", "Failed to create automation."), { error: true });
    } finally {
      loading = false;
      if (createSubmit) createSubmit.disabled = false;
      renderTasks();
    }
  }

  async function useAutoRuntime(task) {
    if (actionTaskId) return;
    actionTaskId = task.id;
    renderTasks();
    try {
      const payload = await fetchJsonOrRedirect(`/api/automation-tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimePolicy: "auto" }), revalidate: false,
      });
      tasks = tasks.map(entry => entry.id === task.id ? { ...payload.task, package: entry.package } : entry);
    } catch (error) {
      if (typeof showSystemToast === "function") showSystemToast(error.message, "error");
    } finally { actionTaskId = ""; renderTasks(); }
  }

  runtimePolicySelect?.addEventListener("change", syncRuntimeHelp);
  sessionSelect?.addEventListener("change", syncRuntimeHelp);

  createToggle?.addEventListener("click", () => setFormVisible(Boolean(form?.hidden)));
  createCancel?.addEventListener("click", () => setFormVisible(false));
  kindSelect?.addEventListener("change", syncTimingFields);
  cadenceSelect?.addEventListener("change", syncCadenceFields);
  lifetimeSelect?.addEventListener("change", syncLifetimeFields);
  gateModeSelect?.addEventListener("change", syncGateFields);
  targetModeSelect?.addEventListener("change", syncTargetFields);
  for (const button of filterSelect?.querySelectorAll("[data-task-filter]") || []) {
    button.addEventListener("click", () => { selectedFilter = button.dataset.taskFilter; flowTaskIds = null; visibleTaskLimits.clear(); renderTasks(); });
  }
  viewTabs?.addEventListener("click", event => {
    const button = event.target.closest("[data-task-view]");
    if (button) selectView(button.dataset.taskView);
  });
  viewTabs?.addEventListener("keydown", event => {
    const buttons = [...viewTabs.querySelectorAll("[data-task-view]")];
    const index = buttons.indexOf(event.target);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    selectView(buttons[next].dataset.taskView, { focus: true });
  });
  refreshButton?.addEventListener("click", () => void refreshTasks({ force: true }));
  form?.addEventListener("submit", (event) => void submitTask(event));
  globalScope.addEventListener("remotelab:localechange", () => {
    syncTargetFields();
    renderTasks();
  });

  globalScope.RemoteLabTaskCenter = {
    refresh: refreshTasks,
    onTabShown() {
      if (globalScope.RemoteLabMonitoring?.isOverview()) return globalScope.RemoteLabMonitoring.onTabShown();
      renderSessionOptions();
      if (!loaded) return refreshTasks();
      renderTasks();
      return Promise.resolve(tasks);
    },
  };
})(window);

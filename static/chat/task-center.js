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

  let tasks = [];
  let loaded = false;
  let loading = false;
  let actionTaskId = "";
  let loadError = "";

  function translate(key, fallback = key, vars = undefined) {
    const value = typeof globalScope.remotelabT === "function"
      ? globalScope.remotelabT(key, vars)
      : key;
    return value === key ? fallback : value;
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

  function taskScheduleText(task) {
    if (task?.kind === "recurring") {
      if (task.schedule?.type === "interval") {
        const seconds = task.schedule?.everySeconds || "—";
        return translate("tasks.schedule.interval", `Every ${seconds}s`, { seconds });
      }
      return `${task.schedule?.cron || "—"} · ${task.schedule?.timezone || "—"}`;
    }
    return formatDateTime(task?.schedule?.scheduledAt);
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

  function notificationText(task) {
    const notification = task?.resultDelivery || task?.notification || {};
    if (notification.mode !== "conversation") {
      return translate("tasks.notification.remotelab", "RemoteLab only");
    }
    const connector = notification.connector || translate("tasks.notification.external", "External source");
    return `${connector}${notification.sourceRouteId ? ` · ${notification.sourceRouteId}` : ""}`;
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
        tasks = tasks.map((entry) => entry.id === next.id ? next : entry);
      } else {
        await refreshTasks({ force: true });
      }
    } catch (error) {
      if (typeof showSystemToast === "function") {
        showSystemToast(error?.message || translate("tasks.action.failed", "Task update failed"), "error");
      }
    } finally {
      actionTaskId = "";
      renderTasks();
    }
  }

  function actionLabel(action) {
    return translate(`tasks.action.${action}`, action);
  }

  function createTaskCard(task) {
    const card = createNode("article", "task-card");
    card.dataset.state = task.state || "unknown";
    const main = createNode("div", "task-card-main");
    const heading = createNode("div", "task-card-heading");
    heading.appendChild(createNode("div", "task-card-title", task.title || translate("tasks.untitled", "Untitled task")));
    heading.appendChild(createNode("span", "task-state-pill", stateLabel(task.state)));
    main.appendChild(heading);
    if (task.prompt) main.appendChild(createNode("div", "task-card-prompt", task.prompt));

    const meta = createNode("div", "task-card-meta");
    const creator = creatorName(task.createdByIdentityId);
    if (creator) addMetaRow(meta, translate("tasks.meta.creator", "Creator"), creator);
    addMetaRow(
      meta,
      translate("tasks.meta.schedule", "Schedule"),
      taskScheduleText(task),
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
    }
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
    if (execution?.error || task.lastError) {
      addMetaRow(meta, translate("tasks.meta.error", "Error"), execution?.error || task.lastError);
    }
    main.appendChild(meta);
    card.appendChild(main);

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
      card.appendChild(actions);
    }
    return card;
  }

  function matchesFilter(task) {
    const filter = filterSelect?.value || "all";
    if (filter === "active") return ["active", "scheduled", "starting", "running", "accepted", "admitted"].includes(task.state);
    if (filter === "paused") return task.state === "paused";
    if (filter === "history") return ["completed", "failed", "cancelled"].includes(task.state);
    return true;
  }

  function renderTasks() {
    if (!list) return;
    list.replaceChildren();
    if (loading && !loaded) {
      list.appendChild(createNode("div", "task-center-empty", translate("tasks.loading", "Loading tasks…")));
      return;
    }
    if (loadError && tasks.length === 0) {
      list.appendChild(createNode("div", "task-center-empty", loadError));
      return;
    }
    const visible = tasks.filter(matchesFilter);
    if (visible.length === 0) {
      list.appendChild(createNode(
        "div",
        "task-center-empty",
        tasks.length === 0
          ? translate("tasks.empty", "No automated tasks yet. Create one here or schedule work from a Session.")
          : translate("tasks.emptyFiltered", "No tasks match this filter."),
      ));
      return;
    }
    for (const task of visible) list.appendChild(createTaskCard(task));
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
      loaded = true;
      return tasks;
    } catch (error) {
      loaded = true;
      tasks = [];
      loadError = error?.message || translate("tasks.loadFailed", "Failed to load tasks.");
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
    setFormStatus(translate("tasks.form.creating", "Creating task…"));
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
      setFormStatus(error?.message || translate("tasks.form.createFailed", "Failed to create task."), { error: true });
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
      tasks = tasks.map(entry => entry.id === task.id ? payload.task : entry);
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
  filterSelect?.addEventListener("change", renderTasks);
  refreshButton?.addEventListener("click", () => void refreshTasks({ force: true }));
  form?.addEventListener("submit", (event) => void submitTask(event));
  globalScope.addEventListener("remotelab:localechange", () => {
    syncTargetFields();
    renderTasks();
  });

  globalScope.RemoteLabTaskCenter = {
    refresh: refreshTasks,
    onTabShown() {
      renderSessionOptions();
      if (!loaded) return refreshTasks();
      renderTasks();
      return Promise.resolve(tasks);
    },
  };
})(window);

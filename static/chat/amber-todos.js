"use strict";

(function attachAmberTodos() {
  if (typeof bootstrapAuthInfo === "undefined" || !bootstrapAuthInfo?.person?.id) return;
  const host = document.querySelector("#sessionWorkspace .pet-quota-pilot");
  if (!host) return;
  const isAmber = () => document.documentElement.getAttribute("data-theme") === "amber";
  const path = (value) => window.remotelabResolveProductPath?.(value) || value;
  const copy = (key) => {
    const zh = { title: "我的 To do", loading: "正在读取待办…", empty: "还没有待办，可以在对话中让我添加。",
      unavailable: "待办暂时无法读取，请重试。", saveFailed: "更新失败，请重试。", refresh: "刷新", close: "收起",
      shared: "与副屏共用待办", manage: "完整管理 ↗", todo: "待开始", in_progress: "进行中", blocked: "受阻",
      done: "已完成", complete: "标记完成", restore: "恢复待办", overdue: "已逾期", due: "截止" };
    const en = { title: "My To do", loading: "Loading tasks…", empty: "No tasks yet. Ask me to add one in chat.",
      unavailable: "Could not load tasks. Please retry.", saveFailed: "Could not update. Please retry.", refresh: "Refresh", close: "Close",
      shared: "Shared with your side display", manage: "Manage tasks ↗", todo: "To do", in_progress: "In progress", blocked: "Blocked",
      done: "Completed", complete: "Mark complete", restore: "Reopen task", overdue: "Overdue", due: "Due" };
    return ((document.documentElement.lang || "").startsWith("zh") ? zh : en)[key];
  };
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const root = node("div", "amber-todos");
  const toggle = node("button", "pet-quota-pilot-button amber-todos-toggle", "To do");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "amberTodoPanel");
  const panel = node("section", "amber-todos-panel");
  panel.id = "amberTodoPanel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "amberTodoHeading");
  const header = node("div", "amber-todos-header");
  const heading = node("strong", "");
  heading.id = "amberTodoHeading";
  const refreshButton = node("button", "amber-todos-action");
  const closeButton = node("button", "amber-todos-action");
  refreshButton.type = closeButton.type = "button";
  header.append(heading, refreshButton, closeButton);
  const message = node("p", "amber-todos-message");
  message.setAttribute("role", "status");
  const list = node("div", "amber-todos-list");
  const footer = node("div", "amber-todos-footer");
  const shared = node("span", "");
  const manage = node("a", "");
  manage.href = path("/public-pages/secondary-display-studio/index.html");
  footer.append(shared, manage);
  panel.append(header, message, list, footer);
  root.append(toggle, panel);
  host.append(root);

  let items = [];
  let loaded = false;
  let requestId = 0;
  let pending = false;
  function setOpen(open, returnFocus = false) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (returnFocus) toggle.focus();
  }
  function render() {
    const openItems = items.filter((item) => item.status !== "done");
    toggle.textContent = loaded ? `To do · ${openItems.length}` : "To do";
    heading.textContent = copy("title");
    refreshButton.textContent = copy("refresh");
    closeButton.textContent = copy("close");
    shared.textContent = copy("shared");
    manage.textContent = copy("manage");
    list.replaceChildren();
    for (const item of openItems) list.append(taskRow(item));
    const completed = items.filter((item) => item.status === "done");
    if (completed.length) {
      const details = node("details", "amber-todos-completed");
      details.append(node("summary", "", `${copy("done")} · ${completed.length}`));
      for (const item of completed) details.append(taskRow(item));
      list.append(details);
    }
    if (!openItems.length && loaded && !message.textContent) message.textContent = copy("empty");
  }
  function taskRow(item) {
    const row = node("div", "amber-todo-row");
    row.dataset.status = item.status;
    const checkbox = node("input", "amber-todo-check");
    checkbox.type = "checkbox";
    checkbox.checked = item.status === "done";
    checkbox.disabled = pending;
    checkbox.setAttribute("aria-label", `${copy(checkbox.checked ? "restore" : "complete")}：${item.title}`);
    checkbox.addEventListener("change", () => void updateTask(item, checkbox));
    const body = node("div", "amber-todo-body");
    if (item.note) {
      const detail = node("details", "amber-todo-detail");
      detail.append(node("summary", "amber-todo-title", item.title), node("p", "amber-todo-note", item.note));
      body.append(detail);
    } else body.append(node("div", "amber-todo-title", item.title));
    const meta = node("div", "amber-todo-meta");
    meta.append(node("span", `amber-todo-status amber-todo-status-${item.status}`, copy(item.status)));
    if (item.dueAt && Number.isFinite(Date.parse(item.dueAt))) {
      const overdue = item.status !== "done" && Date.parse(item.dueAt) < Date.now();
      const date = new Date(item.dueAt).toLocaleString(document.documentElement.lang || undefined,
        { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      meta.append(node("span", overdue ? "amber-todo-overdue" : "", `${copy(overdue ? "overdue" : "due")} ${date}`));
    }
    if (item.progress) meta.append(node("span", "", `${item.progress.current}/${item.progress.target} ${item.progress.unit || ""}`));
    body.append(meta);
    row.append(checkbox, body);
    return row;
  }
  async function refresh() {
    if (!isAmber() || pending) return;
    const current = ++requestId;
    message.textContent = copy("loading");
    refreshButton.disabled = true;
    try {
      const response = await fetch(path("/api/display/todos"), { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const payload = await response.json();
      if (!Array.isArray(payload.items)) throw new Error("unavailable");
      if (current !== requestId || !isAmber()) return;
      items = payload.items;
      loaded = true;
      message.textContent = "";
      render();
    } catch {
      if (current === requestId && isAmber()) message.textContent = copy("unavailable");
    } finally {
      if (current === requestId) refreshButton.disabled = false;
    }
  }
  async function updateTask(item, checkbox) {
    if (pending) return;
    const checked = checkbox.checked;
    const wasDone = item.status === "done";
    pending = true;
    requestId++;
    render();
    refreshButton.disabled = true;
    message.textContent = "";
    try {
      const response = await fetch(path(`/api/display/todos/${encodeURIComponent(item.id)}`), {
        method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: checked ? "done" : "todo" }),
      });
      if (!response.ok) throw new Error("unavailable");
      const payload = await response.json();
      if (payload.item?.id !== item.id) throw new Error("unavailable");
      items = items.map((entry) => entry.id === item.id ? payload.item : entry);
    } catch {
      checkbox.checked = wasDone;
      message.textContent = copy("saveFailed");
    } finally {
      pending = false;
      refreshButton.disabled = false;
      render();
    }
  }
  toggle.addEventListener("click", () => {
    const open = panel.hidden;
    setOpen(open);
    if (open) {
      const quotaButton = host.querySelector(".pet-quota-pilot-button:not(.amber-todos-toggle)");
      if (quotaButton?.getAttribute("aria-expanded") === "true") quotaButton.click();
      void refresh();
    }
  });
  refreshButton.addEventListener("click", () => void refresh());
  closeButton.addEventListener("click", () => setOpen(false, true));
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { setOpen(false, true); event.preventDefault(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !panel.hidden) void refresh();
  });
  window.addEventListener("focus", () => { if (!panel.hidden) void refresh(); });
  window.addEventListener("remotelab:localechange", render);
  function syncTheme() {
    if (isAmber()) void refresh();
    else { requestId++; refreshButton.disabled = false; setOpen(false); }
  }
  window.addEventListener("remotelab:themechange", syncTheme);
  window.addEventListener("storage", (event) => { if (!event.key || event.key === "remotelab.theme") syncTheme(); });
  render();
  syncTheme();
})();

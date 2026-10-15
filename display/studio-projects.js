"use strict";
window.RemoteLabDisplayProjects = {
  create({ zone, controls, getState, changeState, getMetrics, isLive, isStale, deviceRender }) {
    let manualPage = 0, manualUntil = 0, selection = null;
    const labels = { running: "运行中", waiting: "等你回复", queued: "排队中", compacting: "整理上下文" };
    const node = (parent, tag, cls, value) => {
      const el = document.createElement(tag); el.className = cls; el.textContent = value;
      if (tag === "button") el.type = "button"; parent.append(el); return el;
    };
    function select(name) { manualPage = 0; manualUntil = 0; changeState({ projectSelection: name }); }
    function render() {
      const state = getState();
      controls.hidden = state.work !== "projects";
      zone.classList.toggle("display-projects", state.work === "projects");
      if (state.work !== "projects") return false;
      zone.replaceChildren(); zone.classList.remove("work-zone");
      const projects = getMetrics()?.projects;
      const available = isLive() && Array.isArray(projects);
      const selectBox = controls.querySelector("select");
      selectBox.replaceChildren(new Option("全部项目", ""));
      if (available) for (const p of projects) selectBox.add(new Option(p.name, p.name));
      if (state.projectSelection && !projects?.some(p => p.name === state.projectSelection))
        selectBox.add(new Option(`${state.projectSelection}（暂无活跃 Session）`, state.projectSelection));
      selectBox.value = state.projectSelection || "";
      controls.querySelector("input").checked = state.projectAutoRotate !== false;
      if (selection !== state.projectSelection) { selection = state.projectSelection; manualPage = 0; manualUntil = 0; }
      const header = node(zone, "div", "dp-heading", "");
      if (selection) { const back = node(header, "button", "dp-back", "‹ 项目"); back.onclick = () => select(""); }
      node(header, "span", "zone-kicker", selection || "我的项目");
      if (!available) {
        node(zone, "p", "dp-empty", "项目状态暂不可用");
        node(zone, "p", "dp-note", "请登录本人账号后刷新，或稍后重试");
        return true;
      }
      const project = projects.find(p => p.name === selection);
      const records = selection ? project?.sessions || [] : projects;
      const totalSessions = projects.reduce((n, p) => n + p.sessions.length, 0);
      node(header, "span", "dp-total", isStale() ? "更新中断 · 保留上次状态" : selection ? `${records.length} 条 Session` : `${projects.length} 个项目 · ${totalSessions} 条 Session`);
      const list = node(zone, "div", "dp-list", "");
      const footer = node(zone, "div", "dp-footer", "");
      if (!records.length) {
        node(list, "p", "dp-empty", "暂无活跃 Session");
        node(list, "p", "dp-note", "运行、排队或等你回复时会显示在这里");
        return true;
      }
      function draw(record) {
        if (selection) {
          const row = node(list, "div", "dp-session", ""); row.dataset.sessionId = record.id;
          const title = node(row, "strong", "dp-title", record.title); title.title = record.title;
          node(row, "span", "dp-status", labels[record.status] || "状态未知"); return row;
        }
        const row = node(list, "button", "dp-project", ""); row.dataset.project = record.name;
        node(row, "strong", "dp-name", record.name);
        const counts = node(row, "span", "dp-counts", "");
        node(counts, "span", "", `${record.running} 运行中`);
        node(counts, "span", record.waiting ? "dp-waiting" : "", `${record.waiting} 等你回复`);
        if (record.queued) node(counts, "span", "", `${record.queued} 排队`);
        if (record.compacting) node(counts, "span", "", `${record.compacting} 整理中`);
        node(row, "span", "dp-open", `${record.sessions.length} 条 ›`);
        row.onclick = () => select(record.name); return row;
      }
      const sample = draw(records[0]);
      const capacity = Math.max(1, Math.floor(list.clientHeight / Math.max(1, sample.offsetHeight)));
      const pages = Math.ceil(records.length / capacity);
      const auto = state.projectAutoRotate !== false && (deviceRender || Date.now() > manualUntil);
      const page = auto ? Math.floor(Date.now() / 15000) % pages : Math.min(manualPage, pages - 1);
      list.replaceChildren(); records.slice(page * capacity, (page + 1) * capacity).forEach(draw);
      const turn = direction => { manualPage = (page + direction + pages) % pages; manualUntil = Date.now() + 30000; render(); };
      const prev = node(footer, "button", "dp-page", "‹"); prev.setAttribute("aria-label", "上一页"); prev.disabled = pages === 1; prev.onclick = () => turn(-1);
      node(footer, "span", "dp-page-info", `${page * capacity + 1}–${Math.min((page + 1) * capacity, records.length)} / ${records.length} · ${page + 1}/${pages} 页`);
      const next = node(footer, "button", "dp-page", "›"); next.setAttribute("aria-label", "下一页"); next.disabled = pages === 1; next.onclick = () => turn(1);
      return true;
    }
    controls.querySelector("select").addEventListener("change", e => select(e.target.value));
    controls.querySelector("input").addEventListener("change", e => { manualPage = 0; manualUntil = 0; changeState({ projectAutoRotate: e.target.checked }); });
    // Existing metrics refresh and device redraw drive paging; no extra fetch or model.
    document.fonts.ready.then(() => { if (getState().work === "projects") render(); });
    new ResizeObserver(() => { if (getState().work === "projects") render(); }).observe(zone);
    return { render };
  }
};

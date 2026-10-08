"use strict";
(function installUsageAnalysis(globalScope) {
  const content = document.getElementById("usageAnalysisContent"), period = document.getElementById("usageAnalysisPeriod");
  const filter = document.getElementById("usageAnalysisSession"), refresh = document.getElementById("usageAnalysisRefresh");
  if (!content || !period || !filter || !refresh) return;
  let serial = 0, value = null;
  const zh = () => (document.documentElement.lang || "").startsWith("zh");
  const text = (cn, en) => zh() ? cn : en;
  const labels = { page_enter: ["进入页面", "Page entered"], session_open: ["打开对话", "Conversation opened"],
    message_submitted: ["输入被接收", "Input accepted"], page_visibility: ["前后台／离开", "Visibility changed"],
    ui_action: ["界面动作", "UI action"], content_presented: ["内容在前台呈现", "Content presented"],
    artifact_open: ["点击产物", "Artifact clicked"], artifact_access_requested: ["请求访问产物", "Artifact access requested"],
    request_state: ["输入处理结果", "Request result"], run_state: ["执行状态观测", "Execution state"], question_state: ["提问／等待状态", "Question state"],
    tool_started: ["工具开始调用", "Tool started"], tool_finished: ["工具调用返回", "Tool returned"],
    artifact_generated: ["确认生成产物", "Artifact generated"], artifact_registered: ["登记可交付文件", "Artifact registered"], artifact_attached: ["产物附加到回复", "Artifact attached"],
    web_published: ["网页发布／修改", "Website published"], delivery_state: ["外部交付回执", "Delivery receipt"],
    session_created: ["创建对话", "Conversation created"], session_linked: ["委派关联", "Delegation linked"] };
  const label = event => labels[event] ? text(...labels[event]) : event;
  const node = (tag, value = "", className = "") => {
    const element = document.createElement(tag); element.textContent = value;
    if (className) element.className = className; return element;
  };
  const time = value => value ? new Date(value).toLocaleString() : "—";
  function section(title) { const root = node("section", "", "monitoring-section"); root.appendChild(node("h3", title)); content.appendChild(root); return root; }
  function table(root, headings, rows) {
    const wrap = node("div", "", "monitoring-table-wrap"), table = node("table"), head = node("thead"), row = node("tr");
    headings.forEach(value => { const cell = node("th", value); cell.scope = "col"; row.appendChild(cell); });
    head.appendChild(row); table.appendChild(head); const body = node("tbody");
    rows.forEach(values => { const row = node("tr"); values.forEach(value => { const cell = node("td");
      if (value?.nodeType) cell.appendChild(value); else cell.textContent = String(value ?? "—"); row.appendChild(cell);
    }); body.appendChild(row); }); table.appendChild(body); wrap.appendChild(table); root.appendChild(wrap);
  }
  function render() {
    content.replaceChildren();
    if (!value) { content.appendChild(node("p", text("使用数据暂时不可用。", "Usage data unavailable."), "monitoring-note")); return; }
    const summary = section(text("实际使用动作", "Observed actions"));
    summary.appendChild(node("p", text(`采集开始：${time(value.collectionStartedAt)}。当前窗口 ${value.total} 条动作；同一事件重试只计一次。`,
      `Collection began ${time(value.collectionStartedAt)}. ${value.total} deduplicated actions in this window.`), "monitoring-note"));
    if (!value.total) summary.appendChild(node("p", text("目前尚无动作数据，使用后刷新即可查看。", "No actions yet. Use the workbench and refresh.")));
    table(summary, [text("动作", "Action"), text("次数", "Count")], Object.entries(value.byEvent).map(([key, count]) => [label(key), count]));
    const outputs = section(text("产物", "Artifacts"));
    const kinds = { web: ["网页", "Website"], image: ["图像", "Image"], document: ["文档", "Document"], table: ["表格", "Table"], audio: ["音频", "Audio"], video: ["视频", "Video"], file: ["文件", "File"] };
    const operations = { create: ["首次生成／发布", "Created / first published"], update: ["修改后发布", "Updated publication"], attach: ["附加到回复", "Attached to reply"] };
    table(outputs, [text("动作", "Action"), text("类型", "Type"), text("阶段", "Stage"), text("次数", "Count")], Object.entries(value.artifacts).map(([key, count]) => {
      const [event, kind, operation] = key.split(":"); return [label(event), text(...(kinds[kind] || [kind, kind])), text(...(operations[operation] || [operation, operation])), count];
    }));
    const path = section(text("飞书与 Web 的衔接", "Feishu and Web paths")), paths = value.paths;
    table(path, [text("窗口内观测的过程", "Observed path"), text("人＋对话数量", "Person + conversation count")], [
      [text("首条观测输入在飞书", "First observed input in Feishu"), paths.feishuStarted],
      [text("之后在 Web 打开", "Later opened in Web"), paths.webOpened],
      [text("之后在 Web 追加输入", "Later input in Web"), paths.webContinued],
      [text("Web 之后又在原飞书话题输入", "Later input in the original Feishu conversation"), paths.originalFeishuContinued],
    ]);
    path.appendChild(node("p", text(paths.scope, "Within this window, matched by the same Person and Session. This does not prove the historical starting surface or task completion."), "monitoring-note"));
    const recent = section(text("最近动作，可回到原对话", "Recent actions"));
    const catalog = typeof sessions !== "undefined" && Array.isArray(sessions) ? sessions : [];
    table(recent, [text("时间", "Time"), text("动作", "Action"), text("来源", "Surface"), text("状态／动作", "State / action"), text("对话", "Conversation")], value.events.map(event => {
      const link = event.sessionId ? node("a", catalog.find(item => item.id === event.sessionId)?.name || event.sessionId.slice(0, 8)) : "—";
      if (link?.nodeType) link.href = `/?tab=sessions&session=${encodeURIComponent(event.sessionId)}`;
      return [time(event.timestamp), label(event.event), event.surface, event.state || event.action || event.operation || "—", link];
    }));
    const coverage = section(text("采集范围", "Collection scope"));
    const cnNotes = value.coverage.notes;
    const enNotes = ["Only observed events after collection began; no historical backfill.", "Feishu delivery is not reading; Web presentation is not understanding or acceptance.",
      "Generation, publication, attachment and access are separate counts. Ordinary file writes are not automatically artifacts.", "Native questions have definite states. Implicit waiting in conversation text is not automatically detected."];
    (zh() ? cnNotes : enNotes).forEach(note => coverage.appendChild(node("p", note, "monitoring-note")));
    (value.coverage.gaps || []).forEach(gap => coverage.appendChild(node("p", text(
      `${time(gap.start)} 至 ${time(gap.end)} 存在已确认的采集缺口，该段次数可能不完整。`,
      `Known collection gap from ${time(gap.start)} to ${time(gap.end)}; counts may be incomplete.`), "monitoring-note")));
    if (value.coverage.incomplete || value.coverage.dropped || value.coverage.failures) coverage.appendChild(node("p", text("存在扫描截断或采集失败，当前次数可能不完整。", "Scan limits or collection failures mean these counts may be incomplete."), "monitoring-note"));
  }
  async function load() {
    const request = ++serial; refresh.disabled = true;
    const selected = filter.value; filter.replaceChildren(node("option", text("全部对话", "All conversations"))); filter.firstChild.value = "";
    const catalog = typeof sessions !== "undefined" && Array.isArray(sessions) ? sessions : [];
    catalog.forEach(session => { const option = node("option", session.name || session.id.slice(0, 8)); option.value = session.id; filter.appendChild(option); });
    filter.value = selected;
    try {
      const query = new URLSearchParams({ days: period.value, sessionId: filter.value, limit: "100" });
      const next = await fetchJsonOrRedirect(`/api/usage/analysis?${query}`, { revalidate: false });
      if (request === serial) { value = next; render(); }
    } catch { if (request === serial) { value = null; render(); } }
    finally { if (request === serial) refresh.disabled = false; }
  }
  refresh.addEventListener("click", () => void load()); period.addEventListener("change", () => void load()); filter.addEventListener("change", () => void load());
  globalScope.addEventListener("remotelab:localechange", () => { if (value) render(); });
  globalScope.RemoteLabUsageAnalysis = { load };
  if (new URL(location.href).searchParams.get("monitor") === "usage" && document.body.dataset.appView === "tasks") void load();
})(window);

"use strict";
(function installUsageAnalysis(globalScope) {
  const content = document.getElementById("usageAnalysisContent"), period = document.getElementById("usageAnalysisPeriod");
  const filter = document.getElementById("usageAnalysisSession"), refresh = document.getElementById("usageAnalysisRefresh");
  if (!content || !period || !filter || !refresh) return;
  let serial = 0, value = null;
  const zh = () => (document.documentElement.lang || "").startsWith("zh");
  const text = (cn, en) => zh() ? cn : en;
  const node = (tag, value = "", className = "") => {
    const element = document.createElement(tag); element.textContent = value;
    if (className) element.className = className; return element;
  };
  const time = value => value ? new Date(value).toLocaleString() : "—";
  const percent = rate => (rate * 100).toFixed(1).replace(/\.0$/, "") + "%";
  const ratio = metric => !metric.denominator ? text("暂无样本", "No samples") :
    metric.numerator + " / " + metric.denominator + (metric.rate === null ? text(" · 暂不计算比例", " · rate unavailable") : " · " + percent(metric.rate));
  const duration = (ms, reliable) => !reliable ? text("暂不计算", "Withheld") : ms === null ? text("暂无配对样本", "No paired samples") : ms < 1000 ? text("1秒以内", "Under 1 second") :
    ms < 60000 ? Math.round(ms / 1000) + text("秒", " sec") : ms < 3600000 ? (ms / 60000).toFixed(1) + text("分钟", " min") : (ms / 3600000).toFixed(1) + text("小时", " hr");
  function section(title) { const root = node("section", "", "monitoring-section"); root.appendChild(node("h3", title)); content.appendChild(root); return root; }
  function note(root, cn, en) { root.appendChild(node("p", text(cn, en), "monitoring-note")); }
  function metrics(root, entries) {
    const list = node("dl", "", "monitoring-metrics");
    entries.forEach(([label, value]) => { const item = node("div"); item.append(node("dt", label), node("dd", String(value))); list.appendChild(item); });
    root.appendChild(list);
  }
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
    const report = value?.report;
    if (!report) { content.appendChild(node("p", text("使用分析暂时不可用，请刷新重试。", "Usage analysis is unavailable. Refresh to retry."), "monitoring-note")); return; }
    content.dataset.reportVersion = String(report.schemaVersion);
    const { activity, journeys, execution, artifacts, quality } = report;
    content.appendChild(node("p", text("本次观察时段：" + time(report.since) + " 至 " + time(report.until),
      "Observed interval: " + time(report.since) + " to " + time(report.until)), "monitoring-note"));
    if (quality.afterGap) content.appendChild(node("p", text("上线初期有采集缺口，本页从恢复采集后重新汇总。", "An early collection gap exists. These summaries begin after collection recovered."), "monitoring-note"));
    if (!quality.reliable) content.appendChild(node("p", text("本次数据不完整，次数仅供回查；比例与耗时暂不计算。", "This observation is incomplete. Counts are partial; rates and timings are withheld."), "monitoring-note"));
    const adoption = section(text("有多少人在参与协作", "Who is participating"));
    metrics(adoption, [[text("参与交流人数", "People contributing"), activity.people],
      [text("参与协作的会话", "Conversations with input"), activity.sessions],
      [text("多轮交流会话", "Conversations with follow-up"), ratio(activity.multiTurn)]]);
    note(adoption, "真人交办、追加消息和回答提问计入参与人数；多轮交流只看交办和追加消息，单独的提问回答不增加轮数。",
      "Participation includes human messages and question answers. Follow-up counts use ordinary messages, excluding question controls.");
    if (!activity.sessions) note(adoption, "这一时段尚无真人交流样本，产物记录仍可独立查看。", "There are no human-input samples in this interval. Artifact observations remain available.");
    if (activity.daily.length > 1) table(adoption, [text("日期（北京时间）", "Date (UTC+8)"), text("交流人数", "People"), text("会话数", "Conversations")],
      activity.daily.map(row => [row.day, row.people, row.sessions]));
    const path = section(text("飞书与 Web 的协作是否接得上", "Does Feishu collaboration continue in Web"));
    table(path, [text("协作过程", "Collaboration path"), text("观测数 / 样本数 · 比例", "Observed / samples · rate")], [
      [text("飞书交办后打开 Web", "Opened Web after input in Feishu"), ratio(journeys.opened)],
      [text("飞书交办后在 Web 继续协作", "Continued in Web after input in Feishu"), ratio(journeys.continued)],
      [text("Web 协作后返回原飞书话题", "Returned to the original Feishu conversation"), ratio(journeys.returned)],
    ]);
    note(path, "每个人在同一会话算一次，按先后顺序关联；继续协作包括发消息和回答提问。返回比例以在 Web 继续协作的样本为分母。",
      "Each person and conversation count once. Continuation includes messages and answers. Return rate uses Web continuations as its denominator.");
    if (journeys.started < 10) note(path, "目前只有 " + journeys.started + " 个飞书协作样本，先观察，不据此判断使用习惯。",
      "Only " + journeys.started + " Feishu collaboration samples so far. Observe before drawing conclusions about habits.");
    const work = section(text("交办后的执行与等待", "Execution and waiting after handoff"));
    table(work, [text("交办关联的执行", "Executions linked to human input"), text("次数", "Count")], [
      [text("正常结束", "Ended normally"), execution.completed], [text("执行失败", "Execution failed"), execution.failed],
      [text("取消", "Cancelled"), execution.cancelled], [text("尚未记录结束", "End not yet observed"), execution.active],
    ]);
    if (execution.unknown) note(work, "另有 " + execution.unknown + " 次执行状态暂不能确定，未归入上述分类。",
      execution.unknown + " executions have an unclassified state and are excluded from these categories.");
    metrics(work, [[text("交办到执行结束的中位时间", "Median input-to-end time"), duration(execution.inputToEndMedianMs, quality.reliable)],
      [text("提出过问题的会话", "Conversations with questions"), ratio(execution.waiting.askingSessions)],
      [text("已回答提问的等待中位时间", "Median answered-question wait"), duration(execution.waiting.answerMedianMs, quality.reliable)]]);
    note(work, "耗时分别来自 " + execution.durationSamples + " 次完整执行和 " + execution.waiting.durationSamples + " 次提问／回答配对。执行结束不直接代表产物可用。",
      "Timings use " + execution.durationSamples + " paired executions and " + execution.waiting.durationSamples + " paired questions and answers. Execution ending does not establish artifact quality.");
    if (execution.waiting.raised) note(work, "本期提出 " + execution.waiting.raised + " 个问题，已回答 " + execution.waiting.answered + " 个；另有 " + execution.waiting.closed + " 个已结束或过期，" + execution.waiting.pending + " 个尚未记录回答。",
      execution.waiting.raised + " questions raised; " + execution.waiting.answered + " answered, " + execution.waiting.closed + " ended or expired, " + execution.waiting.pending + " with no answer observed.");
    const outputs = section(text("产物做了多少，有多少被主动打开", "Artifacts produced and explicitly opened"));
    const kinds = { web: ["网页", "Websites"], image: ["图像", "Images"], document: ["文档", "Documents"], table: ["表格", "Tables"], audio: ["音频", "Audio"], video: ["视频", "Video"], file: ["其他文件", "Other files"] };
    if (!artifacts.byKind.length) note(outputs, "本期尚无可以确认的产物记录。", "No verified artifact observations in this interval.");
    else table(outputs, [text("产物类型", "Type"), text("新生成／首次发布", "Generated / first published"), text("网页更新次数", "Website updates"),
      text("回复交付／发布件数", "Attached / published objects"), text("主动打开件数", "Explicitly opened objects")],
      artifacts.byKind.map(row => [text(...(kinds[row.kind] || kinds.file)), row.created, row.updates, row.provided, quality.webObserved ? row.opened : "—"]));
    if (artifacts.provided) note(outputs, "本期交付／发布的产物中，主动打开记录为 " + ratio(artifacts.opened) + "。仅统计工作台内的主动点击，不把自动图片加载算使用。",
      "Explicitly opened among this interval's attached or published objects: " + ratio(artifacts.opened) + ". Only deliberate workbench clicks count; automatic image loads do not.");
    if (execution.review.length) {
      const review = section(text("可以回看的协作", "Conversations to review"));
      const reasons = { execution_failed: ["执行出现失败", "Execution failed"], answer_not_observed: ["提问尚未记录回答", "Answer not observed"] };
      const catalog = typeof sessions !== "undefined" && Array.isArray(sessions) ? sessions : [];
      table(review, [text("会话", "Conversation"), text("回看线索", "Reason to review"), text("最近相关时间", "Latest relevant time")], execution.review.map(item => {
        const link = node("a", catalog.find(session => session.id === item.sessionId)?.name || text("查看会话", "Open conversation"));
        link.href = "/?tab=sessions&session=" + encodeURIComponent(item.sessionId);
        return [link, item.reasons.map(reason => text(...reasons[reason])).join(text("；", "; ")), time(item.latestAt)];
      }));
    }
    const definitions = section(text("统计说明", "Measurement notes")), details = node("details");
    details.appendChild(node("summary", text("查看口径与覆盖范围", "Definitions and coverage"))); definitions.appendChild(details);
    note(details, "使用人数按已核的真人身份去重，排除 Agent、自动化和后台操作；会话数按有真人输入的会话去重。",
      "People counts deduplicate verified human identities. Agent, automation and system operations are excluded. Conversations require human input.");
    note(details, "跨入口路径只代表本期看到的同一人、同一会话，不代表完整历史首发或任务完成。没有分母、配对或完整数据时显示未知。",
      "Paths describe the same person and conversation in this interval, not historical origin or business completion. Missing denominators, pairs or complete data remain unknown.");
    note(details, "网页按一个站点计件，修改另外计次数；文件附在回复中不能证明本次新生成。— 表示未覆盖该统计或尚无数据，不等于零。",
      "Websites count once per site, with updates counted separately. Attachment does not establish new generation. A dash means unsupported or unavailable, not zero.");
    note(details, "目前还不能直接判断满意度、隐含的等人判断或成果是否被真正复用；这些仍需原反馈和任务验收。",
      "Satisfaction, implicit human decisions and actual reuse require original feedback and task acceptance; they are not inferred here.");
    if (activity.unidentifiedInputs) note(details, "另有 " + activity.unidentifiedInputs + " 条真人输入缺少可关联身份，未计入人数。",
      activity.unidentifiedInputs + " human inputs lack a linkable identity and are excluded from people counts.");
    if (artifacts.otherOpened) note(details, "另有 " + artifacts.otherOpened + " 件产物的主动点击未关联到本期交付，不放进本期产物打开率。",
      artifacts.otherOpened + " explicitly clicked objects cannot be linked to this interval's delivery cohort and are excluded from its open rate.");
  }
  async function load() {
    const request = ++serial; refresh.disabled = true;
    const selected = filter.value; filter.replaceChildren(node("option", text("全部对话", "All conversations"))); filter.firstChild.value = "";
    const catalog = typeof sessions !== "undefined" && Array.isArray(sessions) ? sessions : [];
    catalog.forEach(session => { const option = node("option", session.name || text("未命名会话", "Unnamed conversation")); option.value = session.id; filter.appendChild(option); });
    filter.value = selected;
    try {
      const query = new URLSearchParams({ days: period.value, sessionId: filter.value, limit: "1" });
      const next = await fetchJsonOrRedirect("/api/usage/analysis?" + query, { revalidate: false });
      if (request === serial) { value = next; render(); }
    } catch { if (request === serial) { value = null; render(); } }
    finally { if (request === serial) refresh.disabled = false; }
  }
  refresh.addEventListener("click", () => void load()); period.addEventListener("change", () => void load()); filter.addEventListener("change", () => void load());
  globalScope.addEventListener("remotelab:localechange", () => { if (value) render(); });
  globalScope.RemoteLabUsageAnalysis = { load };
  if (new URL(location.href).searchParams.get("monitor") === "usage" && document.body.dataset.appView === "tasks") void load();
})(window);

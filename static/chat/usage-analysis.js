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
    if (quality.afterGap) content.appendChild(node("p", text("本期发生过采集缺失，本页只汇总最近一次恢复采集后的连续记录；缺失时段没有补成零。", "Collection gaps exist. These summaries cover the continuous interval after the latest recovery; missing intervals are not filled with zeros."), "monitoring-note"));
    const observedMs = Date.parse(report.until) - Date.parse(report.since), requestedMs = Number(period.value) * 86400000;
    if (observedMs < requestedMs - 60000) content.appendChild(node("p", text(
      "所选范围为近 " + period.value + " 天，目前实际可用数据只有约 " + duration(observedMs, true) + "；尚不代表完整的 " + period.value + " 天使用情况。",
      "The selected range is " + period.value + " days, but only about " + duration(observedMs, true) + " of collected observations are available."), "monitoring-note"));
    if (!quality.reliable) content.appendChild(node("p", text("本次数据不完整，次数仅供回查；比例与耗时暂不计算。", "This observation is incomplete. Counts are partial; rates and timings are withheld."), "monitoring-note"));
    if (value.coverage?.excludedFixtureLines) content.appendChild(node("p", text("已排除经核实的测试事件；正式使用记录和排除依据仍保留。",
      "Verified test fixtures are excluded; original observations and exclusion evidence are retained."), "monitoring-note"));
    const adoption = section(text("有多少人在参与协作", "Who is participating"));
    metrics(adoption, [[text("参与交流人数", "People contributing"), activity.people],
      [text("参与协作的会话", "Conversations with input"), activity.sessions],
      [text("多轮交流会话", "Conversations with follow-up"), ratio(activity.multiTurn)]]);
    note(adoption, "真人交办、追加消息和回答提问计入参与人数；多轮交流只看交办和追加消息，单独的提问回答不增加轮数。",
      "Participation includes human messages and question answers. Follow-up counts use ordinary messages, excluding question controls.");
    if (!activity.sessions) note(adoption, "这一时段尚无真人交流样本，产物记录仍可独立查看。", "There are no human-input samples in this interval. Artifact observations remain available.");
    if (activity.daily.length > 1) table(adoption, [text("日期（北京时间）", "Date (UTC+8)"), text("交流人数", "People"), text("会话数", "Conversations")],
      activity.daily.map(row => [row.day, row.people, row.sessions]));
    if (report.functions) renderFunctions(report.functions);
    const path = section(text("飞书与 Web 的协作是否接得上", "Does Feishu collaboration continue in Web"));
    table(path, [text("协作过程", "Collaboration path"), text("观测数 / 样本数 · 比例", "Observed / samples · rate")], [
      [text("飞书发起的会话，本期在 Web 打开", "Feishu-origin conversations opened in Web this interval"), ratio(journeys.opened)],
      [text("飞书发起的会话，本期在 Web 继续协作", "Feishu-origin conversations continued in Web this interval"), ratio(journeys.continued)],
      [text("Web 协作后返回原飞书话题", "Returned to the original Feishu conversation"), ratio(journeys.returned)],
    ]);
    note(path, "会话最初来源以原始请求记录为准，老会话也计入；每个人在同一会话算一次。继续协作包括发消息和回答提问，返回比例以在 Web 继续协作的样本为分母。",
      "Origin comes from the original request, including older conversations. Each person and conversation count once. Continuation includes messages and answers; return rate uses Web continuations.");
    if (journeys.unknownOrigins) note(path, "另有 " + journeys.unknownOrigins + " 组参与记录暂不能确认会话最初来源，未计入跨端比例。",
      journeys.unknownOrigins + " participating person/conversation pairs have an unknown origin and are excluded from cross-surface rates.");
    if (journeys.started < 10) note(path, "目前只有 " + journeys.started + " 个飞书协作样本，先观察，不据此判断使用习惯。",
      "Only " + journeys.started + " Feishu collaboration samples so far. Observe before drawing conclusions about habits.");
    if (report.feishuCards) renderFeishuCards(report.feishuCards);
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
    note(details, "跨入口动作只统计本期看到的同一人、同一会话；会话最初来源从原始请求确认，历史消息不补入本期次数。没有分母、配对或可靠来源时保留未知。",
      "Actions cover the same person and conversation in this interval. Origin is verified from the original request; historical messages are not added to interval counts. Missing denominators, pairs or reliable origins remain unknown.");
    note(details, "网页按一个站点计件，修改另外计次数；文件附在回复中不能证明本次新生成。— 表示未覆盖该统计或尚无数据，不等于零。",
      "Websites count once per site, with updates counted separately. Attachment does not establish new generation. A dash means unsupported or unavailable, not zero.");
    note(details, "目前还不能直接判断满意度、隐含的等人判断或成果是否被真正复用；这些仍需原反馈和任务验收。",
      "Satisfaction, implicit human decisions and actual reuse require original feedback and task acceptance; they are not inferred here.");
    if (activity.unidentifiedInputs) note(details, "另有 " + activity.unidentifiedInputs + " 条真人输入缺少可关联身份，未计入人数。",
      activity.unidentifiedInputs + " human inputs lack a linkable identity and are excluded from people counts.");
    if (artifacts.otherOpened) note(details, "另有 " + artifacts.otherOpened + " 件产物的主动点击未关联到本期交付，不放进本期产物打开率。",
      artifacts.otherOpened + " explicitly clicked objects cannot be linked to this interval's delivery cohort and are excluded from its open rate.");
  }
  function renderFeishuCards(data) {
    const root = section(text("飞书卡片有没有阅读信号，过程被展开多少次", "Feishu card read signals and process clicks"));
    const totals = data.totals;
    if (!data.byUser.length) note(root, "这一时段还没有卡片阅读或点击记录；这不代表用户没有看。",
      "No card read or click observations in this interval. This does not establish that nobody viewed a card.");
    else {
      metrics(root, [[text("已读记录", "Observed reads"), totals.readCards],
        [text("过程展开次数", "Process expand clicks"), totals.expandClicks],
        [text("展开过的卡片记录", "Cards expanded per user"), totals.expandedCards],
        [text("过程折叠次数", "Process collapse clicks"), totals.collapseClicks]]);
      table(root, [text("用户选择的投递方式", "Delivery choice"), text("有效选择次数", "Accepted selections")], [
        [text("卡片＋新消息", "Card and new messages"), totals.deliveryChoices.messages],
        [text("只更新卡片", "Only update the card"), totals.deliveryChoices.card],
        [text("恢复默认", "Restore default"), totals.deliveryChoices.default],
      ]);
    }
    note(root, "飞书已读不代表认真看完。群卡片展示共享，别人展开后直接阅读不会产生本人的展开点击；没有点击不能当作不喜欢看过程。",
      "A read signal does not establish careful reading. Group card state is shared, so viewing another person's expansion creates no personal expand click. Missing clicks do not establish a preference.");
    if (data.partial) note(root, "卡片数据存在采集缺失或采样失败，次数可能不完整；不据此计算阅读率或推荐偏好。",
      "Collection or sampling gaps make card counts partial. No reading rate or preference recommendation is inferred.");
    const sampling = data.sampling, details = node("details");
    details.appendChild(node("summary", text("查看卡片采样状态与统计口径", "Card sampling and measurement notes"))); root.appendChild(details);
    note(details, "记录涉及 " + data.people.verified + " 位已关联用户、" + data.people.unlinked + " 个尚未关联的应用内身份；未关联身份不跨应用合并，也不加到上方交流人数。",
      "Observations include " + data.people.verified + " linked people and " + data.people.unlinked + " unlinked app identities. Unlinked identities are not merged across apps or added to input participation counts.");
    note(details, "已读和展开过的卡片按同一人、同一卡片去重：一张卡片被两个人看，记两条已读。展开次数保留每次有效点击，回调重试不重复计数。0 只表示没有记录到该动作。",
      "Reads and expanded cards deduplicate each person/card pair; two readers of one card count twice. Expand clicks count accepted actions, excluding callback retries. Zero means no observed action.");
    if (data.firstObservedAt) note(details, "本窗口首次记录到卡片行为：" + time(data.firstObservedAt) + "。旧记录未补齐，已读按本期首次采集到信号计数，实际阅读时间可能更早。",
      "First card observation in this window: " + time(data.firstObservedAt) + ". Historical records are incomplete; reads count first collected signals and may have occurred earlier.");
    if (totals.rejectedClicks) note(details, "另有 " + totals.rejectedClicks + " 次点击被拒绝，未计入有效点击。",
      totals.rejectedClicks + " rejected clicks are excluded from accepted actions.");
    if (!sampling.started) note(details, "后台采样尚无状态记录，阅读覆盖范围暂不能确认。", "No background sampling state is available; reading coverage is unknown.");
    if (sampling.routes.length) table(details, [text("飞书来源", "Feishu source"), text("纳入采样的卡片", "Cards tracked for sampling"),
      text("不可采集／待完成分页／错误", "Unavailable / paginating / errors"), text("最近采样", "Last checked")],
      sampling.routes.map(row => [row.sourceRouteId, row.sampledCards, row.unavailable + " / " + row.pendingPages + " / " + row.failures, time(row.lastCheckedAt)]));
    note(details, "这里显示整个实例当前的后台状态，不受所选会话或日期筛选。只查询机器人近七天发送且留有回执的卡片；尚未检查、过期或失败的卡片都不能判为未读。",
      "This is current instance-wide background state, independent of the selected conversation or dates. Only receipted Bot cards sent within seven days are sampled. Unchecked, expired or failed cards are not classified as unread.");
  }
  function renderFunctions(data) {
    const usage = section(text("哪些功能正在被使用", "Which capabilities are used"));
    if (data.featureStartedAt) note(usage, "能力入口的新增采集从 " + time(data.featureStartedAt) + " 开始；早于此时的调用没有回填。",
      "Expanded entry observations start at " + time(data.featureStartedAt) + "; earlier calls are not backfilled.");
    if (data.features.length) table(usage, [text("能力", "Capability"), text("已关联交办人", "Linked contributors"), text("会话", "Conversations"),
      text("调用次数", "Calls"), text("入口执行完成", "Entry completed"), text("失败／受阻", "Failed / blocked"), text("进行中／结果未知", "Active / unknown")],
      data.features.map(row => [text(...row.title), row.people || (row.unattributed ? "—" : 0), row.sessions || "—", row.calls,
        row.completed, row.failed + " / " + row.blocked, row.unfinished + " / " + row.unknown]));
    else note(usage, "扩展采集尚无能力调用样本。没有出现在表中的功能，可能尚无样本或尚未接入，不能据此判断没人用。",
      "No expanded capability samples yet. An absent capability may have no samples or lack instrumentation; it does not establish non-use.");
    note(usage, "按明确的能力调用计次，重复回执不加次数；终端命令不计成产品功能。自动化也可能调用这些能力，交办人数只关联已核真人。入口执行完成不等于业务成果验收。",
      "Count explicit capability calls, deduplicating receipts and excluding generic shell commands. Automation may also invoke capabilities. Contributors require verified human links. Entry completion is not business acceptance.");
    const retries = data.features.reduce((sum, row) => sum + row.retryAttempts, 0);
    if (retries) note(usage, "其中明确复用同一幂等标识的重试有 " + retries + " 次，已从调用件数中分开。",
      retries + " retries reuse explicit idempotency keys and are separate from logical call counts.");
    const behavior = section(text("历史协作是否被继续，人怎样介入", "Returning to work and human intervention"));
    metrics(behavior, [[text("回看本期之前已有的会话", "Older conversations opened"), data.revisits.opened],
      [text("在已有会话继续发消息或回答", "Older conversations continued"), data.revisits.continued],
      [text("参与历史协作的人", "People revisiting older work"), data.revisits.people]]);
    const interventions = { follow_up: ["执行中追加输入", "Input forwarded during execution"], stop: ["主动停止执行", "Stop applied"],
      runtime_change: ["调整模型或运行设置", "Runtime settings changed"], question_answer: ["回答执行中的提问", "Native question answered"] };
    if (data.interventions.length) table(behavior, [text("人工动作", "Human action"), text("次数", "Actions"), text("会话", "Conversations")],
      data.interventions.map(row => [text(...interventions[row.operation]), row.actions, row.sessions]));
    note(behavior, "回看按原始请求时间确认，会话打开与继续交流分别统计；不把它当作用户留存率。停止、追加消息和改模型都是实际动作，不能直接推断不满意。",
      "Revisits use original request times, separating opening from continued input. This is not a retention rate. Stops, follow-ups and runtime changes do not establish dissatisfaction.");
    if (data.revisits.unknownOrigins) note(behavior, "另有 " + data.revisits.unknownOrigins + " 个会话缺少可靠起始记录，未归入历史回访。",
      data.revisits.unknownOrigins + " conversations lack reliable origin records and are excluded from historical revisits.");
    const automation = section(text("自动化是否持续执行，结果能否送达", "Automation execution and delivery"));
    const changes = { create: ["创建", "Created"], update: ["修改", "Edited"], pause: ["暂停", "Paused"], resume: ["恢复", "Resumed"], cancel: ["取消", "Cancelled"], delete: ["删除配置", "Configuration removed"] };
    if (data.automation.byAction.length) table(automation, [text("自动化配置动作", "Automation changes"), text("次数", "Count")],
      data.automation.byAction.map(row => [text(...(changes[row.operation] || changes.update)), row.actions]));
    const runs = data.automation.executions, deliveries = data.delivery;
    metrics(automation, [[text("自动触发的执行", "Automation executions"), runs.observed],
      [text("正常结束／失败", "Ended / failed"), runs.completed + " / " + runs.failed],
      [text("投递成功／失败／未知", "Delivered / failed / unknown"), deliveries.delivered + " / " + deliveries.failed + " / " + deliveries.unknown],
      [text("投递重试后恢复", "Delivery recovered"), deliveries.recovered]]);
    note(automation, "自动执行只数已接收的实际请求，不数后台巡检。投递按一份结果去重，重试另外记录；正常结束不等于业务完成，飞书送达不等于已读。",
      "Executions require accepted automation requests, excluding background checks. Deliveries deduplicate logical results with retries tracked separately. Ending is not business completion; Feishu delivery is not reading.");
    const support = section(text("材料、知识与分工怎样参与协作", "Materials, knowledge and delegated work"));
    const kinds = { image: ["图像", "Images"], audio: ["音频", "Audio"], video: ["视频", "Video"], document: ["文档", "Documents"], table: ["表格", "Tables"], file: ["其他文件", "Other files"] };
    if (data.materials.length) table(support, [text("输入材料", "Submitted material"), text("材料件数", "Objects"), text("会话", "Conversations")],
      data.materials.map(row => [text(...(kinds[row.kind] || kinds.file)), row.files, row.sessions]));
    metrics(support, [[text("知识返回给执行器", "Knowledge delivered to Harness"), data.knowledge.retrieved],
      [text("知识更新生效／被拒绝", "Knowledge updates applied / rejected"), data.knowledge.applied + " / " + data.knowledge.rejected],
      [text("分支／委派会话", "Forks / delegated conversations"), data.delegation.forks + " / " + data.delegation.delegated],
      [text("委派执行正常结束／失败", "Delegated execution ended / failed"), data.delegation.completed + " / " + data.delegation.failed],
      [text("分工会话被真人打开", "Child conversations opened by people"), data.delegation.opened]]);
    note(support, "材料接收不代表已处理，知识返回不代表已正确采用，子会话结束不代表结果已回到主任务。无法确认的处理、采纳和结果回收保留未知。",
      "Submitted materials are not necessarily processed, delivered knowledge is not necessarily followed, and a child run ending does not prove handoff to its parent.");
    note(support, "新增能力采集覆盖 RemoteLab 的明确命令入口和已识别的原生工具；绕过这些入口的外部脚本、直接文件写入、语音合成及直接飞书文档工具尚未完整覆盖。",
      "Expanded observations cover explicit RemoteLab commands and recognized native tools. External scripts, direct file writes, speech synthesis and direct Feishu document tools remain incompletely covered.");
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

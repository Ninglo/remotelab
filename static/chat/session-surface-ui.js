function t(key, vars) {
  return window.remotelabT ? window.remotelabT(key, vars) : key;
}

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function getShortFolder(folder) {
  return (folder || "").replace(/^\/Users\/[^/]+/, "~");
}

function getFolderLabel(folder) {
  const shortFolder = getShortFolder(folder);
  return shortFolder.split("/").pop() || shortFolder || t("session.defaultName");
}

function getSessionDisplayName(session) {
  return session?.name || getFolderLabel(session?.folder) || t("session.defaultName");
}

function formatQueuedMessageTimestamp(stamp) {
  if (!stamp) return t("queue.timestamp.default");
  const parsed = new Date(stamp).getTime();
  if (!Number.isFinite(parsed)) return t("queue.timestamp.default");
  return t("queue.timestamp.withTime", { time: messageTimeFormatter.format(parsed) });
}

function renderQueuedMessagePanel(session) {
  if (typeof renderWorkAwarenessPanel === "function") renderWorkAwarenessPanel(session);
  if (!queuedPanel) return;
  const items = Array.isArray(session?.queuedMessages) ? session.queuedMessages : [];
  if (!session?.id || session.id !== currentSessionId || items.length === 0) {
    queuedPanel.innerHTML = "";
    queuedPanel.classList.remove("visible", "expanded");
    delete queuedPanel.dataset.sessionId;
    return;
  }

  const preserveExpanded = queuedPanel.dataset.sessionId === session.id
    && queuedPanel.classList.contains("expanded");
  queuedPanel.innerHTML = "";
  queuedPanel.dataset.sessionId = session.id;
  queuedPanel.classList.add("visible");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "queued-panel-header";
  header.setAttribute("aria-controls", "queuedPanelDetails");

  const title = document.createElement("span");
  title.className = "queued-panel-title";

  const chevron = document.createElement("span");
  chevron.className = "queued-panel-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = renderUiIcon("chevron-down");

  const titleText = document.createElement("span");
  titleText.textContent = items.length === 1
    ? t("queue.single")
    : t("queue.multiple", { count: items.length });

  title.appendChild(chevron);
  title.appendChild(titleText);
  header.appendChild(title);
  queuedPanel.appendChild(header);

  const details = document.createElement("div");
  details.id = "queuedPanelDetails";
  details.className = "queued-panel-details";

  const note = document.createElement("div");
  note.className = "queued-panel-note";
  const activity = getSessionActivity(session);
  note.textContent = activity.run.state === "running" || activity.compact.state === "pending"
    ? t("queue.note.afterRun")
    : t("queue.note.preparing");
  details.appendChild(note);

  const list = document.createElement("div");
  list.className = "queued-list";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "queued-item";

    const meta = document.createElement("div");
    meta.className = "queued-item-meta";
    meta.textContent = formatQueuedMessageTimestamp(item.queuedAt);

    const text = document.createElement("div");
    text.className = "queued-item-text";
    text.textContent = item.text || t("queue.attachmentOnly");

    const itemHeader = document.createElement("div");
    itemHeader.className = "queued-item-header";
    itemHeader.appendChild(meta);
    if (item.requestId) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queued-item-remove";
      remove.textContent = t("queue.remove");
      remove.setAttribute("aria-label", t("queue.remove.label"));
      const errorLine = document.createElement("div");
      errorLine.className = "queued-item-error";
      errorLine.setAttribute("role", "alert");
      errorLine.hidden = true;
      remove.addEventListener("click", async () => {
        if (remove.disabled) return;
        remove.disabled = true;
        remove.textContent = t("queue.removing");
        errorLine.hidden = true;
        try {
          const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(session.id)}/queue/${encodeURIComponent(item.requestId)}`, { method: "DELETE" });
          if (!data?.session) return;
          const updated = upsertSession(data.session) || data.session;
          renderSessions();
          if (currentSessionId === session.id) renderQueuedMessagePanel(updated);
        } catch (error) {
          errorLine.textContent = error.status === 409 ? t("queue.remove.started") : t("queue.remove.failed");
          errorLine.hidden = false;
          if (error.status === 409 && currentSessionId === session.id) {
            await refreshCurrentSession().catch(() => {});
          }
        } finally {
          remove.disabled = false;
          remove.textContent = t("queue.remove");
        }
      });
      itemHeader.appendChild(remove);
      row.appendChild(errorLine);
    }
    row.appendChild(itemHeader);
    row.appendChild(text);

    const itemAttachments = Array.isArray(item?.attachments) && item.attachments.length > 0
      ? item.attachments
      : (Array.isArray(item?.images) ? item.images : []);
    const imageNames = itemAttachments.map((image) => getAttachmentDisplayName(image)).filter(Boolean);
    if (imageNames.length > 0) {
      const imageLine = document.createElement("div");
      imageLine.className = "queued-item-images";
      imageLine.textContent = t("queue.attachments", { names: imageNames.join(", ") });
      row.appendChild(imageLine);
    }

    list.appendChild(row);
  }

  details.appendChild(list);

  queuedPanel.appendChild(details);

  const setExpanded = (expanded) => {
    queuedPanel.classList.toggle("expanded", expanded);
    details.hidden = !expanded;
    header.setAttribute("aria-expanded", String(expanded));
    const actionLabel = expanded ? t("queue.collapse") : t("queue.expand");
    header.title = actionLabel;
    header.setAttribute("aria-label", `${titleText.textContent}. ${actionLabel}`);
  };
  header.addEventListener("click", () => {
    setExpanded(!queuedPanel.classList.contains("expanded"));
  });
  setExpanded(preserveExpanded);
}

let workAwarenessPanelRequest = 0;
function formatWorkAwarenessTime(value) {
  const stamp = new Date(value).getTime();
  if (!value || !Number.isFinite(stamp)) return "时间未核实";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(stamp).map(part => [part.type, part.value]));
  const zone = formatter.resolvedOptions().timeZone === "Asia/Shanghai" ? "北京时间" : parts.timeZoneName;
  return parts.year + "年" + parts.month + "月" + parts.day + "日 " + parts.hour + ":" + parts.minute + "（" + zone + "）";
}

function appendWorkAwarenessMessageTime(parent, source, label = "消息时间：", missing = "") {
  if (!source.messageTime && !source.receivedAt && !missing) return;
  const time = document.createElement("p");
  time.className = "work-awareness-meta";
  time.textContent = source.messageTime || source.receivedAt
    ? label + (source.actorName ? source.actorName + " · " : "")
      + formatWorkAwarenessTime(source.messageTime || source.receivedAt)
      + (source.messageTime ? "（发送）" : "（接收）")
    : missing;
  parent.appendChild(time);
}

function appendWorkAwarenessSource(parent, source, prefix) {
  if (!source?.sessionId) return;
  const line = document.createElement("p");
  line.className = "work-awareness-meta";
  line.appendChild(document.createTextNode(prefix + (source.location ? source.location + " · " : "")));
  const link = document.createElement("a");
  link.href = "/?session=" + encodeURIComponent(source.sessionId) + "&tab=sessions";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "《" + (source.sessionName || "来源对话") + "》 ↗";
  line.appendChild(link);
  parent.appendChild(line);
  appendWorkAwarenessMessageTime(parent, source);
}

function workSuggestionNextStep(suggestion, outgoing, needsExplanation) {
  if (suggestion.state === "approved") return suggestion.routing?.mode === "new-session"
    ? "已确认新开对话；是否已创建并开始处理，仍需看实际结果。"
    : "已经确认采用；是否执行完成，仍需看实际结果。";
  if (suggestion.state === "rejected") return "这条建议已拒绝，无需再确认。";
  if (suggestion.current === false) return "两边已有新进展，需重新核对这条旧建议；现在无需确认。";
  if (needsExplanation) return "这条建议还需补充简明说明；现在无需确认。";
  if (suggestion.state === "published") return outgoing
    ? "接收对话已可查看这条参考，你这里无需再次确认；是否采用由那边决定。"
    : "查看这条发现，决定是否用于当前任务。";
  return suggestion.explanation?.nextAction || (suggestion.routing?.mode === "new-session"
    ? "决定是否新开一个工作对话处理这件事。"
    : "决定是否同步这条信息。");
}

async function renderWorkAwarenessPanel(session) {
  const request = ++workAwarenessPanelRequest;
  let previous = document.getElementById?.("workAwarenessPanel");
  if (!session?.id || session.id !== currentSessionId || !session.workAwareness
    || (typeof shareSnapshotMode !== "undefined" && shareSnapshotMode)) {
    previous?.remove();
    return;
  }
  if (previous && previous.dataset.sessionId !== session.id) {
    previous.remove();
    previous = undefined;
  }
  try {
    const params = new URLSearchParams({ sessionId: session.id, includeBackground: "false" });
    const response = await fetch("/api/work-awareness?" + params);
    if (!response.ok) throw new Error("相关工作暂时读取失败");
    const data = await response.json();
    if (request !== workAwarenessPanelRequest || session.id !== currentSessionId) return;
    if (!data.related.length && !data.suggestions.length) { previous?.remove(); return; }
    const panel = document.createElement("details");
    panel.id = "workAwarenessPanel";
    panel.className = "work-awareness-panel";
    panel.dataset.sessionId = session.id;
    panel.open = previous?.dataset?.sessionId === session.id && previous.open === true;
    const summary = document.createElement("summary");
    summary.textContent = (data.related.length && data.suggestions.length ? "相关资料与协作建议"
      : data.related.length ? "可参考的相关资料" : "协作建议")
      + "（" + (data.related.length + data.suggestions.length) + "）";
    panel.appendChild(summary);
    const body = document.createElement("div");
    body.className = "work-awareness-body";
    const note = document.createElement("p");
    note.className = "work-awareness-note";
    note.textContent = data.related.length && data.suggestions.length ? "相关资料可直接查看；协作建议会说明是否需要你确认。"
      : data.related.length ? "这些资料可能有助于当前任务，可打开来源查看。" : "先看发现和来源，再看现在需要做什么。";
    body.appendChild(note);
    const compact = (text, limit = 72) => {
      const value = String(text || "").replace(/^【[^】]*】\s*/, "").replace(/\s+/g, " ").trim();
      return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
    };
    for (const item of data.related) {
      const row = document.createElement("article");
      row.className = "work-awareness-item";
      const header = document.createElement("div");
      header.className = "work-awareness-item-header";
      const link = document.createElement("a");
      link.className = "work-awareness-title";
      link.href = "/?session=" + encodeURIComponent(item.sessionId);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = compact(item.sessionName || item.goal);
      header.appendChild(link);
      const label = document.createElement("span");
      label.className = "work-awareness-label";
      label.textContent = ({ overlap: "工作可能重叠", dependency: "当前任务依赖它", reuse: "已有内容可参考", "same-declared-object": "处理同一对象" })[item.relation] || "相关资料";
      header.appendChild(label);
      row.appendChild(header);
      const reason = document.createElement("p");
      reason.className = "work-awareness-reason";
      reason.textContent = "为什么出现：" + (item.verification === "declared-object"
        ? "另一边处理的是同一个文件或业务对象，可以查看已有记录。"
        : item.reason || "可打开来源，核对哪些内容能用于当前任务。");
      row.appendChild(reason);
      const reading = document.createElement("p");
      reading.className = "work-awareness-reason";
      reading.textContent = "现在可做：查看资料。这里无需确认发送或采用。";
      row.appendChild(reading);
      const meta = document.createElement("p");
      meta.className = "work-awareness-meta";
      const workStatus = { active: "处理中", completed: "已登记完成", blocked: "有阻塞", recorded: "工作记录" };
      const fromSummary = item.source?.kind === "session-work-summary";
      meta.textContent = [(item.sourceInfo?.verified ? "来源：" : "当前对话入口：")
        + (item.sourceInfo?.location || "对话入口未核实"),
        fromSummary ? "AI 整理的对话摘要" : "AI 登记的工作记录", workStatus[item.status],
        item.updatedAt ? (fromSummary ? "对话记录更新于 " : "工作记录更新于 ") + formatWorkAwarenessTime(item.updatedAt) : "",
        item.archived ? "已归档" : ""].filter(Boolean).join(" · ");
      row.appendChild(meta);
      appendWorkAwarenessMessageTime(row, item.sourceInfo || {}, "登记消息：", "原始消息来源与时间未记录。");
      const details = document.createElement("details");
      const detailTitle = document.createElement("summary");
      detailTitle.textContent = "展开来源记录";
      const goal = document.createElement("p");
      goal.textContent = "来源工作的目标：" + item.goal;
      details.appendChild(detailTitle);
      details.appendChild(goal);
      if (item.results?.at(-1)?.result) {
        const result = document.createElement("p");
        result.textContent = "最近登记的结果：" + item.results.at(-1).result;
        details.appendChild(result);
      }
      if (item.sourceInfo?.excerpt) {
        const excerpt = document.createElement("p");
        excerpt.textContent = "登记时的消息（摘录）：" + item.sourceInfo.excerpt;
        details.appendChild(excerpt);
      }
      row.appendChild(details);
      body.appendChild(row);
    }
    const labels = { draft: "尚未同步", published: "已同步，尚未确认采用", approved: "已确认采用，尚需核对执行结果", rejected: "已拒绝" };
    for (const suggestion of data.suggestions) {
      const row = document.createElement("article");
      row.className = "work-awareness-item";
      const outgoing = suggestion.sourceSessionId === session.id;
      const sourceInfo = suggestion.sourceInfo || { sessionId: suggestion.sourceSessionId };
      const targetInfo = suggestion.targetInfo || { sessionId: suggestion.targetSessionId };
      const state = document.createElement("p");
      state.className = "work-awareness-label";
      state.textContent = (outgoing ? "本对话提出 · " : "来自其他对话 · ")
        + (suggestion.routing?.mode === "new-session" && suggestion.state === "draft" ? "建议新开对话，尚未确认"
          : suggestion.routing?.mode === "new-session" && suggestion.state === "approved" ? "已确认新开对话，尚需核对创建结果"
            : labels[suggestion.state] || suggestion.state);
      if (suggestion.current === false && !["approved", "rejected"].includes(suggestion.state)) state.textContent += " · 旧建议，需重新核对";
      row.appendChild(state);
      const readable = suggestion.explanation;
      const stale = suggestion.current === false;
      const needsExplanation = !readable && suggestion.content.length > 240;
      const newConversation = suggestion.routing?.mode === "new-session";
      const targetName = targetInfo.sessionName || suggestion.routing?.name || "接收对话";
      const content = document.createElement("p");
      content.className = "work-awareness-reason";
      content.textContent = readable?.summary || (suggestion.content.length <= 240 ? suggestion.content
        : "这条旧建议还没有简明说明，请先重新整理后再决定是否同步。原文保留在下方。");
      row.appendChild(content);
      if (readable) {
        const explanation = document.createElement("p");
        explanation.className = "work-awareness-reason";
        explanation.textContent = "为什么与你有关：" + readable.relevance;
        row.appendChild(explanation);
      }
      const action = document.createElement("p");
      action.className = "work-awareness-reason";
      action.textContent = "现在要做什么：" + workSuggestionNextStep(suggestion, outgoing, needsExplanation);
      row.appendChild(action);
      appendWorkAwarenessSource(row, sourceInfo, "建议来自：");
      if (newConversation) {
        const destination = document.createElement("p");
        destination.className = "work-awareness-meta";
        destination.textContent = "计划新开：《" + targetName + "》 · 处理：" + suggestion.routing.task;
        row.appendChild(destination);
      } else appendWorkAwarenessSource(row, targetInfo, suggestion.state === "draft" ? "准备同步到：" : "接收方：");
      const time = document.createElement("p");
      time.className = "work-awareness-meta";
      time.textContent = "AI 整理的建议 · " + (suggestion.draftedAt ? "整理于 " + formatWorkAwarenessTime(suggestion.draftedAt)
        : "最后更新于 " + formatWorkAwarenessTime(suggestion.updatedAt));
      if (suggestion.explanation?.updatedAt) time.textContent += " · 简明说明更新于 " + formatWorkAwarenessTime(suggestion.explanation.updatedAt);
      row.appendChild(time);
      for (const reference of suggestion.references || []) {
        if (reference.sessionId !== sourceInfo.sessionId || reference.requestId !== sourceInfo.requestId) {
          appendWorkAwarenessSource(row, reference, "依据消息来自：");
        }
      }
      const confirmation = document.createElement("p");
      confirmation.className = "work-awareness-meta";
      confirmation.textContent = stale || needsExplanation ? "" : newConversation ? (suggestion.state === "draft" ? "新开对话的确认在当前来源对话完成。" : "")
        : suggestion.state === "draft" ? "同步给《" + targetName + "》的确认在当前来源对话完成；对方收到后再决定是否采用。"
          : !outgoing && suggestion.state === "published" ? "当前对话已收录这条参考；若要用于当前任务，在这个接收对话确认采用。"
            : suggestion.state === "published" ? "已同步给《" + targetName + "》，等待对方决定是否采用。" : "";
      if (confirmation.textContent) row.appendChild(confirmation);
      const details = document.createElement("details");
      const detailTitle = document.createElement("summary");
      detailTitle.textContent = "展开原文与来源依据";
      details.appendChild(detailTitle);
      const original = document.createElement("p");
      original.textContent = suggestion.content;
      details.appendChild(original);
      const impact = document.createElement("p");
      impact.textContent = "原建议的影响说明：" + suggestion.impact;
      details.appendChild(impact);
      if (readable?.nextAction && suggestion.state !== "draft") {
        const proposal = document.createElement("p");
        proposal.textContent = "原建议的下一步：" + readable.nextAction;
        details.appendChild(proposal);
      }
      if (sourceInfo.excerpt) {
        const excerpt = document.createElement("p");
        excerpt.textContent = "触发这条建议的原需求（摘录）：" + sourceInfo.excerpt;
        details.appendChild(excerpt);
      }
      for (const reference of suggestion.references || []) {
        if (!reference.excerpt) continue;
        const excerpt = document.createElement("p");
        excerpt.textContent = "《" + reference.sessionName + "》的依据消息（摘录）：" + reference.excerpt;
        details.appendChild(excerpt);
      }
      if (suggestion.routing?.folder) {
        const folder = document.createElement("p");
        folder.textContent = "工作目录：" + suggestion.routing.folder;
        details.appendChild(folder);
      }
      row.appendChild(details);
      const command = stale || needsExplanation ? "" : suggestion.state === "draft" && outgoing
        ? "确认协作建议 " + suggestion.id + (suggestion.routing?.mode === "new-session" ? " 执行" : " 发布")
        : suggestion.state === "published" && (suggestion.targetSessionId || suggestion.sourceSessionId) === session.id ? "确认协作建议 " + suggestion.id + " 执行" : "";
      if (command && !document.querySelector?.('.native-question[data-question-state="pending"]')) {
        const control = document.createElement("button");
        control.type = "button";
        control.className = "work-awareness-action";
        const decision = newConversation ? "新开对话" : outgoing && suggestion.state === "draft" ? "同步" : "采用";
        control.textContent = "准备确认" + decision;
        control.title = "点击只把确认文字放入输入框，发送后才会确认" + decision + "。";
        control.addEventListener("click", () => {
          if (msgInput.value.trim()) return;
          msgInput.value = command;
          msgInput.dispatchEvent(new Event("input", { bubbles: true }));
          msgInput.focus();
        });
        row.appendChild(control);
      }
      body.appendChild(row);
    }
    panel.appendChild(body);
    if (previous) previous.replaceWith(panel);
    else document.getElementById("workAwarenessSlot")?.appendChild(panel);
  } catch {
    if (previous && request === workAwarenessPanelRequest && session.id === currentSessionId) previous.querySelector("summary").textContent = "相关工作读取失败，请稍后重新打开会话核对";
  }
}

function renderSessionMessageCount(session) {
  const count = Number.isInteger(session?.messageCount)
    ? session.messageCount
    : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
  if (count <= 0) return "";
  return `<span class="session-item-count" title="${esc(t("session.messagesTitle"))}">(${count})</span>`;
}

function getSessionMetaStatusInfo(session) {
  const liveStatus = getSessionStatusSummary(session).primary;
  if (liveStatus?.key && liveStatus.key !== "idle") {
    return liveStatus;
  }
  const workflowStatus = typeof window !== "undefined"
    && window.RemoteLabSessionStateModel
    && typeof window.RemoteLabSessionStateModel.getWorkflowStatusInfo === "function"
    ? window.RemoteLabSessionStateModel.getWorkflowStatusInfo(session?.workflowState)
    : null;
  return workflowStatus || liveStatus;
}

function getSessionReviewStatusInfo(session) {
  return typeof window !== "undefined"
    && window.RemoteLabSessionStateModel
    && typeof window.RemoteLabSessionStateModel.getSessionReviewStatusInfo === "function"
    ? window.RemoteLabSessionStateModel.getSessionReviewStatusInfo(session)
    : null;
}

function isSessionCompleteAndReviewed(session) {
  return typeof window !== "undefined"
    && window.RemoteLabSessionStateModel
    && typeof window.RemoteLabSessionStateModel.isSessionCompleteAndReviewed === "function"
    ? window.RemoteLabSessionStateModel.isSessionCompleteAndReviewed(session)
    : false;
}

function buildSessionMetaParts(session) {
  const parts = [];
  const countHtml = renderSessionMessageCount(session);
  if (countHtml) parts.push(countHtml);
  if (session?.deliveryIssueCount > 0) {
    parts.push(`<span class="delivery-issue-badge">${esc(t("delivery.issues", { count: session.deliveryIssueCount }))}</span>`);
  }
  return parts;
}

function renderDeliveryIssues(session) {
  const panel = document.getElementById("deliveryIssues");
  if (!panel) return;
  const issues = session?.id === currentSessionId && Array.isArray(session?.deliveryIssues) ? session.deliveryIssues : [];
  const signature = JSON.stringify([session?.id, issues]);
  if (panel.dataset.signature === signature) return;
  const expanded = panel.dataset.sessionId === session?.id && panel.querySelector("details")?.open;
  panel.dataset.signature = signature;
  panel.dataset.sessionId = session?.id || "";
  panel.replaceChildren();
  panel.hidden = issues.length === 0;
  if (!issues.length) return;
  const disclosure = document.createElement("details");
  disclosure.open = !!expanded;
  const summary = document.createElement("summary");
  summary.textContent = t("delivery.issues", { count: issues.length });
  disclosure.append(summary);
  const note = document.createElement("p");
  note.textContent = t("delivery.note");
  disclosure.append(note);
  for (const issue of issues) {
    const row = document.createElement("p");
    row.textContent = [issue.connector, issue.filename || t("delivery.message"),
      t(`delivery.${issue.state}`), issue.lastError].filter(Boolean).join(" · ");
    disclosure.append(row);
  }
  panel.append(disclosure);
}

function renderSessionScopeContext(session) {
  const parts = [];
  const sourceName = typeof getEffectiveSessionSourceName === "function"
    ? getEffectiveSessionSourceName(session)
    : "";
  if (sourceName) {
    parts.push(`<span title="${esc(t("session.scope.source"))}">${esc(sourceName)}</span>`);
  }

  return parts;
}

function getFilteredSessionEmptyText({ archived = false } = {}) {
  if (archived) return t("sidebar.noArchived");
  if (getCurrentSourceFilter() !== FILTER_ALL_VALUE) {
    return t("sidebar.noSessionsFiltered");
  }
  return t("sidebar.noSessions");
}

function getSessionGroupInfo(session) {
  const group = typeof session?.group === "string" ? session.group.trim() : "";
  if (group) {
    return {
      key: `group:${group}`,
      label: group,
      title: group,
    };
  }

  const folder = session?.folder || "?";
  const shortFolder = getShortFolder(folder);
  return {
    key: `folder:${folder}`,
    label: getFolderLabel(folder),
    title: shortFolder,
  };
}

function renderSessionStatusHtml(statusInfo) {
  if (!statusInfo?.label) return "";
  const title = statusInfo.title ? ` title="${esc(statusInfo.title)}"` : "";
  if (!statusInfo.className) {
    return `<span${title}>${esc(statusInfo.label)}</span>`;
  }
  return `<span class="${statusInfo.className}"${title}>● ${esc(statusInfo.label)}</span>`;
}

function renderSessionStatusIndicator(statusInfo) {
  if (!statusInfo?.label || statusInfo.key === "idle") return "";
  const statusClass = statusInfo.className ? ` ${statusInfo.className}` : "";
  const title = statusInfo.title || statusInfo.label;
  return `<span class="session-row-status${statusClass}" title="${esc(title)}"><span class="session-status-dot" aria-hidden="true"></span>${esc(statusInfo.label)}</span>`;
}

function getSessionRowStatusInfo(session) {
  const liveStatus = getSessionStatusSummary(session).primary;
  if (liveStatus?.key === "running" || liveStatus?.key === "waiting") return liveStatus;
  const reviewStatus = getSessionReviewStatusInfo(session);
  if (!reviewStatus) return null;
  return {
    ...reviewStatus,
    label: t("session.rowStatus.review"),
  };
}

function createActiveSessionItem(session) {
  const statusInfo = getSessionMetaStatusInfo(session);
  const displayStatusInfo = getSessionRowStatusInfo(session);
  const completeRead = isSessionCompleteAndReviewed(session);
  const div = document.createElement("div");
  div.dataset.sessionId = session.id;
  div.className =
    "session-item"
    + (session.pinned ? " pinned" : "")
    + (session.id === currentSessionId ? " active" : "")
    + (completeRead ? " is-complete-read" : "")
    + (statusInfo.itemClass ? ` ${statusInfo.itemClass}` : "");

  const displayName = getSessionDisplayName(session);
  const metaParts = buildSessionMetaParts(session);
  const countHtml = metaParts.join("");
  const statusIndicatorHtml = renderSessionStatusIndicator(displayStatusInfo);
  const pinTitle = session.pinned ? t("action.unpin") : t("action.pin");

  const description = typeof session?.description === "string" ? session.description.trim() : "";
  const messageCount = Number.isInteger(session?.messageCount)
    ? session.messageCount
    : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
  const detailTitle = [
    countHtml ? t("session.messages", {
      count: messageCount,
      suffix: messageCount === 1 ? "" : "s",
    }) : "",
    description,
  ].filter(Boolean).join(" · ");
  const descriptionHtml = countHtml || description
    ? `<div class="session-item-description" title="${esc(detailTitle)}">${countHtml}${description ? `<span class="session-item-description-text">${esc(description)}</span>` : ""}</div>`
    : "";

  div.innerHTML = `
    <div class="session-item-info">
      <div class="session-item-title-row">
        ${statusIndicatorHtml}
        <div class="session-item-name">${esc(displayName)}</div>
        <div class="session-item-actions">
          <button class="session-action-btn rename" type="button" title="${esc(t("action.rename"))}" aria-label="${esc(t("action.rename"))}" data-id="${session.id}">${renderUiIcon("edit")}</button>
          <button class="session-action-btn archive" type="button" title="${esc(t("action.archive"))}" aria-label="${esc(t("action.archive"))}" data-id="${session.id}">${renderUiIcon("archive")}</button>
          <button class="session-action-btn pin${session.pinned ? " pinned" : ""}" type="button" title="${pinTitle}" aria-label="${pinTitle}" data-id="${session.id}">${renderUiIcon(session.pinned ? "pinned" : "pin")}</button>
        </div>
      </div>
      ${descriptionHtml}
    </div>`;

  div.addEventListener("click", (e) => {
    if (e.target.closest(".session-action-btn")) {
      return;
    }
    if (typeof switchTab === "function") switchTab("sessions");
    attachSession(session.id, session);
    if (!isDesktop) closeSidebarFn();
  });

  div.querySelector(".pin").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchAction({ action: session.pinned ? "unpin" : "pin", sessionId: session.id });
  });

  div.querySelector(".rename").addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(div, session);
  });

  div.querySelector(".archive").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchAction({ action: "archive", sessionId: session.id });
  });

  if (typeof renderActiveSessionRenameEditor === "function") {
    renderActiveSessionRenameEditor(div, session);
  }

  return div;
}

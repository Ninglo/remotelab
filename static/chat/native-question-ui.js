function renderNativeQuestionMessage(container, evt) {
  const sessionId = currentSessionId;
  const question = evt.nativeQuestion;
  const panel = document.createElement("div");
  panel.className = "msg-assistant native-question";
  panel.dataset.questionId = evt.questionId;
  const title = document.createElement("div");
  title.className = "native-question-title";
  title.textContent = question.question;
  panel.appendChild(title);
  const status = document.createElement("div");
  status.className = "native-question-status";
  const readOnly = typeof shareSnapshotMode !== "undefined" && shareSnapshotMode;
  const pending = evt.questionState === "pending" && !readOnly;
  const controls = [], selections = [];
  let requestId = null, submittedText = null;
  async function submit(text) {
    if (!pending || !text.trim()) return;
    // Retry an uncertain HTTP result with the same identity and payload.
    if (submittedText !== null && submittedText !== text) {
      status.textContent = "上一条回答尚未获确认，请先重试上一选择或刷新。"; return;
    }
    submittedText = text;
    requestId ||= createRequestId();
    controls.forEach(control => { control.disabled = true; });
    status.textContent = "正在提交回答…";
    try {
      await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, nativeQuestionId: evt.questionId, text }),
      });
      status.textContent = "回答已提交。";
      if (currentSessionId === sessionId) await refreshCurrentSession({ forceFresh: true });
    } catch (error) {
      status.textContent = error.message || "提交未获确认，请重试或刷新。";
      controls.forEach(control => { control.disabled = false; });
    }
  }
  (question.options || []).forEach((option, index) => {
    const row = document.createElement(question.multiSelect ? "label" : "button");
    row.className = "native-question-option";
    if (question.multiSelect) {
      const input = document.createElement("input");
      input.type = "checkbox"; input.disabled = !pending;
      selections.push(input); controls.push(input); row.appendChild(input);
    } else {
      row.type = "button"; row.disabled = !pending; controls.push(row);
      row.addEventListener("click", () => void submit(String(index + 1)));
    }
    const text = document.createElement("span");
    text.textContent = `${index + 1}. ${option.label}${option.description ? `：${option.description}` : ""}`;
    row.appendChild(text); panel.appendChild(row);
  });
  if (pending) {
    if (question.multiSelect && selections.length) {
      const selected = document.createElement("button");
      selected.type = "button"; selected.textContent = "提交所选项"; controls.push(selected);
      selected.addEventListener("click", () => {
        const indices = selections.flatMap((input, i) => input.checked ? [i + 1] : []);
        if (indices.length) void submit(indices.join(","));
        else status.textContent = "请先选择一项。";
      });
      panel.appendChild(selected);
    }
    const form = document.createElement("form");
    form.className = "native-question-custom";
    const input = document.createElement("textarea");
    input.placeholder = "填写自己的答案"; input.rows = 2; input.required = true;
    input.setAttribute("aria-label", "自己的答案");
    const button = document.createElement("button");
    button.type = "submit"; button.textContent = "提交答案";
    controls.push(input, button); form.appendChild(input); form.appendChild(button);
    form.addEventListener("submit", event => { event.preventDefault(); void submit(input.value); });
    panel.appendChild(form);
  }
  status.textContent = evt.questionState === "pending"
    ? `${question.options?.length ? `未回复时，五分钟后采用第 1 项「${question.options[0].label}」。` : "五分钟未答后继续处理。"} 状态只在这里更新。`
    : evt.questionStatusText || (evt.questionState === "answered" ? `已回答：${(evt.questionAnswers || []).join("、")}`
      : evt.questionState === "timeout" ? "已超时，采用系统默认；并非用户回答。" : "问题已结束。");
  panel.appendChild(status);
  appendMessageTimestamp(panel, evt.timestamp, "msg-assistant-time");
  container.appendChild(panel);
  return panel;
}

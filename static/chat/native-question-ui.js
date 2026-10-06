const nativeQuestionAcknowledgements = new Map();

function renderNativeQuestionMessage(container, evt) {
  const sessionId = currentSessionId;
  const question = evt.nativeQuestion;
  const readOnly = typeof shareSnapshotMode !== "undefined" && shareSnapshotMode;
  const acknowledgementKey = `${sessionId}:${evt.questionId}`;
  if (evt.questionState !== "pending") nativeQuestionAcknowledgements.delete(acknowledgementKey);
  const acknowledgedAnswers = readOnly ? null : nativeQuestionAcknowledgements.get(acknowledgementKey);
  const state = acknowledgedAnswers ? "answered" : evt.questionState;
  const answers = acknowledgedAnswers || evt.questionAnswers || [];
  const panel = document.createElement("div");
  panel.className = "msg-assistant native-question";
  panel.dataset.questionId = evt.questionId;
  panel.dataset.questionState = state;
  panel.setAttribute("role", "group");
  const status = document.createElement("div");
  status.className = "native-question-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  panel.appendChild(status);
  const title = document.createElement("div");
  title.className = "native-question-title";
  title.textContent = question.question;
  panel.appendChild(title);
  const pending = state === "pending" && !readOnly;
  const options = question.options || [];
  const controls = [], selections = [], optionRows = [];
  const hint = document.createElement("div");
  hint.className = "native-question-hint";
  hint.textContent = options.length ? (question.multiSelect ? "可多选，选好后提交" : "点选即提交") : "填写后提交";
  if (pending) panel.appendChild(hint);
  const optionList = document.createElement("div");
  optionList.className = "native-question-options";
  const footer = document.createElement("div");
  footer.className = "native-question-hint native-question-deadline";
  footer.textContent = !Number.isFinite(evt.questionDeadline) ? "等你回答，不会超时自动选择。"
    : `截止 ${new Date(evt.questionDeadline).toLocaleString()}：${options.length ? `未答时系统默认选择「${options[0].label}」。` : "未答时继续处理。"}`;
  let customContainer;
  let submitting = false, accepted = false;
  let requestId = null, submittedText = null;
  const resultText = values => values.length
    ? `${values.every(value => options.some(option => option.label === value)) ? "已选择" : "已提交"}：${values.join("、")}`
    : "已回答";
  function markSelection(answers) {
    optionRows.forEach((row, i) => {
      const selected = answers.includes(options[i].label);
      row.className = `native-question-option${selected ? " is-selected" : ""}`;
      if (!question.multiSelect) row.setAttribute("aria-pressed", String(selected));
      else if (panel.dataset.questionState !== "error") selections[i].checked = selected;
    });
  }
  async function submit(text, answers) {
    if (!pending || submitting || accepted || !text.trim()) return;
    // Retry an uncertain HTTP result with the same identity and payload.
    if (submittedText !== null && submittedText !== text) {
      status.textContent = "上一条回答尚未获确认，请先重试上一选择或刷新。"; return;
    }
    submittedText = text;
    requestId ||= createRequestId();
    submitting = true;
    panel.dataset.questionState = "submitting";
    panel.setAttribute("aria-busy", "true");
    controls.forEach(control => { control.disabled = true; });
    markSelection(answers);
    status.textContent = `正在提交：${answers.join("、")}…`;
    try {
      await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, nativeQuestionId: evt.questionId, text }),
      });
    } catch (error) {
      submitting = false;
      panel.dataset.questionState = "error";
      panel.setAttribute("aria-busy", "false");
      markSelection([]);
      status.textContent = `提交未获确认${error.message ? `：${error.message}` : ""}。请重试原选择或刷新。`;
      controls.forEach(control => { control.disabled = false; });
      return;
    }
    accepted = true;
    submitting = false;
    panel.dataset.questionState = "answered";
    panel.setAttribute("aria-busy", "false");
    status.textContent = resultText(answers);
    nativeQuestionAcknowledgements.set(acknowledgementKey, answers);
    if (nativeQuestionAcknowledgements.size > 100) {
      nativeQuestionAcknowledgements.delete(nativeQuestionAcknowledgements.keys().next().value);
    }
    hint.hidden = true;
    footer.hidden = true;
    if (customContainer) customContainer.hidden = true;
    // The answer is already accepted. A refresh failure must not unlock it or
    // replace the visible acknowledgement with a submission error.
    if (currentSessionId === sessionId) {
      try { await refreshCurrentSession({ forceFresh: true }); } catch {}
    }
  }
  options.forEach((option, index) => {
    const row = document.createElement(question.multiSelect ? "label" : "button");
    row.className = "native-question-option";
    if (question.multiSelect) {
      const input = document.createElement("input");
      input.type = "checkbox"; input.disabled = !pending;
      selections.push(input); controls.push(input); row.appendChild(input);
    } else {
      row.type = "button"; row.disabled = !pending; controls.push(row);
      row.setAttribute("aria-pressed", "false");
      row.addEventListener("click", () => void submit(String(index + 1), [option.label]));
    }
    const text = document.createElement("span");
    text.textContent = option.label;
    row.appendChild(text);
    if (option.description) {
      const description = document.createElement("small");
      description.textContent = option.description;
      text.appendChild(description);
    }
    optionRows.push(row); optionList.appendChild(row);
  });
  if (options.length) {
    if (state === "pending") panel.appendChild(optionList);
    else {
      const details = document.createElement("details");
      details.className = "native-question-details";
      const summary = document.createElement("summary");
      summary.textContent = "查看选项";
      details.appendChild(summary); details.appendChild(optionList); panel.appendChild(details);
      markSelection(answers);
    }
  }
  if (pending) {
    if (question.multiSelect && selections.length) {
      const selected = document.createElement("button");
      selected.type = "button"; selected.textContent = "提交所选项"; controls.push(selected);
      selected.addEventListener("click", () => {
        const indices = selections.flatMap((input, i) => input.checked ? [i + 1] : []);
        if (indices.length) void submit(indices.join(","), indices.map(i => options[i - 1].label));
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
    form.addEventListener("submit", event => { event.preventDefault(); void submit(input.value, [input.value.trim()]); });
    if (options.length) {
      customContainer = document.createElement("details");
      customContainer.className = "native-question-details";
      const summary = document.createElement("summary");
      summary.textContent = "填写其他答案";
      customContainer.appendChild(summary); customContainer.appendChild(form);
    } else customContainer = form;
    panel.appendChild(customContainer);
    panel.appendChild(footer);
  }
  status.textContent = state === "pending"
    ? (readOnly ? "待回答（只读）" : options.length ? "待你选择" : "待你填写")
    : state === "answered" ? resultText(answers)
      : state === "timeout" ? `已采用系统默认${answers.length ? `：${answers.join("、")}` : ""}（非你的选择）`
        : evt.questionStatusText || "问题已结束。";
  appendMessageTimestamp(panel, evt.timestamp, "msg-assistant-time");
  container.appendChild(panel);
  return panel;
}

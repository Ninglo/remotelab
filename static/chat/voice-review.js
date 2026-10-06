"use strict";

(function attachVoiceReview(globalScope) {
  const enabledInput = document.getElementById("voiceReviewEnabled");
  const modelInput = document.getElementById("voiceReviewModelEnabled");
  const modelFields = document.getElementById("voiceReviewModelFields");
  const termsInput = document.getElementById("voiceReviewTerms");
  const providerSelect = document.getElementById("voiceReviewProvider");
  const providerEndpoint = document.getElementById("voiceReviewProviderEndpoint");
  const doubaoKeyNote = document.getElementById("voiceReviewDoubaoKeyNote");
  const apiKeyInput = document.getElementById("voiceReviewApiKey");
  const apiKeyStatus = document.getElementById("voiceReviewApiKeyStatus");
  const saveButton = document.getElementById("voiceReviewSave");
  const settingsStatus = document.getElementById("voiceReviewSettingsStatus");
  const backendNote = document.getElementById("voiceReviewBackendNote");
  const panel = document.getElementById("voiceReviewPanel");
  const body = document.getElementById("voiceReviewBody");
  const undoButton = document.getElementById("voiceReviewUndo");
  const status = document.getElementById("voiceReviewStatus");
  const composer = document.getElementById("msgInput");
  if (!enabledInput || !modelInput || !termsInput || !providerSelect || !apiKeyInput || !saveButton || !panel || !composer) return;

  const providers = {
    doubao: { model: "doubao-seed-2-1-lite-260915", endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions" },
    zhipu: { model: "glm-4.7-flash", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" },
    openrouter: { model: "qwen/qwen3-4b:free", endpoint: "https://openrouter.ai/api/v1/chat/completions" },
  };
  let settings = { enabled: false, reviewMode: "asr", terms: [], provider: { id: "", apiKeyConfigured: false } };
  let backend = "unconfigured";
  let capture = null;
  let undoState = null;
  let pendingReview = null;
  const ordinalCharacters = "一二三四五六七八九十";
  const pointPattern = /(?:首先|然后|接着)?\s*第([一二三四五六七八九十]|[1-9]\d?)(?:点|项|件事情|件事|个事情|个事)(?:是|：|:)?[，,\s]*/g;

  function formatLiveTranscript(transcript) {
    if (!settings.enabled || typeof transcript !== "string") return transcript;
    const matches = [...transcript.matchAll(pointPattern)];
    if (matches.length < 2) return transcript;
    const numbers = matches.map((match) => /^\d+$/.test(match[1])
      ? Number(match[1]) : ordinalCharacters.indexOf(match[1]) + 1);
    if (numbers.some((number, index) => number < 1 || (index > 0 && number <= numbers[index - 1]))) return transcript;
    const prefix = transcript.slice(0, matches[0].index).trim();
    const points = matches.map((match, index) => {
      const item = transcript.slice(match.index + match[0].length, matches[index + 1]?.index ?? transcript.length).trim();
      return `${numbers[index]}. ${item}`;
    });
    return [prefix, ...points].filter(Boolean).join("\n");
  }

  globalScope.remotelabFormatVoiceTranscriptLive = formatLiveTranscript;

  function t(key, vars) {
    return globalScope.remotelabT ? globalScope.remotelabT(key, vars) : key;
  }

  function setStatus(element, message) {
    if (!element) return;
    element.textContent = message || "";
    element.hidden = !message;
  }

  function renderProvider() {
    if (modelFields) modelFields.hidden = !modelInput.checked;
    const selected = providers[providerSelect.value];
    if (providerEndpoint) providerEndpoint.textContent = selected ? `${selected.model} · ${selected.endpoint}` : "";
    if (doubaoKeyNote) doubaoKeyNote.hidden = providerSelect.value !== "doubao";
    if (apiKeyStatus) apiKeyStatus.textContent = !selected ? ""
      : selected === providers[settings.provider?.id] && settings.provider?.apiKeyConfigured
        ? t("settings.voiceReview.apiKeySaved")
        : t("settings.voiceReview.apiKeyNeeded");
    apiKeyInput.disabled = !selected;
  }

  function renderBackendNote() {
    if (!backendNote) return;
    backendNote.textContent = settings.enabled && settings.reviewMode === "asr"
      ? t("settings.voiceReview.backend.asr")
      : t(`settings.voiceReview.backend.${backend}`);
  }

  function clearPanel() {
    capture?.controller?.abort();
    capture = null;
    pendingReview = null;
    undoState = null;
    panel.hidden = true;
    undoButton.hidden = true;
    panel.title = "";
    setStatus(status, "");
  }

  function captureIsCurrent(target) {
    return target === capture
      && target.personId === currentPerson?.id
      && target.sessionId === (typeof currentSessionId === "string" ? currentSessionId : "")
      && target.composerText === composer.value;
  }

  async function reviewCapture(target) {
    if (!captureIsCurrent(target)) return { after: null };
    const deadline = globalScope.setTimeout(() => target.controller.abort(), 5000);
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review", {
        method: "POST",
        revalidate: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: target.transcript }),
        signal: target.controller.signal,
      });
      if (!captureIsCurrent(target)) return { after: null };
      const revised = typeof payload?.revised === "string" ? payload.revised.trim() : "";
      const overedited = payload?.overedited === true;
      capture = null;
      const displayedTranscript = target.displayedTranscript || target.transcript;
      if (!revised || !target.composerText.endsWith(displayedTranscript)) {
        clearPanel();
        return { after: target.composerText };
      }
      const finalTranscript = overedited ? formatLiveTranscript(revised)
        : revised === target.transcript ? displayedTranscript : revised;
      const after = target.composerText.slice(0, -displayedTranscript.length) + finalTranscript;
      if (after === (target.rawComposerText || target.composerText)) {
        clearPanel();
        return { after };
      }
      undoState = { before: target.rawComposerText || target.composerText, after, sessionId: target.sessionId };
      composer.value = after;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      body.textContent = t(overedited ? "voiceReview.preserved" : "voiceReview.applied");
      panel.title = body.textContent;
      undoButton.hidden = false;
      panel.hidden = false;
      setStatus(status, "");
      return { after };
    } catch (error) {
      if (!captureIsCurrent(target)) return { after: null };
      capture = null;
      const after = target.rawComposerText || target.composerText;
      if (after !== composer.value) {
        composer.value = after;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
      body.textContent = t("voiceReview.failed");
      setStatus(status, error?.message || "Voice review failed");
      panel.title = error?.message || "Voice review failed";
      panel.hidden = false;
      return { after };
    } finally {
      globalScope.clearTimeout(deadline);
    }
  }

  async function loadSettings() {
    if (!currentPerson?.id) return;
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review/settings", { revalidate: false });
      settings = payload?.settings || settings;
      backend = payload?.backend === "api" ? "api" : "unconfigured";
      renderBackendNote();
      enabledInput.checked = settings.enabled === true;
      modelInput.checked = settings.reviewMode === "model";
      termsInput.value = (settings.terms || []).join("\n");
      providerSelect.value = settings.provider?.id || "";
      apiKeyInput.value = "";
      renderProvider();
      setStatus(settingsStatus, "");
    } catch (error) {
      settings = { enabled: false, reviewMode: "asr", terms: [] };
      backend = "unconfigured";
      enabledInput.checked = false;
      modelInput.checked = false;
      providerSelect.value = "";
      apiKeyInput.value = "";
      renderProvider();
      setStatus(settingsStatus, error?.message || "Voice review settings unavailable");
    }
  }

  providerSelect.addEventListener("change", () => {
    apiKeyInput.value = "";
    renderProvider();
  });

  modelInput.addEventListener("change", renderProvider);

  saveButton.addEventListener("click", async () => {
    const terms = [...new Set(termsInput.value.split(/\r?\n/).map((term) => term.trim()).filter(Boolean))];
    if (terms.length > 50 || terms.some((term) => term.length > 60)) {
      setStatus(settingsStatus, "Use at most 50 terms, each at most 60 characters.");
      return;
    }
    const providerId = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    saveButton.disabled = true;
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review/settings", {
        method: "PATCH",
        revalidate: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabledInput.checked, reviewMode: modelInput.checked ? "model" : "asr", terms, providerId, ...(apiKey ? { apiKey } : {}) }),
      });
      settings = payload.settings;
      backend = payload?.backend === "api" ? "api" : "unconfigured";
      renderBackendNote();
      apiKeyInput.value = "";
      renderProvider();
      setStatus(settingsStatus, t("settings.voiceReview.saved"));
      if (!settings.enabled || settings.reviewMode !== "model") clearPanel();
    } catch (error) {
      enabledInput.checked = settings.enabled;
      modelInput.checked = settings.reviewMode === "model";
      providerSelect.value = settings.provider?.id || "";
      renderProvider();
      setStatus(settingsStatus, error?.message || "Could not save personal voice settings");
    } finally {
      saveButton.disabled = false;
    }
  });

  globalScope.addEventListener("remotelab:voice-transcript-complete", (event) => {
    clearPanel();
    if (!settings.enabled || settings.reviewMode !== "model" || !event?.detail?.transcript) return;
    capture = {
      transcript: event.detail.transcript,
      composerText: event.detail.composerText,
      displayedTranscript: event.detail.displayedTranscript,
      rawComposerText: event.detail.rawComposerText,
      sessionId: event.detail.sessionId,
      personId: currentPerson?.id,
      controller: new AbortController(),
    };
    if (!captureIsCurrent(capture)) return clearPanel();
    panel.hidden = false;
    if (backend !== "api") {
      body.textContent = t("voiceReview.unconfigured");
      panel.title = body.textContent;
      return;
    }
    body.textContent = t("voiceReview.working");
    const target = capture;
    const task = reviewCapture(target);
    pendingReview = { target, task };
    void task.then(() => {
      if (pendingReview?.target === target) pendingReview = null;
    });
  });

  globalScope.remotelabWaitForVoiceReview = () => pendingReview && captureIsCurrent(pendingReview.target)
    ? pendingReview.task : null;
  // Explicit Send freezes the visible draft and makes any late review obsolete.
  globalScope.remotelabCancelVoiceReview = clearPanel;

  undoButton.addEventListener("click", () => {
    if (!undoState || undoState.sessionId !== currentSessionId || composer.value !== undoState.after) return clearPanel();
    composer.value = undoState.before;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    clearPanel();
    composer.focus();
  });

  composer.addEventListener("input", () => {
    if ((capture && !captureIsCurrent(capture))
      || (undoState && (undoState.sessionId !== currentSessionId || composer.value !== undoState.after))
      || (!capture && !undoState && !panel.hidden)) clearPanel();
  });

  void loadSettings();
})(window);

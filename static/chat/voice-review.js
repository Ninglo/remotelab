"use strict";

(function attachVoiceReview(globalScope) {
  const enabledInput = document.getElementById("voiceReviewEnabled");
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
  if (!enabledInput || !termsInput || !providerSelect || !apiKeyInput || !saveButton || !panel || !composer) return;

  const providers = {
    doubao: { model: "doubao-seed-2-1-lite-260915", endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions" },
    zhipu: { model: "glm-4.7-flash", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" },
    openrouter: { model: "qwen/qwen3-4b:free", endpoint: "https://openrouter.ai/api/v1/chat/completions" },
  };
  let settings = { enabled: false, terms: [], provider: { id: "", apiKeyConfigured: false } };
  let backend = "unconfigured";
  let capture = null;
  let undoState = null;
  let pendingReview = null;
  let reviewTail = Promise.resolve();

  function t(key, vars) {
    return globalScope.remotelabT ? globalScope.remotelabT(key, vars) : key;
  }

  function setStatus(element, message) {
    if (!element) return;
    element.textContent = message || "";
    element.hidden = !message;
  }

  function renderProvider() {
    const selected = providers[providerSelect.value];
    if (providerEndpoint) providerEndpoint.textContent = selected ? `${selected.model} · ${selected.endpoint}` : "";
    if (doubaoKeyNote) doubaoKeyNote.hidden = providerSelect.value !== "doubao";
    if (apiKeyStatus) apiKeyStatus.textContent = !selected ? ""
      : selected === providers[settings.provider?.id] && settings.provider?.apiKeyConfigured
        ? t("settings.voiceReview.apiKeySaved")
        : t("settings.voiceReview.apiKeyNeeded");
    apiKeyInput.disabled = !selected;
  }

  function clearPanel() {
    capture = null;
    undoState = null;
    panel.hidden = true;
    undoButton.hidden = true;
    setStatus(status, "");
  }

  function captureIsCurrent(target) {
    return target === capture
      && target.sessionId === (typeof currentSessionId === "string" ? currentSessionId : "")
      && target.composerText === composer.value;
  }

  async function reviewCapture(target) {
    if (!captureIsCurrent(target)) return { after: null };
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review", {
        method: "POST",
        revalidate: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: target.transcript }),
      });
      if (!captureIsCurrent(target)) return { after: null };
      const revised = typeof payload?.revised === "string" ? payload.revised.trim() : "";
      capture = null;
      if (!revised || revised === target.transcript || !target.composerText.endsWith(target.transcript)) {
        clearPanel();
        return { after: target.composerText };
      }
      const after = target.composerText.slice(0, -target.transcript.length) + revised;
      undoState = { before: target.composerText, after, sessionId: target.sessionId };
      composer.value = after;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      body.textContent = t("voiceReview.applied");
      undoButton.hidden = false;
      panel.hidden = false;
      setStatus(status, "");
      return { after };
    } catch (error) {
      if (!captureIsCurrent(target)) return { after: null };
      capture = null;
      body.textContent = t("voiceReview.failed");
      setStatus(status, error?.message || "Voice review failed");
      return { after: target.composerText };
    }
  }

  async function loadSettings() {
    if (!currentPerson?.id) return;
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review/settings", { revalidate: false });
      settings = payload?.settings || settings;
      backend = payload?.backend === "api" ? "api" : "unconfigured";
      if (backendNote) backendNote.textContent = t(`settings.voiceReview.backend.${backend}`);
      enabledInput.checked = settings.enabled === true;
      termsInput.value = (settings.terms || []).join("\n");
      providerSelect.value = settings.provider?.id || "";
      apiKeyInput.value = "";
      renderProvider();
      setStatus(settingsStatus, "");
    } catch (error) {
      settings = { enabled: false, terms: [] };
      backend = "unconfigured";
      enabledInput.checked = false;
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
        body: JSON.stringify({ enabled: enabledInput.checked, terms, providerId, ...(apiKey ? { apiKey } : {}) }),
      });
      settings = payload.settings;
      backend = payload?.backend === "api" ? "api" : "unconfigured";
      if (backendNote) backendNote.textContent = t(`settings.voiceReview.backend.${backend}`);
      apiKeyInput.value = "";
      renderProvider();
      setStatus(settingsStatus, t("settings.voiceReview.saved"));
      if (!settings.enabled) clearPanel();
    } catch (error) {
      enabledInput.checked = settings.enabled;
      providerSelect.value = settings.provider?.id || "";
      renderProvider();
      setStatus(settingsStatus, error?.message || "Could not save personal voice settings");
    } finally {
      saveButton.disabled = false;
    }
  });

  globalScope.addEventListener("remotelab:voice-transcript-complete", (event) => {
    clearPanel();
    if (!settings.enabled || !event?.detail?.transcript) return;
    capture = {
      transcript: event.detail.transcript,
      composerText: event.detail.composerText,
      sessionId: event.detail.sessionId,
    };
    if (!captureIsCurrent(capture)) return clearPanel();
    panel.hidden = false;
    if (backend !== "api") {
      body.textContent = t("voiceReview.unconfigured");
      return;
    }
    body.textContent = t("voiceReview.working");
    const target = capture;
    const task = reviewTail.then(() => reviewCapture(target));
    reviewTail = task;
    pendingReview = { target, task };
    void task.then(() => {
      if (pendingReview?.target === target) pendingReview = null;
    });
  });

  globalScope.remotelabWaitForVoiceReview = () => pendingReview && captureIsCurrent(pendingReview.target)
    ? pendingReview.task : null;

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

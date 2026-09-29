"use strict";

(function attachVoiceReview(globalScope) {
  const enabledInput = document.getElementById("voiceReviewEnabled");
  const termsInput = document.getElementById("voiceReviewTerms");
  const providerSelect = document.getElementById("voiceReviewProvider");
  const providerEndpoint = document.getElementById("voiceReviewProviderEndpoint");
  const apiKeyInput = document.getElementById("voiceReviewApiKey");
  const apiKeyStatus = document.getElementById("voiceReviewApiKeyStatus");
  const saveButton = document.getElementById("voiceReviewSave");
  const settingsStatus = document.getElementById("voiceReviewSettingsStatus");
  const backendNote = document.getElementById("voiceReviewBackendNote");
  const panel = document.getElementById("voiceReviewPanel");
  const body = document.getElementById("voiceReviewBody");
  const runButton = document.getElementById("voiceReviewRun");
  const applyButton = document.getElementById("voiceReviewApply");
  const dismissButton = document.getElementById("voiceReviewDismiss");
  const status = document.getElementById("voiceReviewStatus");
  const composer = document.getElementById("msgInput");
  if (!enabledInput || !termsInput || !providerSelect || !apiKeyInput || !saveButton || !panel || !composer) return;

  const providers = {
    zhipu: { model: "glm-4.7-flash", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions" },
    openrouter: { model: "qwen/qwen3-4b:free", endpoint: "https://openrouter.ai/api/v1/chat/completions" },
  };
  let settings = { enabled: false, terms: [], provider: { id: "", apiKeyConfigured: false } };
  let backend = "unconfigured";
  let capture = null;
  let revised = "";

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
    if (apiKeyStatus) apiKeyStatus.textContent = !selected ? ""
      : selected === providers[settings.provider?.id] && settings.provider?.apiKeyConfigured
        ? t("settings.voiceReview.apiKeySaved")
        : t("settings.voiceReview.apiKeyNeeded");
    apiKeyInput.disabled = !selected;
  }

  function clearPanel() {
    capture = null;
    revised = "";
    panel.hidden = true;
    applyButton.hidden = true;
    runButton.disabled = backend !== "api";
    setStatus(status, "");
  }

  function captureIsCurrent() {
    return capture
      && capture.sessionId === (typeof currentSessionId === "string" ? currentSessionId : "")
      && capture.composerText === composer.value;
  }

  async function loadSettings() {
    if (!currentPerson?.id) return;
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review/settings", { revalidate: false });
      settings = payload?.settings || settings;
      backend = payload?.backend === "api" ? "api" : "unconfigured";
      if (backendNote) backendNote.textContent = t(`settings.voiceReview.backend.${backend}`);
      runButton.disabled = backend !== "api";
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
      runButton.disabled = true;
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
    if (providerId && !apiKey && (providerId !== settings.provider?.id || !settings.provider?.apiKeyConfigured)) {
      setStatus(settingsStatus, t("settings.voiceReview.apiKeyNeeded"));
      apiKeyInput.focus();
      return;
    }
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
      runButton.disabled = backend !== "api";
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
    if (!settings.enabled || backend !== "api" || !event?.detail?.transcript) return;
    capture = {
      transcript: event.detail.transcript,
      composerText: event.detail.composerText,
      sessionId: event.detail.sessionId,
    };
    if (!captureIsCurrent()) return clearPanel();
    panel.hidden = false;
    body.textContent = t("voiceReview.ready");
  });

  runButton.addEventListener("click", async () => {
    if (backend !== "api") return;
    if (!captureIsCurrent()) return clearPanel();
    const requestCapture = capture;
    runButton.disabled = true;
    setStatus(status, t("voiceReview.working"));
    try {
      const payload = await fetchJsonOrRedirect("/api/voice-review", {
        method: "POST",
        revalidate: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: requestCapture.transcript }),
      });
      if (capture !== requestCapture || !captureIsCurrent()) {
        clearPanel();
        return;
      }
      revised = payload.revised || "";
      body.textContent = t("voiceReview.result", { revised });
      applyButton.hidden = !revised || revised === capture.transcript;
      setStatus(status, "");
    } catch (error) {
      if (capture === requestCapture) setStatus(status, error?.message || "Voice review failed");
    } finally {
      runButton.disabled = false;
    }
  });

  applyButton.addEventListener("click", () => {
    if (!captureIsCurrent() || !revised || !capture.composerText.endsWith(capture.transcript)) {
      setStatus(status, t("voiceReview.changed"));
      clearPanel();
      return;
    }
    composer.value = capture.composerText.slice(0, -capture.transcript.length) + revised;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    clearPanel();
    composer.focus();
  });

  dismissButton.addEventListener("click", clearPanel);
  composer.addEventListener("input", () => {
    if (capture && !captureIsCurrent()) clearPanel();
  });

  void loadSettings();
})(window);

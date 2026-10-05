"use strict";

(function attachMobileVoice(globalScope) {
  const doc = globalScope.document;
  const mic = doc?.getElementById("voiceBtn");
  const hold = doc?.getElementById("mobileVoiceHold");
  const holdLabel = doc?.getElementById("mobileVoiceHoldLabel") || hold;
  const modeButton = doc?.getElementById("mobileVoiceMode");
  const modeIcon = doc?.getElementById("mobileVoiceModeIcon");
  const draft = doc?.getElementById("mobileVoiceDraft");
  const panel = doc?.getElementById("mobileVoicePanel");
  const status = doc?.getElementById("mobileVoiceStatus");
  const duration = doc?.getElementById("mobileVoiceDuration");
  const transcript = doc?.getElementById("mobileVoiceTranscript");
  const cancel = doc?.getElementById("mobileVoiceCancel");
  const release = doc?.getElementById("mobileVoiceRelease");
  const bars = Array.from(panel?.querySelectorAll(".mobile-voice-level i") || []);
  const preferenceStatus = doc?.getElementById("mobileVoicePreferenceStatus");
  const controller = globalScope.remotelabVoiceCapture;
  if (!mic || !hold || !modeButton || !panel || !controller || typeof msgInput === "undefined") return;
  const media = globalScope.matchMedia("(max-width: 767px)");
  let personId = "";
  let mode = "text";
  let savingMode = false;
  let requestedVoice = false;
  let composerSession = null;
  let modeIconName = "";
  let gesture = null;
  let capture = null;
  let clock = null;
  let waveformFrame = null;
  let ignoreClickUntil = 0;
  const t = (key) => globalScope.remotelabT ? globalScope.remotelabT(key) : key;
  const currentPersonId = () => typeof currentPerson !== "undefined" ? currentPerson?.id || "" : "";
  const sessionId = () => typeof currentSessionId !== "undefined" ? currentSessionId || "" : "";
  const isMobile = () => media.matches && !(typeof shareSnapshotMode !== "undefined" && shareSnapshotMode);
  const hasAttachments = () => typeof getComposerAttachmentsSnapshot === "function"
    && getComposerAttachmentsSnapshot(typeof resolveActiveComposerSessionId === "function" ? resolveActiveComposerSessionId() : sessionId()).length > 0;
  const setText = (element, text) => {
    if (element.textContent === text) return false;
    element.textContent = text;
    return true;
  };

  function savedMode() {
    const people = typeof getPeopleDirectory === "function" ? getPeopleDirectory() : [];
    const person = people.find((entry) => entry.id === currentPersonId())
      || (typeof currentPerson !== "undefined" ? currentPerson : null);
    return person?.preferences?.mobileInputMode === "voice" ? "voice" : "text";
  }

  function showNotice(message = "") {
    preferenceStatus.textContent = message;
    preferenceStatus.hidden = !message;
  }

  function render({ preferences = false } = {}) {
    if (composerSession !== sessionId()) { composerSession = sessionId(); requestedVoice = false; }
    if (personId !== currentPersonId() || (preferences && !savingMode)) {
      if (personId !== currentPersonId()) requestedVoice = false;
      if (personId && personId !== currentPersonId()) controller.releaseMicrophone?.();
      personId = currentPersonId();
      mode = savedMode();
    }
    if (capture && !isCurrent(capture)) { discardGesture(); cancelCapture(); return; }
    const mobile = isMobile();
    const wrapper = mic.closest(".input-wrapper");
    wrapper?.classList.toggle("has-mobile-voice-capture", mobile && !!capture);
    const voiceMode = mobile && mode === "voice"
      && (requestedVoice || (capture ? !capture.baseText.trim() && !capture.hadAttachments : !msgInput.value.trim() && !hasAttachments()));
    const showDraft = voiceMode && !capture && !!msgInput.value.trim();
    let draftChanged = false;
    if (draft) { draft.hidden = !showDraft; draftChanged = setText(draft, showDraft ? msgInput.value : ""); }
    wrapper?.classList.toggle("has-mobile-voice-draft", showDraft);
    hold.hidden = !voiceMode;
    wrapper?.classList.toggle("has-mobile-voice-mode", voiceMode);
    mic.closest(".input-area")?.classList.toggle("has-mobile-voice-mode", voiceMode);
    const state = controller.getState();
    hold.disabled = mic.disabled || !!capture?.released;
    const holdKey = !capture ? state.microphonePreparing ? state.microphoneAuthorized ? "voice.mobile.preparing" : "voice.mobile.authorizing"
      : state.microphoneAuthorized === false ? "voice.mobile.enable" : "voice.mobile.hold"
      : capture.released ? "voice.mobile.recognizing"
      : state.phase !== "recording" && !capture.completed ? "voice.mobile.preparing"
      : capture.choice === "cancel" ? "voice.mobile.releaseCancel"
      : "voice.mobile.releaseReview";
    setText(holdLabel, t(holdKey));
    hold.setAttribute("aria-label", t(capture ? holdKey : "voice.mobile.holdHint"));
    msgInput.hidden = voiceMode;
    if (voiceMode && typeof clearQuickEntryFocusRecovery === "function") clearQuickEntryFocusRecovery();
    modeButton.hidden = !mobile;
    modeButton.disabled = savingMode || !!capture || (!voiceMode && mic.disabled);
    const switchKey = voiceMode ? "voice.mobile.keyboard" : "voice.mobile.switchVoice";
    modeButton.title = t(switchKey);
    modeButton.setAttribute("aria-label", modeButton.title);
    modeButton.setAttribute("data-i18n-aria-label", switchKey);
    const iconName = voiceMode ? "keyboard" : "mic";
    if (modeIcon && modeIconName !== iconName) {
      modeIconName = iconName;
      modeIcon.setAttribute("data-icon", iconName);
      if (globalScope.RemoteLabIcons?.render) modeIcon.innerHTML = globalScope.RemoteLabIcons.render(iconName);
    }
    mic.classList.toggle("mobile-voice-hidden", voiceMode);
    if (mobile && !capture && controller.getState().phase === "idle") {
      mic.title = t("voice.mobile.shortcut");
      mic.setAttribute("aria-label", mic.title);
    }
    panel.hidden = !mobile || !capture;
    if (showDraft && draftChanged) draft.scrollTop = draft.scrollHeight;
    if (!capture) return;
    const ready = state.phase === "recording" || capture.completed;
    panel.classList.toggle("is-preparing", !ready && !capture.released);
    panel.classList.toggle("is-recognizing", capture.released);
    panel.classList.toggle("is-cancelling", capture.choice === "cancel");
    const key = !ready && !capture.released ? "voice.mobile.preparing"
      : capture.released ? "voice.mobile.recognizing"
      : capture.choice === "cancel" ? "voice.mobile.releaseCancel"
      : "voice.mobile.recording";
    setText(status, t(key));
    duration.textContent = capture.startedAt ? `${Math.floor(((capture.stoppedAt || Date.now()) - capture.startedAt) / 1000)}s` : "";
    const spoken = msgInput.value.slice(capture.baseText.length).trim();
    const transcriptChanged = setText(transcript, spoken || t(ready ? "voice.mobile.listening" : "voice.mobile.preparing"));
    transcript.classList.toggle("is-empty", !spoken);
    // Follow new recognition results without undoing a manual scroll on timer ticks.
    if (transcriptChanged) transcript.scrollTop = transcript.scrollHeight;
    setText(release, t(capture.released ? "voice.mobile.wait" : "voice.mobile.slide"));
    cancel.classList.toggle("selected", capture.choice === "cancel");
  }

  async function selectMode(next) {
    if (!isMobile() || capture || savingMode || !currentPersonId()) return;
    const previous = mode;
    const previousRequest = requestedVoice;
    const owner = currentPersonId();
    mode = next;
    requestedVoice = next === "voice";
    savingMode = true;
    showNotice();
    if (mode === "voice") msgInput.blur();
    if (mode === "text") controller.releaseMicrophone?.();
    render();
    try {
      const result = await fetchJsonOrRedirect(`/api/people/${encodeURIComponent(owner)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileInputMode: next }),
      });
      if (typeof replacePeopleDirectory === "function") replacePeopleDirectory(result.people);
    } catch {
      if (owner === currentPersonId()) {
        mode = previous;
        requestedVoice = previousRequest;
        showNotice(t("voice.mobile.saveFailed"));
      }
    } finally {
      savingMode = false;
      render();
      if (mode === "text" && owner === currentPersonId()) msgInput.focus({ preventScroll: true });
    }
  }

  function isCurrent(target) {
    return capture === target && target.personId === currentPersonId() && target.sessionId === sessionId()
      && !doc.hidden && isMobile() && !msgInput.disabled;
  }

  function stopWaveform() {
    if (waveformFrame !== null) globalScope.cancelAnimationFrame(waveformFrame);
    waveformFrame = null;
  }

  function startWaveform(target) {
    if (!bars.length || !globalScope.requestAnimationFrame) return;
    // A short history of microphone volume flows left; no generated pulse or random motion.
    const history = Array(bars.length + 1).fill(0);
    let previous = null, elapsed = 0, envelope = 0;
    const draw = (time) => {
      waveformFrame = null;
      if (capture !== target || target.released) return;
      const delta = Math.min(50, previous === null ? 16 : time - previous);
      previous = time;
      const state = controller.getState();
      const volume = state.phase === "recording" ? Math.min(1, Math.max(0, Number(state.voiceLevel) || 0)) : 0;
      const level = Math.max(0, (volume - 0.035) / 0.965);
      envelope += (level - envelope) * (1 - Math.exp(-delta / (level > envelope ? 45 : 100)));
      elapsed += delta;
      while (elapsed >= 50) {
        history.shift();
        history.push(envelope);
        elapsed -= 50;
      }
      bars.forEach((bar, index) => {
        const amplitude = history[index] + (history[index + 1] - history[index]) * elapsed / 50;
        bar.style.setProperty("--voice-bar-height", `${(4 + amplitude * 26).toFixed(2)}px`);
      });
      waveformFrame = globalScope.requestAnimationFrame(draw);
    };
    bars.forEach((bar) => bar.style.setProperty("--voice-bar-height", "4px"));
    waveformFrame = globalScope.requestAnimationFrame(draw);
  }

  function clearCapture() {
    if (capture?.deadline) globalScope.clearTimeout(capture.deadline);
    capture = null;
    stopWaveform();
    if (clock) globalScope.clearInterval(clock);
    clock = null;
    render();
  }

  function cancelCapture({ restore = false, notice = "", keepMicrophone = false } = {}) {
    const target = capture;
    if (!target) return;
    requestedVoice = false;
    const text = target.baseText;
    const sameComposer = target.sessionId === sessionId() && target.personId === currentPersonId();
    clearCapture();
    void controller.cancel({ keepMicrophone });
    if (restore && sameComposer) {
      msgInput.value = text;
      msgInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (notice) showNotice(notice);
  }

  async function finish(target) {
    if (!isCurrent(target) || !target.completed || !target.released || target.finishing) return;
    target.finishing = true;
    const before = msgInput.value;
    const review = globalScope.remotelabWaitForVoiceReview?.();
    let result;
    try {
      if (review) result = await review;
      // The final transcript event is emitted just before audio cleanup starts.
      await Promise.resolve();
      await controller.whenIdle();
    } catch {
      if (isCurrent(target)) cancelCapture({ notice: t("voice.mobile.failed") });
      return;
    }
    if (!isCurrent(target)) return;
    if (msgInput.value !== before && msgInput.value !== result?.after) {
      cancelCapture();
      return;
    }
    requestedVoice = false;
    clearCapture();
    msgInput.dispatchEvent(new Event("input", { bubbles: true }));
    msgInput.scrollTop = msgInput.scrollHeight;
    // Review keeps the phone keyboard closed; tap the text to edit normally.
  }

  function beginCapture(targetGesture) {
    if (gesture !== targetGesture || controller.getState().phase !== "idle") return;
    targetGesture.started = true;
    capture = {
      personId: currentPersonId(), sessionId: sessionId(), baseText: msgInput.value,
      hadAttachments: hasAttachments(),
      choice: "review", released: false, completed: false, captureId: 0, startedAt: 0,
    };
    const target = capture;
    showNotice();
    msgInput.blur();
    const starting = controller.start();
    target.captureId = controller.getState().captureId;
    void Promise.resolve(starting).catch(() => {
      if (isCurrent(target)) cancelCapture({ notice: t("voice.mobile.failed") });
    });
    clock = globalScope.setInterval(render, 250);
    startWaveform(target);
    render();
  }

  function discardGesture() {
    if (gesture?.timer) globalScope.clearTimeout(gesture.timer);
    gesture = null;
  }

  function pointerDown(event) {
    if (!isMobile() || event.isPrimary === false || event.button > 0 || mic.disabled
      || capture || controller.getState().phase !== "idle") return;
    event.preventDefault();
    if (controller.getState().microphoneAuthorized === false && controller.prepare) {
      const owner = currentPersonId();
      if (event.currentTarget === mic) void selectMode("voice");
      showNotice(t("voice.mobile.authorizing"));
      void controller.prepare({ reactivate: true }).then((stream) => {
        if (stream && owner === currentPersonId() && isMobile() && !doc.hidden) showNotice();
      }).catch(() => { if (owner === currentPersonId()) showNotice(controller.getState().microphoneError || t("voice.mobile.permissionFailed")); }).finally(() => {
        ignoreClickUntil = Date.now() + 800;
        render();
      });
      render();
      return;
    }
    // Prime audio inside pointerdown, rather than the 300ms hold timer (Safari).
    ignoreClickUntil = 0;
    const target = { pointerId: event.pointerId, element: event.currentTarget, started: false, startY: event.clientY };
    gesture = target;
    if (controller.prepare) {
      const owner = currentPersonId(), composer = sessionId();
      void controller.prepare({ reactivate: true }).then((stream) => {
        if (stream && owner === currentPersonId() && composer === sessionId() && !capture && !doc.hidden) showNotice();
      }).catch(() => {
        if (owner !== currentPersonId() || composer !== sessionId() || doc.hidden) return;
        if (gesture === target) discardGesture();
        if (!capture) showNotice(controller.getState().microphoneError || t("voice.mobile.permissionFailed"));
      });
    }
    try { target.element.setPointerCapture(event.pointerId); } catch {}
    target.timer = globalScope.setTimeout(() => beginCapture(target), 300);
  }

  function pointerMove(event) {
    if (gesture?.pointerId !== event.pointerId || !capture) return;
    event.preventDefault();
    const distance = gesture.startY - event.clientY;
    // A small deadband prevents finger jitter; dragging back down restores the take.
    capture.choice = distance >= (capture.choice === "cancel" ? 48 : 64) ? "cancel" : "review";
    render();
  }

  function pointerUp(event) {
    if (isMobile()) controller.activateMicrophone?.();
    if (gesture?.pointerId !== event.pointerId) return;
    const wasLong = gesture.started;
    discardGesture();
    if (!wasLong) return;
    event.preventDefault();
    ignoreClickUntil = Date.now() + 800;
    const target = capture;
    if (!target) return;
    if (target.choice === "cancel") return cancelCapture({ restore: true });
    if (!target.completed && controller.getState().phase !== "recording") {
      return cancelCapture({ restore: true, notice: t("voice.mobile.tryAgain"), keepMicrophone: controller.getState().phase === "requesting" });
    }
    target.released = true;
    stopWaveform();
    target.stoppedAt = Date.now();
    if (!target.completed) target.deadline = globalScope.setTimeout(() => {
      if (capture === target) cancelCapture({ notice: t("voice.mobile.failed") });
    }, 30000);
    if (target.completed) void finish(target);
    else void controller.stop().catch(() => {
      if (isCurrent(target)) cancelCapture({ notice: t("voice.mobile.failed") });
    });
    render();
  }

  function pointerCancel(event) {
    if (gesture?.pointerId !== event.pointerId) return;
    discardGesture();
    ignoreClickUntil = Date.now() + 800;
    cancelCapture({ restore: true });
  }

  for (const button of [mic, hold]) {
    button.addEventListener("pointerdown", pointerDown);
    button.addEventListener("pointermove", pointerMove);
    button.addEventListener("pointerup", pointerUp);
    // iOS can grant audio activation on touchend rather than pointerdown.
    button.addEventListener("touchend", () => { if (isMobile()) controller.activateMicrophone?.(); }, { passive: true });
    button.addEventListener("pointercancel", pointerCancel);
    button.addEventListener("lostpointercapture", pointerCancel);
    button.addEventListener("contextmenu", (event) => { if (isMobile()) event.preventDefault(); });
    button.addEventListener("click", (event) => {
      if (!isMobile()) return;
      if (button === mic && !capture && controller.getState().phase !== "idle") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Date.now() < ignoreClickUntil || capture) return;
      if (button === mic) void selectMode("voice");
      // Keyboard and screen-reader activation offers editable dictation without a hold gesture.
      else if (event.detail === 0) void controller.start().catch(() => showNotice(t("voice.mobile.failed")));
    }, true);
  }
  modeButton.addEventListener("click", () => { void selectMode(hold.hidden ? "voice" : "text"); });
  cancel.addEventListener("click", () => { discardGesture(); cancelCapture({ restore: true }); });
  doc.getElementById("sendBtn")?.addEventListener("click", (event) => {
    if (capture) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  msgInput.addEventListener("keydown", (event) => {
    if (capture && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  });
  msgInput.addEventListener("input", (event) => {
    if (event.isTrusted) requestedVoice = false;
    if (capture && event.isTrusted) cancelCapture();
    render();
  });

  globalScope.addEventListener("remotelab:voice-state-change", (event) => {
    if (capture) {
      if (!isCurrent(capture)) {
        discardGesture();
        cancelCapture();
      } else if (event.detail.phase === "recording" && !capture.startedAt) {
        capture.startedAt = Date.now();
        globalScope.navigator.vibrate?.(15);
      } else if (event.detail.phase === "idle" && !capture.completed) {
        cancelCapture({ notice: event.detail.microphoneError || t("voice.mobile.failed") });
      }
    }
    render();
  });
  globalScope.addEventListener("remotelab:voice-transcript-complete", (event) => {
    const target = capture;
    if (!target || target.captureId !== event.detail?.captureId || !isCurrent(target)) return;
    target.completed = true;
    if (target.deadline) globalScope.clearTimeout(target.deadline);
    if (target.released) void finish(target);
    render();
  });
  function interrupt() {
    discardGesture();
    cancelCapture();
    if (doc.hidden || !isMobile()) controller.releaseMicrophone?.();
  }
  doc.addEventListener("visibilitychange", () => { if (doc.hidden) interrupt(); });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && capture) { event.preventDefault(); discardGesture(); cancelCapture({ restore: true }); }
  });
  globalScope.addEventListener("pagehide", interrupt);
  globalScope.addEventListener("blur", interrupt);
  globalScope.addEventListener("remotelab:localechange", render);
  media.addEventListener("change", () => { if (!isMobile()) interrupt(); render(); });
  globalScope.remotelabRefreshMobileVoiceUi = render;
  render();
})(window);

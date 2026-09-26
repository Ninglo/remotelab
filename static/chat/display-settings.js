"use strict";

(function attachDisplaySettings() {
  const panel = document.getElementById("settingsPanel");
  const settingsTab = document.getElementById("tabSettings");
  let loaded = false;
  let contentLoaded = false;
  let contentConfigured = false;
  let previewObjectUrl = "";

  function personalCopy(key) {
    const zh = {
      heading: "简版画面", note: "上传 GIF、写一句话。保存后会从详细画面切回这个简版画面。",
      gif: "动图（GIF，最多 3 MB、640 × 480、48 帧）", sentence: "一句话（最多 48 字）",
      placeholder: "例如：我正在处理今天最重要的事", save: "保存并显示", reset: "恢复状态屏",
      empty: "选择 GIF 后可在这里预览", saving: "正在保存画面…", saved: "画面已保存；设备配对后会自动显示。",
      loading: "正在读取画面…", failed: "画面设置失败", tooLarge: "GIF 不能超过 3 MB。",
      required: "请选择 GIF 并填写一句话。", resetDone: "已恢复状态屏。", details: "打开详细设置 ↗",
    };
    const en = {
      heading: "Simple display", note: "Upload a GIF and write one sentence. Saving switches the display from detailed mode to this simple view.",
      gif: "Animation (GIF, up to 3 MB, 640 × 480, 48 frames)", sentence: "One sentence (up to 48 characters)",
      placeholder: "For example: Working on today's most important task", save: "Save and show", reset: "Restore status screen",
      empty: "Choose a GIF to preview it here", saving: "Saving display…", saved: "Saved. Your display will show this after pairing.",
      loading: "Loading display…", failed: "Could not save display", tooLarge: "GIF must be 3 MB or smaller.",
      required: "Choose a GIF and enter one sentence.", resetDone: "Status screen restored.", details: "Detailed settings ↗",
    };
    return (document.documentElement.lang || "").toLowerCase().startsWith("zh") ? zh[key] : en[key];
  }

  function translate(key, vars) {
    return window.remotelabT ? window.remotelabT(key, vars) : key;
  }

  function ensureSection() {
    if (!panel) return null;
    let section = document.getElementById("settingsDisplaySection");
    if (section) return section;
    section = document.createElement("div");
    section.className = "settings-section settings-display-section";
    section.id = "settingsDisplaySection";
    section.innerHTML = `
      <div class="settings-section-heading">
        <div>
          <div class="settings-section-title" data-display-copy="title"></div>
          <div class="settings-section-note" data-display-copy="note"></div>
        </div>
        <div class="settings-display-heading-actions">
          <a class="settings-app-btn settings-display-details" id="settingsDisplayDetails" href="/public-pages/secondary-display-studio/index.html"></a>
          <button class="settings-app-btn settings-display-generate" id="settingsDisplayGenerate" type="button"></button>
        </div>
      </div>
      <div class="settings-display-command" id="settingsDisplayCommandPanel" hidden>
        <div class="settings-section-note" data-display-copy="commandHelp"></div>
        <code id="settingsDisplayCommand"></code>
        <button class="settings-app-btn" id="settingsDisplayCopy" type="button"></button>
      </div>
      <div class="settings-display-personal">
        <div class="settings-display-devices-heading" id="settingsDisplayPersonalHeading"></div>
        <p class="settings-section-note" id="settingsDisplayPersonalNote"></p>
        <div class="settings-display-preview" id="settingsDisplayPreview">
          <div class="settings-display-preview-image"><img id="settingsDisplayGifPreview" alt="" hidden><span id="settingsDisplayPreviewEmpty"></span></div>
          <div class="settings-display-preview-text" id="settingsDisplaySentencePreview"></div>
        </div>
        <label class="settings-display-field"><span id="settingsDisplayGifLabel"></span><input id="settingsDisplayGif" type="file" accept="image/gif,.gif"></label>
        <label class="settings-display-field"><span id="settingsDisplaySentenceLabel"></span><input id="settingsDisplaySentence" type="text" maxlength="48" autocomplete="off"></label>
        <div class="settings-display-personal-actions">
          <button class="settings-app-btn" id="settingsDisplaySave" type="button"></button>
          <button class="settings-app-btn" id="settingsDisplayReset" type="button" hidden></button>
        </div>
        <div class="settings-app-empty inline-status" id="settingsDisplayPersonalStatus" role="status" aria-live="polite"></div>
      </div>
      <div class="settings-display-devices-heading" data-display-copy="devices"></div>
      <div class="settings-apps-list" id="settingsDisplayDevices"></div>
      <div class="settings-app-empty inline-status" id="settingsDisplayStatus" role="status" aria-live="polite"></div>
    `;
    const deviceSettings = document.querySelector("#settings-device .settings-group-body");
    if (deviceSettings) deviceSettings.prepend(section);
    else panel.appendChild(section);
    document.getElementById("settingsDisplayGenerate")?.addEventListener("click", () => void generateEnrollment());
    document.getElementById("settingsDisplayCopy")?.addEventListener("click", event => void copyCommand(event.currentTarget));
    document.getElementById("settingsDisplayGif")?.addEventListener("change", updatePersonalPreview);
    document.getElementById("settingsDisplaySentence")?.addEventListener("input", updatePersonalPreview);
    document.getElementById("settingsDisplaySave")?.addEventListener("click", () => void saveContent());
    document.getElementById("settingsDisplayReset")?.addEventListener("click", () => void resetContent());
    renderCopy();
    return section;
  }

  function renderCopy() {
    const section = ensureSection();
    if (!section) return;
    for (const node of section.querySelectorAll("[data-display-copy]")) {
      node.textContent = translate(`settings.display.${node.dataset.displayCopy}`);
    }
    const generate = document.getElementById("settingsDisplayGenerate");
    const copy = document.getElementById("settingsDisplayCopy");
    if (generate && !generate.disabled) generate.textContent = translate("settings.display.generate");
    if (copy) copy.textContent = translate("settings.display.copy");
    for (const [id, key] of [
      ["settingsDisplayPersonalHeading", "heading"], ["settingsDisplayPersonalNote", "note"],
      ["settingsDisplayGifLabel", "gif"], ["settingsDisplaySentenceLabel", "sentence"],
      ["settingsDisplaySave", "save"], ["settingsDisplayReset", "reset"],
      ["settingsDisplayPreviewEmpty", "empty"],
      ["settingsDisplayDetails", "details"],
    ]) {
      const node = document.getElementById(id);
      if (node) node.textContent = personalCopy(key);
    }
    const sentence = document.getElementById("settingsDisplaySentence");
    if (sentence) sentence.placeholder = personalCopy("placeholder");
  }

  function personalStatus(message = "", error = false) {
    const node = document.getElementById("settingsDisplayPersonalStatus");
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
    node.classList.toggle("error", error);
  }

  function updatePersonalPreview() {
    const file = document.getElementById("settingsDisplayGif")?.files?.[0];
    const image = document.getElementById("settingsDisplayGifPreview");
    const empty = document.getElementById("settingsDisplayPreviewEmpty");
    if (file && image) {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = URL.createObjectURL(file);
      image.src = previewObjectUrl;
      image.hidden = false;
    }
    if (empty) empty.hidden = Boolean(image?.src);
    const sentence = document.getElementById("settingsDisplaySentence");
    const preview = document.getElementById("settingsDisplaySentencePreview");
    if (preview) preview.textContent = sentence?.value?.trim() || personalCopy("sentence");
  }

  async function loadContent({ force = false } = {}) {
    if (contentLoaded && !force) return;
    personalStatus(personalCopy("loading"));
    try {
      const payload = await fetchJsonOrRedirect("/api/display/content", { revalidate: false });
      contentConfigured = Boolean(payload?.configured);
      const sentence = document.getElementById("settingsDisplaySentence");
      const image = document.getElementById("settingsDisplayGifPreview");
      if (sentence) sentence.value = payload?.sentence || "";
      if (image && contentConfigured) {
        image.src = `/api/display/content.gif?v=${encodeURIComponent(payload.updatedAt || Date.now())}`;
        image.hidden = false;
      } else if (image) {
        image.removeAttribute("src");
        image.hidden = true;
      }
      const reset = document.getElementById("settingsDisplayReset");
      if (reset) reset.hidden = !contentConfigured;
      updatePersonalPreview();
      personalStatus();
      contentLoaded = true;
    } catch (error) {
      personalStatus(error?.message || personalCopy("failed"), true);
    }
  }

  async function fileBase64(file) {
    const result = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return String(result).split(",", 2)[1] || "";
  }

  async function saveContent() {
    const file = document.getElementById("settingsDisplayGif")?.files?.[0];
    const sentence = document.getElementById("settingsDisplaySentence")?.value?.trim() || "";
    if (!sentence || (!file && !contentConfigured)) { personalStatus(personalCopy("required"), true); return; }
    if (file && file.size > 3 * 1024 * 1024) { personalStatus(personalCopy("tooLarge"), true); return; }
    const button = document.getElementById("settingsDisplaySave");
    if (button) button.disabled = true;
    personalStatus(personalCopy("saving"));
    try {
      const gifBase64 = file ? await fileBase64(file) : undefined;
      await fetchJsonOrRedirect("/api/display/content", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence, gifBase64 }), revalidate: false,
      });
      await fetchJsonOrRedirect("/api/display/studio-preview", { method: "DELETE", revalidate: false });
      const input = document.getElementById("settingsDisplayGif");
      if (input) input.value = "";
      if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = ""; }
      contentLoaded = false;
      await loadContent({ force: true });
      personalStatus(personalCopy("saved"));
    } catch (error) { personalStatus(error?.message || personalCopy("failed"), true); }
    finally { if (button) button.disabled = false; }
  }

  async function resetContent() {
    const button = document.getElementById("settingsDisplayReset");
    if (button) button.disabled = true;
    try {
      await fetchJsonOrRedirect("/api/display/content", { method: "DELETE", revalidate: false });
      await fetchJsonOrRedirect("/api/display/studio-preview", { method: "DELETE", revalidate: false });
      contentLoaded = false;
      await loadContent({ force: true });
      personalStatus(personalCopy("resetDone"));
    } catch (error) { personalStatus(error?.message || personalCopy("failed"), true); }
    finally { if (button) button.disabled = false; }
  }

  function setStatus(message = "", { error = false } = {}) {
    const status = document.getElementById("settingsDisplayStatus");
    if (!status) return;
    status.hidden = !message;
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function lastSeenCopy(device) {
    const lastSeen = Date.parse(device?.lastSeenAt || "");
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen < 90_000) return translate("settings.display.connected");
    if (!Number.isFinite(lastSeen)) return translate("settings.display.empty");
    return translate("settings.display.lastSeen", {
      time: new Date(lastSeen).toLocaleString(document.documentElement.lang || undefined),
    });
  }

  function renderDevice(device) {
    const card = document.createElement("div");
    card.className = "settings-app-card settings-display-device";
    const header = document.createElement("div");
    header.className = "settings-app-card-header";
    const name = document.createElement("div");
    name.className = "settings-app-name";
    name.textContent = device.name || "RemoteLab Display";
    const state = document.createElement("div");
    state.className = "settings-app-kind";
    state.textContent = lastSeenCopy(device);
    header.append(name, state);
    const meta = document.createElement("div");
    meta.className = "settings-app-meta";
    meta.textContent = [device.platform, device.id].filter(Boolean).join(" · ");
    const actions = document.createElement("div");
    actions.className = "settings-app-actions";
    const disconnect = document.createElement("button");
    disconnect.className = "settings-app-btn settings-display-disconnect";
    disconnect.type = "button";
    disconnect.textContent = translate("settings.display.disconnect");
    disconnect.addEventListener("click", async () => {
      if (!window.confirm(translate("settings.display.disconnectConfirm"))) return;
      disconnect.disabled = true;
      try {
        await fetchJsonOrRedirect(`/api/display/devices/${encodeURIComponent(device.id)}`, {
          method: "DELETE",
          revalidate: false,
        });
        await load({ force: true });
      } catch (error) {
        setStatus(error?.message || translate("settings.display.actionFailed"), { error: true });
        disconnect.disabled = false;
      }
    });
    actions.appendChild(disconnect);
    card.append(header, meta, actions);
    return card;
  }

  async function load({ force = false } = {}) {
    if (!ensureSection() || (loaded && !force)) return;
    const root = document.getElementById("settingsDisplayDevices");
    if (!root) return;
    setStatus(translate("settings.display.loading"));
    try {
      const payload = await fetchJsonOrRedirect("/api/display/devices", { revalidate: false });
      const devices = Array.isArray(payload?.devices) ? payload.devices : [];
      root.replaceChildren(...devices.map(renderDevice));
      setStatus(devices.length ? "" : translate("settings.display.empty"));
      loaded = true;
    } catch (error) {
      setStatus(error?.message || translate("settings.display.loadFailed"), { error: true });
    }
  }

  async function generateEnrollment() {
    const button = document.getElementById("settingsDisplayGenerate");
    if (!button) return;
    button.disabled = true;
    button.textContent = translate("settings.display.generating");
    setStatus();
    try {
      const payload = await fetchJsonOrRedirect("/api/display/enrollments", { method: "POST", revalidate: false });
      const command = document.getElementById("settingsDisplayCommand");
      const commandPanel = document.getElementById("settingsDisplayCommandPanel");
      if (command) command.textContent = payload?.command || "";
      if (commandPanel) commandPanel.hidden = !payload?.command;
    } catch (error) {
      setStatus(error?.message || translate("settings.display.actionFailed"), { error: true });
    } finally {
      button.disabled = false;
      button.textContent = translate("settings.display.generate");
    }
  }

  async function copyCommand(button) {
    const command = document.getElementById("settingsDisplayCommand")?.textContent || "";
    if (!command) return;
    if (typeof copyText === "function") await copyText(command);
    else await navigator.clipboard.writeText(command);
    button.textContent = translate("settings.display.copied");
  }

  ensureSection();
  void load();
  void loadContent();
  settingsTab?.addEventListener("click", () => { void load({ force: true }); void loadContent({ force: true }); });
  window.addEventListener("remotelab:localechange", () => {
    renderCopy();
    if (loaded) void load({ force: true });
  });
})();

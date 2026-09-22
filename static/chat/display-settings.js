"use strict";

(function attachDisplaySettings() {
  const panel = document.getElementById("settingsPanel");
  const settingsTab = document.getElementById("tabSettings");
  let loaded = false;

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
        <button class="settings-app-btn settings-display-generate" id="settingsDisplayGenerate" type="button"></button>
      </div>
      <div class="settings-display-command" id="settingsDisplayCommandPanel" hidden>
        <div class="settings-section-note" data-display-copy="commandHelp"></div>
        <code id="settingsDisplayCommand"></code>
        <button class="settings-app-btn" id="settingsDisplayCopy" type="button"></button>
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
  settingsTab?.addEventListener("click", () => void load({ force: true }));
  window.addEventListener("remotelab:localechange", () => {
    renderCopy();
    if (loaded) void load({ force: true });
  });
})();

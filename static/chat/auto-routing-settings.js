// Instance-wide Auto routing controls. Preview reads the current form without
// changing a Session or saving the candidate settings.
const autoRoutingTierGrid = document.getElementById("autoRoutingTierGrid");
const autoRoutingQuickPrompt = document.getElementById("autoRoutingQuickPrompt");
const autoRoutingSaveBtn = document.getElementById("autoRoutingSaveBtn");
const autoRoutingSaveStatus = document.getElementById("autoRoutingSaveStatus");
const autoRoutingPreviewInput = document.getElementById("autoRoutingPreviewInput");
const autoRoutingPreviewBtn = document.getElementById("autoRoutingPreviewBtn");
const autoRoutingPreviewResult = document.getElementById("autoRoutingPreviewResult");
const autoRoutingPreviewDetails = document.getElementById("autoRoutingPreviewDetails");
const AUTO_ROUTING_TIER_ORDER = ["quick", "balanced", "quality", "sota", "economy"];
const AUTO_ROUTING_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
let autoRoutingSettingsLoaded = false;

function autoRoutingLabel(key) {
  return window.remotelabT ? window.remotelabT(key) : key;
}

function renderAutoRoutingSettings(settings) {
  if (!autoRoutingTierGrid) return;
  autoRoutingTierGrid.replaceChildren();
  for (const tier of AUTO_ROUTING_TIER_ORDER) {
    const profile = settings?.tiers?.[tier] || {};
    const row = document.createElement("div");
    row.className = "auto-routing-tier-row";
    row.dataset.tier = tier;
    const label = document.createElement("span");
    label.textContent = autoRoutingLabel(`tooling.preset.${tier}`);
    const model = document.createElement("input");
    model.className = "settings-inline-input auto-routing-model";
    model.value = profile.model || "";
    model.maxLength = 120;
    model.setAttribute("aria-label", `${label.textContent} model`);
    const effort = document.createElement("select");
    effort.className = "settings-inline-select auto-routing-effort";
    effort.setAttribute("aria-label", `${label.textContent} effort`);
    for (const level of AUTO_ROUTING_EFFORT_LEVELS) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      effort.appendChild(option);
    }
    effort.value = profile.effort || "medium";
    row.append(label, model, effort);
    autoRoutingTierGrid.appendChild(row);
  }
  autoRoutingQuickPrompt.value = settings?.quickPrompt || "";
}

function readAutoRoutingTierFields() {
  const tiers = {};
  for (const row of autoRoutingTierGrid.querySelectorAll("[data-tier]")) {
    tiers[row.dataset.tier] = {
      model: row.querySelector(".auto-routing-model")?.value.trim() || "",
      effort: row.querySelector(".auto-routing-effort")?.value || "",
    };
  }
  return tiers;
}

async function loadAutoRoutingSettings() {
  if (!autoRoutingTierGrid || autoRoutingSettingsLoaded) return;
  autoRoutingSaveStatus.textContent = "";
  try {
    const data = await fetchJsonOrRedirect("/api/auto-routing", { revalidate: false });
    renderAutoRoutingSettings(data.settings);
    autoRoutingSettingsLoaded = true;
  } catch (error) {
    autoRoutingSaveStatus.textContent = error?.message || String(error);
  }
}

autoRoutingSaveBtn?.addEventListener("click", async () => {
  autoRoutingSaveBtn.disabled = true;
  autoRoutingSaveStatus.textContent = "";
  try {
    const data = await fetchJsonOrRedirect("/api/auto-routing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tiers: readAutoRoutingTierFields(), quickPrompt: autoRoutingQuickPrompt.value }),
      revalidate: false,
    });
    renderAutoRoutingSettings(data.settings);
    autoRoutingSaveStatus.textContent = autoRoutingLabel("settings.autoRouting.saved");
    if (typeof loadRuntimePresetCatalog === "function") await loadRuntimePresetCatalog();
  } catch (error) {
    autoRoutingSaveStatus.textContent = error?.message || String(error);
  } finally {
    autoRoutingSaveBtn.disabled = false;
  }
});

autoRoutingPreviewBtn?.addEventListener("click", async () => {
  autoRoutingPreviewBtn.disabled = true;
  autoRoutingPreviewResult.textContent = "";
  autoRoutingPreviewDetails.hidden = true;
  try {
    const data = await fetchJsonOrRedirect("/api/auto-routing/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: autoRoutingPreviewInput.value, tiers: readAutoRoutingTierFields() }),
      revalidate: false,
    });
    const tier = autoRoutingLabel(`tooling.preset.${data.tier}`);
    const fallback = data.receipt?.status === "fallback" ? ` · fallback: ${data.receipt.reason}` : "";
    autoRoutingPreviewResult.textContent = `${tier} → ${data.model} · ${data.effort}${fallback}`;
    autoRoutingPreviewDetails.textContent = JSON.stringify(data.receipt?.decision || {
      status: data.receipt?.status,
      reason: data.receipt?.reason,
      latencyMs: data.receipt?.latencyMs,
    }, null, 2);
    autoRoutingPreviewDetails.hidden = false;
  } catch (error) {
    autoRoutingPreviewResult.textContent = error?.message || String(error);
  } finally {
    autoRoutingPreviewBtn.disabled = false;
  }
});

window.addEventListener("remotelab:localechange", () => {
  for (const row of autoRoutingTierGrid?.querySelectorAll("[data-tier]") || []) {
    row.firstElementChild.textContent = autoRoutingLabel(`tooling.preset.${row.dataset.tier}`);
  }
});
tabSettings?.addEventListener("click", () => { void loadAutoRoutingSettings(); });
if (typeof activeTab !== "undefined" && activeTab === "settings") void loadAutoRoutingSettings();

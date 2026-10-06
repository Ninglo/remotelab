"use strict";

// Personal navigation follows the signed-in Person, not a browser-local draft.
(function attachAmberQuickLinks() {
  if (typeof bootstrapAuthInfo === "undefined" || !bootstrapAuthInfo?.person?.id) return;
  const host = document.querySelector("#sessionWorkspace .pet-quota-pilot");
  if (!host || typeof getPeopleDirectory !== "function") return;
  const root = document.createElement("nav");
  root.className = "amber-quick-links";
  host.append(root);

  function render() {
    root.replaceChildren();
    root.setAttribute("aria-label", (document.documentElement.lang || "").startsWith("zh")
      ? "我的快捷入口" : "My quick links");
    const links = getPeopleDirectory().find((person) => person.id === bootstrapAuthInfo.person.id)
      ?.preferences?.quickLinks;
    for (const link of (Array.isArray(links) ? links : []).slice(0, 6)) {
      if (typeof link?.label !== "string" || !link.label.trim() || typeof link.url !== "string") continue;
      let url;
      try { url = new URL(link.url); } catch { continue; }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      const anchor = document.createElement("a");
      anchor.className = "pet-quota-pilot-button amber-quick-link";
      anchor.textContent = link.label.trim().slice(0, 40);
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      root.append(anchor);
    }
    root.hidden = root.children.length === 0;
  }
  window.remotelabRefreshQuickLinks = render;
  window.addEventListener("remotelab:localechange", render);
  render();
})();

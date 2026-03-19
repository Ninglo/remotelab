(function () {
  "use strict";

  const nonce = document.currentScript?.nonce || "";
  const splitAssetPaths = [
    "/marked.min.js",
    "/chat/session-state-model.js",
    "/chat/icons.js",
    "/chat/bootstrap.js",
    "/chat/bootstrap-session-catalog.js",
    "/chat/session-http-helpers.js",
    "/chat/session-http-list-state.js",
    "/chat/session-http.js",
    "/chat/layout-tooling.js",
    "/chat/tooling.js",
    "/chat/realtime.js",
    "/chat/realtime-render.js",
    "/chat/ui.js",
    "/chat/session-surface-ui.js",
    "/chat/session-list-ui.js",
    "/chat/settings-ui.js",
    "/chat/sidebar-ui.js",
    "/chat/compose.js",
    "/chat/gestures.js",
    "/chat/init.js",
  ];

  function normalizeAssetVersion(value) {
    if (typeof value !== "string") return "";
    const normalized = value.trim();
    return normalized || "";
  }

  async function resolveAssetVersion() {
    const bootstrapVersion = normalizeAssetVersion(window.__REMOTELAB_BUILD__?.assetVersion);
    if (bootstrapVersion) return bootstrapVersion;

    const currentScriptSrc = document.currentScript?.src || "";
    if (currentScriptSrc) {
      try {
        const url = new URL(currentScriptSrc, window.location.href);
        const scriptVersion = normalizeAssetVersion(url.searchParams.get("v"));
        if (scriptVersion) return scriptVersion;
      } catch {}
    }

    try {
      const response = await fetch("/api/build-info", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return "";
      const data = await response.json().catch(() => null);
      return normalizeAssetVersion(data?.assetVersion);
    } catch {
      return "";
    }
  }

  function buildVersionedAssetPath(path, assetVersion) {
    const normalizedPath = typeof path === "string" ? path : String(path || "");
    if (!assetVersion) return normalizedPath;
    const separator = normalizedPath.includes("?") ? "&" : "?";
    return `${normalizedPath}${separator}v=${encodeURIComponent(assetVersion)}`;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      if (nonce) script.nonce = nonce;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  (async () => {
    const assetVersion = await resolveAssetVersion();
    for (const path of splitAssetPaths) {
      await loadScript(buildVersionedAssetPath(path, assetVersion));
    }
  })().catch((error) => {
    console.error("[chat] Failed to load frontend assets:", error);
  });
})();

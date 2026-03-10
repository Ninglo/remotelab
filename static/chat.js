(function () {
  "use strict";

  const nonce = document.currentScript?.nonce || "";
  const assetPaths = [
    "/chat/bootstrap.js",
    "/chat/session-http.js",
    "/chat/tooling.js",
    "/chat/realtime.js",
    "/chat/ui.js",
    "/chat/compose.js",
    "/chat/init.js",
  ];

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
    for (const src of assetPaths) {
      await loadScript(src);
    }
  })().catch((error) => {
    console.error("[chat] Failed to load frontend assets:", error);
  });
})();

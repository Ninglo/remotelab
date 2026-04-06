"use strict";

(function () {
  // ---- Configuration ----
  const FLUSH_INTERVAL_MS = 30000;
  const MAX_QUEUE_SIZE = 100;
  const STORAGE_KEY_CID = "remotelab.analytics.cid";
  const STORAGE_KEY_QUEUE = "remotelab.analytics.queue";
  const ENDPOINT = "/api/analytics/events";

  // ---- Client identity ----
  function getOrCreateClientId() {
    try {
      let cid = localStorage.getItem(STORAGE_KEY_CID);
      if (cid) return cid;
      cid = "c_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      localStorage.setItem(STORAGE_KEY_CID, cid);
      return cid;
    } catch {
      return "c_anonymous";
    }
  }

  function createPageSessionId() {
    return "s_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }

  const clientId = getOrCreateClientId();
  const pageSessionId = createPageSessionId();
  const pageLoadTime = Date.now();

  // ---- Event queue ----
  let eventQueue = [];
  let flushTimer = null;
  let flushing = false;

  function resolveEndpointUrl() {
    if (typeof window.remotelabResolveProductUrl === "function") {
      return window.remotelabResolveProductUrl(ENDPOINT);
    }
    return ENDPOINT;
  }

  // ---- Core API ----
  function track(event, props, cat) {
    if (!event) return;
    const entry = {
      event,
      cat: cat || "interaction",
      clientTs: new Date().toISOString(),
      cid: clientId,
      sid: pageSessionId,
      props: props || {},
    };
    eventQueue.push(entry);
    if (eventQueue.length >= MAX_QUEUE_SIZE) {
      flush();
    }
  }

  function trackEnv(event, props) {
    track(event, props, "env");
  }

  function trackLifecycle(event, props) {
    track(event, props, "lifecycle");
  }

  function trackError(event, props) {
    track(event, props, "error");
  }

  // ---- Flush mechanism ----
  function flush() {
    if (flushing || eventQueue.length === 0) return;
    flushing = true;
    const batch = eventQueue.splice(0);
    const payload = JSON.stringify({ events: batch });

    fetch(resolveEndpointUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      credentials: "same-origin",
      keepalive: true,
    })
      .catch(function () {
        eventQueue.unshift.apply(eventQueue, batch);
        persistQueue();
      })
      .finally(function () {
        flushing = false;
      });
  }

  function persistQueue() {
    try {
      if (eventQueue.length > 0) {
        localStorage.setItem(
          STORAGE_KEY_QUEUE,
          JSON.stringify(eventQueue.slice(0, 200)),
        );
      }
    } catch {}
  }

  function restoreQueue() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_QUEUE);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          eventQueue.unshift.apply(eventQueue, parsed);
        }
        localStorage.removeItem(STORAGE_KEY_QUEUE);
      }
    } catch {}
  }

  // ---- Lifecycle hooks ----
  function startFlushTimer() {
    if (flushTimer) return;
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  }

  function stopFlushTimer() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  function onPageUnload() {
    stopFlushTimer();
    if (eventQueue.length === 0) return;
    const batch = eventQueue.splice(0);
    const payload = JSON.stringify({ events: batch });
    try {
      navigator.sendBeacon(
        resolveEndpointUrl(),
        new Blob([payload], { type: "application/json" }),
      );
    } catch {
      // Restore and persist for next load
      eventQueue.unshift.apply(eventQueue, batch);
      persistQueue();
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      trackLifecycle("page_hidden", {
        durationSec: Math.round((Date.now() - pageLoadTime) / 1000),
      });
      flush();
    } else if (document.visibilityState === "visible") {
      trackLifecycle("page_visible");
    }
  }

  // ---- Auto-collect environment ----
  function collectEnvironment() {
    var ua = navigator.userAgent || "";
    var isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
    var isStandalone = !!(
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      navigator.standalone === true
    );

    trackEnv("environment", {
      deviceType: isMobile ? "mobile" : "desktop",
      platform: navigator.platform || "",
      screenWidth: screen.width,
      screenHeight: screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      language: navigator.language || "",
      languages: (navigator.languages || []).slice(0, 5),
      isStandalone: isStandalone,
      isMobileDevice: isMobile,
      connectionType:
        (navigator.connection && navigator.connection.effectiveType) || "",
      touchPoints: navigator.maxTouchPoints || 0,
      timezone:
        (Intl.DateTimeFormat &&
          Intl.DateTimeFormat().resolvedOptions().timeZone) ||
        "",
      timezoneOffset: new Date().getTimezoneOffset(),
    });
  }

  // ---- Global error capture ----
  window.addEventListener("error", function (event) {
    trackError("unhandled_error", {
      message: (event.message || "").slice(0, 200),
      filename: (event.filename || "").slice(-100),
      lineno: event.lineno || 0,
      colno: event.colno || 0,
    });
  });

  // ---- Initialize ----
  restoreQueue();
  collectEnvironment();
  trackLifecycle("page_load", {
    referrer: document.referrer || "",
    url: window.location.pathname + window.location.search,
    hash: window.location.hash || "",
  });
  startFlushTimer();

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageUnload);
  window.addEventListener("beforeunload", onPageUnload);

  // ---- Expose global API ----
  window.RemoteLabAnalytics = {
    track: track,
    trackEnv: trackEnv,
    trackLifecycle: trackLifecycle,
    trackError: trackError,
    flush: flush,
    getClientId: function () {
      return clientId;
    },
    getPageSessionId: function () {
      return pageSessionId;
    },
  };
})();

(function attachRemoteLabProductPathHelpers(globalScope) {
  const FALLBACK_ORIGIN = "https://remotelab.invalid";
  const TERMINAL_MARKERS = Object.freeze([
    Object.freeze(["m", "install"]),
    Object.freeze(["login"]),
    Object.freeze(["logout"]),
  ]);
  const BOUNDARY_MARKERS = Object.freeze([
    Object.freeze(["api"]),
    Object.freeze(["ws"]),
    Object.freeze(["share"]),
    Object.freeze(["share-asset"]),
    Object.freeze(["visitor"]),
    Object.freeze(["agent"]),
    Object.freeze(["app"]),
  ]);

  function getLocationObject() {
    if (globalScope && typeof globalScope.location === "object" && globalScope.location) {
      return globalScope.location;
    }
    if (typeof location === "object" && location) {
      return location;
    }
    return null;
  }

  function getLocationHref() {
    const locationObject = getLocationObject();
    if (typeof locationObject?.href === "string" && locationObject.href) {
      return locationObject.href;
    }
    if (typeof locationObject?.origin === "string" && locationObject.origin) {
      return `${locationObject.origin}/`;
    }
    return `${FALLBACK_ORIGIN}/`;
  }

  function getLocationOrigin() {
    try {
      return new URL(getLocationHref(), FALLBACK_ORIGIN).origin;
    } catch {
      return FALLBACK_ORIGIN;
    }
  }

  function splitPathSegments(pathname) {
    return String(pathname || "/")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  function joinPathSegments(segments) {
    return Array.isArray(segments) && segments.length > 0
      ? `/${segments.join("/")}`
      : "/";
  }

  function markerMatchesAt(segments, marker, startIndex) {
    if (!Array.isArray(segments) || !Array.isArray(marker)) return false;
    if (!Number.isInteger(startIndex) || startIndex < 0) return false;
    if (startIndex + marker.length > segments.length) return false;
    for (let index = 0; index < marker.length; index += 1) {
      if (segments[startIndex + index] !== marker[index]) {
        return false;
      }
    }
    return true;
  }

  function inferProductBasePath(pathname) {
    const segments = splitPathSegments(pathname);
    if (segments.length === 0) return "/";

    for (const marker of TERMINAL_MARKERS) {
      const markerStart = segments.length - marker.length;
      if (markerMatchesAt(segments, marker, markerStart)) {
        return joinPathSegments(segments.slice(0, markerStart));
      }
    }

    for (let index = 0; index < segments.length; index += 1) {
      for (const marker of BOUNDARY_MARKERS) {
        if (markerMatchesAt(segments, marker, index)) {
          return joinPathSegments(segments.slice(0, index));
        }
      }
    }

    return joinPathSegments(segments);
  }

  function getExplicitBaseHref() {
    if (!(globalScope && typeof globalScope.document === "object" && globalScope.document)) {
      return "";
    }
    if (typeof globalScope.document.querySelector !== "function") {
      return "";
    }
    const baseElement = globalScope.document.querySelector("base[href]");
    if (!baseElement) return "";
    if (typeof baseElement.getAttribute === "function") {
      const href = baseElement.getAttribute("href");
      return typeof href === "string" ? href.trim() : "";
    }
    return typeof baseElement.href === "string" ? baseElement.href.trim() : "";
  }

  function ensureDirectoryPath(pathname) {
    const normalized = inferProductBasePath(pathname);
    return normalized === "/" ? "/" : `${normalized.replace(/\/+$/, "")}/`;
  }

  function getProductBasePath() {
    const explicitBaseHref = getExplicitBaseHref();
    if (explicitBaseHref) {
      try {
        const explicitBaseUrl = new URL(explicitBaseHref, getLocationHref());
        return inferProductBasePath(explicitBaseUrl.pathname);
      } catch {}
    }

    const locationObject = getLocationObject();
    if (typeof locationObject?.pathname === "string" && locationObject.pathname) {
      return inferProductBasePath(locationObject.pathname);
    }

    try {
      return inferProductBasePath(new URL(getLocationHref(), FALLBACK_ORIGIN).pathname);
    } catch {
      return "/";
    }
  }

  function getProductBaseUrl() {
    return new URL(ensureDirectoryPath(getProductBasePath()), getLocationOrigin()).toString();
  }

  function isAbsoluteUrl(value) {
    return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
  }

  function isAlreadyScopedAbsolutePath(pathname, basePath) {
    if (!pathname.startsWith("/")) return false;
    if (basePath === "/") return true;
    return (
      pathname === basePath
      || pathname.startsWith(`${basePath}/`)
      || pathname.startsWith(`${basePath}?`)
      || pathname.startsWith(`${basePath}#`)
    );
  }

  function resolveProductUrl(value = "") {
    const text = typeof value === "string" ? value.trim() : String(value || "");
    if (!text) {
      return getProductBaseUrl();
    }
    if (isAbsoluteUrl(text)) {
      return text;
    }
    if (text.startsWith("//")) {
      return new URL(text, getLocationHref()).toString();
    }

    const baseUrl = getProductBaseUrl();
    const basePath = getProductBasePath();
    if (text.startsWith("?") || text.startsWith("#")) {
      return new URL(text, baseUrl).toString();
    }
    if (text.startsWith("/")) {
      if (isAlreadyScopedAbsolutePath(text, basePath)) {
        return new URL(text, getLocationOrigin()).toString();
      }
      return new URL(text.slice(1), baseUrl).toString();
    }
    return new URL(text, baseUrl).toString();
  }

  function resolveProductPath(value = "") {
    const resolvedUrl = new URL(resolveProductUrl(value), getLocationHref());
    return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
  }

  globalScope.remotelabGetProductBasePath = getProductBasePath;
  globalScope.remotelabGetProductBaseUrl = getProductBaseUrl;
  globalScope.remotelabResolveProductUrl = resolveProductUrl;
  globalScope.remotelabResolveProductPath = resolveProductPath;
})(typeof window === "object" ? window : globalThis);

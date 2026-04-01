"use strict";

(() => {
  const UI_THEME_STORAGE_KEY = "remotelab.theme";
  const AMBER_THEME = {
    lightThemeColor: "#f6f8ef",
    darkThemeColor: "#f6f8ef",
    faviconHref: "/favicon-amber.png",
    faviconType: "image/png",
    faviconSizes: "64x64",
    svgIconHref: "/icon-amber.svg",
    appleTouchIconHref: "/apple-touch-icon-amber.png",
  };

  const currentScript = document.currentScript;
  const assetVersion = (() => {
    if (!(currentScript instanceof HTMLScriptElement) || !currentScript.src) {
      return "";
    }
    try {
      return new URL(currentScript.src, window.location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  })();

  const lightMeta = document.getElementById("themeColorLightMeta");
  const darkMeta = document.getElementById("themeColorDarkMeta");
  const faviconLink = document.getElementById("appFaviconLink");
  const svgIconLink = document.getElementById("appSvgIconLink");
  const appleTouchIconLink = document.getElementById("appAppleTouchIconLink");

  const systemTheme = {
    lightThemeColor: lightMeta?.getAttribute("content") || "",
    darkThemeColor: darkMeta?.getAttribute("content") || "",
    faviconHref: faviconLink?.getAttribute("href") || "",
    faviconType: faviconLink?.getAttribute("type"),
    faviconSizes: faviconLink?.getAttribute("sizes"),
    svgIconHref: svgIconLink?.getAttribute("href") || "",
    appleTouchIconHref: appleTouchIconLink?.getAttribute("href") || "",
  };

  function normalizeThemePreference(value) {
    return value === "amber" ? "amber" : "system";
  }

  function readStoredThemePreference() {
    try {
      return normalizeThemePreference(localStorage.getItem(UI_THEME_STORAGE_KEY));
    } catch {
      return "system";
    }
  }

  function buildAssetHref(path) {
    if (typeof path !== "string" || !path) return "";
    if (!assetVersion) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}v=${encodeURIComponent(assetVersion)}`;
  }

  function setAttributeOrRemove(element, name, value) {
    if (!element) return;
    if (typeof value === "string" && value) {
      element.setAttribute(name, value);
      return;
    }
    element.removeAttribute(name);
  }

  function applyThemeBranding(themePreference) {
    const normalized = normalizeThemePreference(themePreference);
    const themeConfig = normalized === "amber"
      ? {
          lightThemeColor: AMBER_THEME.lightThemeColor,
          darkThemeColor: AMBER_THEME.darkThemeColor,
          faviconHref: buildAssetHref(AMBER_THEME.faviconHref),
          faviconType: AMBER_THEME.faviconType,
          faviconSizes: AMBER_THEME.faviconSizes,
          svgIconHref: buildAssetHref(AMBER_THEME.svgIconHref),
          appleTouchIconHref: buildAssetHref(AMBER_THEME.appleTouchIconHref),
        }
      : systemTheme;

    setAttributeOrRemove(lightMeta, "content", themeConfig.lightThemeColor);
    setAttributeOrRemove(darkMeta, "content", themeConfig.darkThemeColor);
    setAttributeOrRemove(faviconLink, "href", themeConfig.faviconHref);
    setAttributeOrRemove(faviconLink, "type", themeConfig.faviconType);
    setAttributeOrRemove(faviconLink, "sizes", themeConfig.faviconSizes);
    setAttributeOrRemove(svgIconLink, "href", themeConfig.svgIconHref);
    setAttributeOrRemove(appleTouchIconLink, "href", themeConfig.appleTouchIconHref);

    return normalized;
  }

  window.remotelabApplyThemeBranding = applyThemeBranding;
  applyThemeBranding(readStoredThemePreference());

  window.addEventListener("storage", (event) => {
    if (event.key && event.key !== UI_THEME_STORAGE_KEY) return;
    applyThemeBranding(event.newValue);
  });

  window.addEventListener("remotelab:themechange", (event) => {
    applyThemeBranding(event.detail?.preference);
  });
})();

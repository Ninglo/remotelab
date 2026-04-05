(function () {
  const STORAGE_KEY = "remotelab.theme";
  const MODES = ["auto", "dark", "light"];
  const LABELS = {
    auto: "Auto",
    dark: "Dark",
    light: "Light",
  };

  const root = document.documentElement;
  const toggleBtn = document.getElementById("themeToggleBtn");
  const toggleLabel = document.getElementById("themeToggleLabel");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  if (!toggleBtn || !toggleLabel) {
    return;
  }

  function readStoredMode() {
    try {
      const value = String(window.localStorage.getItem(STORAGE_KEY) || "").trim().toLowerCase();
      return MODES.includes(value) ? value : "auto";
    } catch {
      return "auto";
    }
  }

  function writeStoredMode(mode) {
    try {
      if (mode === "auto") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, mode);
      }
    } catch {
      // Best-effort persistence only.
    }
  }

  function resolveEffectiveTheme(mode) {
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
    return darkQuery.matches ? "dark" : "light";
  }

  function syncThemeColorMeta(effectiveTheme) {
    const color = effectiveTheme === "dark" ? "#1e1e1e" : "#ffffff";
    const nodes = document.querySelectorAll('meta[name="theme-color"]');
    if (!nodes.length) return;
    nodes.forEach((node) => {
      node.setAttribute("content", color);
      node.removeAttribute("media");
    });
  }

  function applyMode(mode) {
    const nextMode = MODES.includes(mode) ? mode : "auto";
    if (nextMode === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", nextMode);
    }

    const effectiveTheme = resolveEffectiveTheme(nextMode);
    toggleLabel.textContent = LABELS[nextMode] || LABELS.auto;
    toggleBtn.setAttribute("title", `Theme mode: ${nextMode}`);
    toggleBtn.setAttribute("aria-label", `Theme mode: ${nextMode}`);
    toggleBtn.dataset.themeMode = nextMode;
    toggleBtn.dataset.themeResolved = effectiveTheme;
    syncThemeColorMeta(effectiveTheme);

    return nextMode;
  }

  function nextMode(mode) {
    const index = MODES.indexOf(mode);
    return MODES[(index + 1) % MODES.length];
  }

  let currentMode = applyMode(readStoredMode());

  toggleBtn.addEventListener("click", () => {
    currentMode = nextMode(currentMode);
    currentMode = applyMode(currentMode);
    writeStoredMode(currentMode);
  });

  darkQuery.addEventListener("change", () => {
    if (currentMode !== "auto") return;
    applyMode("auto");
  });
})();

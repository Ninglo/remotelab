"use strict";

(function attachVoiceShortcut(globalScope) {
  const voiceBtn = globalScope.document?.getElementById("voiceBtn");
  const modifierCodes = new Set(["AltLeft", "AltRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);
  const allowedCode = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Enter|Escape|Tab|Arrow(?:Up|Down|Left|Right)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;
  let recording = false;
  let optionTaps = 0;
  let optionDown = false;
  let lastOptionRelease = 0;
  let shiftTaps = 0;
  let shiftDown = false;
  let lastShiftRelease = 0;
  const pressedModifiers = new Set();

  function currentPreference() {
    const personId = typeof currentPerson !== "undefined" ? currentPerson?.id : "";
    const people = typeof getPeopleDirectory === "function" ? getPeopleDirectory() : [];
    return people.find((person) => person.id === personId)?.preferences?.voiceShortcut || { enabled: false, binding: "" };
  }

  function bindingFromEvent(event) {
    const code = String(event?.code || "");
    if (event?.repeat || event?.isComposing || modifierCodes.has(code) || !allowedCode.test(code)) return "";
    const modifiers = [
      event.ctrlKey ? "Ctrl" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
      event.metaKey ? "Meta" : "",
    ].filter(Boolean);
    if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(code)) return "";
    return [...modifiers, code].join("+");
  }

  function formatBinding(binding) {
    if (binding === "Alt*3") return typeof t === "function" ? t("settings.voiceShortcut.tripleOption") : "Option ×3";
    if (binding === "Shift*2") return typeof t === "function" ? t("settings.voiceShortcut.doubleShift") : "Shift ×2";
    const labels = { Ctrl: "Ctrl", Alt: "Option", Shift: "Shift", Meta: "⌘", Space: "Space", Enter: "Enter", Escape: "Esc", Tab: "Tab" };
    return String(binding || "").split("+").map((part) => labels[part] || part.replace(/^Key/, "").replace(/^Digit/, "")).join(" + ");
  }

  function resetOptionTaps() {
    optionTaps = 0;
    optionDown = false;
    lastOptionRelease = 0;
  }

  function resetShiftTaps() {
    shiftTaps = 0;
    shiftDown = false;
    lastShiftRelease = 0;
  }

  function resetTaps() {
    resetOptionTaps();
    resetShiftTaps();
  }

  function modifierFromEvent(event) {
    const code = String(event?.code || "");
    if (code === "AltLeft" || code === "AltRight" || event?.key === "Alt") return "Alt";
    if (code === "ShiftLeft" || code === "ShiftRight" || event?.key === "Shift") return "Shift";
    if (code === "ControlLeft" || code === "ControlRight" || event?.key === "Control") return "Ctrl";
    if (code === "MetaLeft" || code === "MetaRight" || event?.key === "Meta") return "Meta";
    return "";
  }

  function modifierChordFromEvent(event, pressed = pressedModifiers) {
    if (event?.repeat || event?.isComposing) return "";
    if (!modifierFromEvent(event)) return "";
    const active = (name, flag, pressedName = name) => flag === true
      || event?.getModifierState?.(name) === true || pressed?.has(pressedName);
    return active("Alt", event.altKey) && active("Shift", event.shiftKey)
      && !active("Control", event.ctrlKey, "Ctrl") && !active("Meta", event.metaKey)
      ? "Alt+Shift" : "";
  }

  function getBindingConflict(binding) {
    if (binding === "Ctrl+KeyO" || binding === "Meta+KeyO" || binding === "Ctrl+Meta+KeyO") return "newSession";
    if (/^(?:Ctrl|Meta)\+Key[RTLWNP]$/.test(binding)) return "browser";
    return "";
  }

  function activateVoice(event) {
    if (!voiceBtn || voiceBtn.disabled) return;
    event.preventDefault?.();
    voiceBtn.click();
  }

  globalScope.document?.addEventListener("keydown", (event) => {
    if (recording || event.defaultPrevented || event.isComposing) {
      resetTaps();
      pressedModifiers.clear();
      return;
    }
    const modifier = modifierFromEvent(event);
    if (modifier) pressedModifiers.add(modifier);
    else pressedModifiers.clear();
    const preference = currentPreference();
    if (preference.enabled !== true) {
      resetTaps();
      return;
    }
    if (preference.binding === "Alt*3") {
      if (modifier !== "Alt") {
        resetTaps();
        return;
      }
      if (event.ctrlKey || event.shiftKey || event.metaKey) {
        resetTaps();
        return;
      }
      if (event.repeat || optionDown) return;
      if (lastOptionRelease && Date.now() - lastOptionRelease > 650) optionTaps = 0;
      optionDown = true;
      optionTaps += 1;
      if (optionTaps === 3) {
        resetTaps();
        activateVoice(event);
      }
      return;
    }
    if (preference.binding === "Shift*2") {
      if (modifier !== "Shift") {
        resetTaps();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) {
        resetTaps();
        return;
      }
      if (event.repeat || shiftDown) return;
      if (lastShiftRelease && Date.now() - lastShiftRelease > 650) shiftTaps = 0;
      shiftDown = true;
      shiftTaps += 1;
      if (shiftTaps === 2) {
        resetTaps();
        activateVoice(event);
      }
      return;
    }
    resetTaps();
    if (preference.binding === "Alt+Shift") {
      if (modifierChordFromEvent(event)) activateVoice(event);
      return;
    }
    if (getBindingConflict(preference.binding) === "newSession") return;
    const pressedBinding = bindingFromEvent(event);
    if (pressedBinding && pressedBinding === preference.binding) activateVoice(event);
  });

  globalScope.document?.addEventListener("keyup", (event) => {
    const modifier = modifierFromEvent(event);
    if (modifier) pressedModifiers.delete(modifier);
    if (modifier === "Alt") {
      optionDown = false;
      lastOptionRelease = Date.now();
    }
    if (modifier === "Shift") {
      shiftDown = false;
      lastShiftRelease = Date.now();
    }
  });
  globalScope.addEventListener?.("blur", () => {
    resetTaps();
    pressedModifiers.clear();
  });
  globalScope.document?.addEventListener("visibilitychange", () => {
    if (globalScope.document.hidden) {
      resetTaps();
      pressedModifiers.clear();
    }
  });

  globalScope.RemoteLabVoiceShortcut = {
    bindingFromEvent,
    modifierFromEvent,
    modifierChordFromEvent,
    formatBinding,
    getBindingConflict,
    setRecording(value) {
      recording = value === true;
      resetTaps();
      pressedModifiers.clear();
    },
  };
})(window);

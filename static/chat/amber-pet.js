"use strict";

(function initAmberPet() {
  const workspace = document.getElementById("sessionWorkspace");
  const host = workspace?.querySelector(".pet-quota-pilot");
  if (!host) return;
  const personId = typeof bootstrapAuthInfo === "undefined" ? "shared" : bootstrapAuthInfo?.person?.id || "shared";
  const isAmber = () => document.documentElement.getAttribute("data-theme") === "amber";
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const button = (className, text) => {
    const result = node("button", className, text);
    result.type = "button";
    return result;
  };
  const widget = node("div", "amber-pet");
  const pet = button("amber-pet-image");
  const image = node("img", "");
  image.src = "chat/img/sticker-bear.gif";
  image.alt = "";
  image.draggable = false;
  pet.append(image);
  const resize = button("amber-pet-resize", "↘");
  const toggle = button("amber-pet-toggle", "···");
  const menu = node("section", "amber-pet-menu");
  menu.id = "amberPetMenu";
  menu.hidden = true;
  const toolbar = node("div", "amber-pet-toolbar");
  const label = node("span", "amber-pet-label");
  const smaller = button("amber-pet-tool", "−");
  const larger = button("amber-pet-tool", "+");
  const reset = button("amber-pet-tool", "↺");
  toolbar.append(label, smaller, larger, reset);
  const hint = node("p", "amber-pet-hint");
  menu.append(toolbar, host, hint);
  widget.append(pet, resize, toggle, menu);
  workspace.append(widget);
  for (const target of [pet, toggle]) {
    target.setAttribute("aria-controls", menu.id);
    target.setAttribute("aria-expanded", "false");
  }

  let device = "";
  let state;
  let gesture = null;
  let togglePress = null;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const defaults = () => ({ x: 1, y: 0, size: 90 });
  const storageKey = () => `remotelab.amberPet.${personId}.${device}`;
  function load() {
    state = defaults();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey()));
      if (saved && [saved.x, saved.y, saved.size].every(Number.isFinite)) {
        state = { x: clamp(saved.x, 0, 1), y: clamp(saved.y, 0, 1), size: clamp(saved.size, 48, 200) };
      }
    } catch {}
  }
  function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch {}
  }
  function bounds() {
    const rect = workspace.getBoundingClientRect();
    const size = Math.min(state.size, Math.max(32, rect.width - 32), Math.max(32, rect.height - 48));
    return { rect, size, width: Math.max(0, rect.width - size - 32), height: Math.max(0, rect.height - size - 48) };
  }
  function placeMenu() {
    if (menu.hidden || !isAmber()) return;
    const area = workspace.getBoundingClientRect();
    const anchor = widget.getBoundingClientRect();
    const left = Math.max(8, area.left + 8);
    const right = Math.min(window.innerWidth - 8, area.right - 8);
    const top = Math.max(8, area.top + 8);
    const bottom = Math.min(window.innerHeight - 8, area.bottom - 8);
    menu.style.width = `${Math.max(0, Math.min(300, right - left))}px`;
    menu.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const below = anchor.bottom + 8;
    const y = below + height <= bottom ? below : anchor.top - height - 8;
    menu.style.left = `${clamp(anchor.right - width, left, Math.max(left, right - width))}px`;
    menu.style.top = `${clamp(y, top, Math.max(top, bottom - height))}px`;
  }
  function render() {
    if (!isAmber()) return;
    const currentDevice = window.matchMedia("(max-width: 768px)").matches ? "mobile" : "desktop";
    if (currentDevice !== device) { device = currentDevice; load(); }
    const { rect, size, width, height } = bounds();
    if (!rect.width || !rect.height) return;
    widget.style.setProperty("--pet-size", `${size}px`);
    widget.style.left = `${16 + state.x * width}px`;
    widget.style.top = `${12 + state.y * height}px`;
    smaller.disabled = state.size <= 48;
    larger.disabled = state.size >= 200;
    placeMenu();
  }
  function setOpen(open, returnFocus = false) {
    menu.hidden = !open;
    for (const target of [pet, toggle]) target.setAttribute("aria-expanded", String(open));
    widget.classList.toggle("is-open", open);
    if (!open) {
      for (const target of host.querySelectorAll('button[aria-expanded="true"]')) target.click();
    }
    if (returnFocus) toggle.focus();
    render();
  }
  function changeSize(value) {
    state.size = clamp(Math.round(value), 48, 200);
    render();
    save();
  }
  // Pointer release handles taps even when the browser suppresses a click after dragging.
  // Native keyboard and assistive activation still use the button's click event.
  for (const target of [pet, toggle]) target.addEventListener("click", (event) => {
    if (!event.detail) setOpen(menu.hidden);
  });
  toggle.addEventListener("pointerdown", (event) => {
    if (event.button === 0) togglePress = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  toggle.addEventListener("pointerup", (event) => {
    if (togglePress?.id === event.pointerId && Math.hypot(event.clientX - togglePress.x, event.clientY - togglePress.y) < 5) setOpen(menu.hidden);
    togglePress = null;
  });
  toggle.addEventListener("pointercancel", () => { togglePress = null; });
  smaller.addEventListener("click", () => changeSize(state.size - 12));
  larger.addEventListener("click", () => changeSize(state.size + 12));
  reset.addEventListener("click", () => { state = defaults(); render(); save(); });
  // Match the preview laboratory: pointer capture for dragging and a corner resize handle.
  function start(event) {
    if (!isAmber() || gesture || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.currentTarget;
    const { width, height } = bounds();
    gesture = { id: event.pointerId, target, resizing: target === resize, x: event.clientX, y: event.clientY,
      left: state.x * width, top: state.y * height, size: state.size, moved: false };
    target.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function move(event) {
    if (gesture?.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
    gesture.moved = true;
    widget.classList.add("is-dragging");
    setOpen(false);
    if (gesture.resizing) {
      state.size = clamp(Math.round(gesture.size + (dx + dy) / 2), 48, 200);
    } else {
      const { width, height } = bounds();
      state.x = width ? clamp((gesture.left + dx) / width, 0, 1) : 0;
      state.y = height ? clamp((gesture.top + dy) / height, 0, 1) : 0;
    }
    render();
  }
  function finish(event) {
    if (gesture?.id !== event.pointerId) return;
    const ended = gesture;
    gesture = null;
    widget.classList.remove("is-dragging");
    if (ended.moved) save();
    else if (ended.target === pet && event.type === "pointerup") setOpen(menu.hidden);
    if (ended.target.hasPointerCapture(event.pointerId)) ended.target.releasePointerCapture(event.pointerId);
  }
  for (const target of [pet, resize]) {
    target.addEventListener("pointerdown", start);
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
    target.addEventListener("lostpointercapture", finish);
  }
  pet.addEventListener("wheel", (event) => {
    if (!isAmber()) return;
    event.preventDefault();
    if (event.deltaY) changeSize(state.size + (event.deltaY < 0 ? 6 : -6));
  }, { passive: false });
  function keyboard(event) {
    if (["+", "=", "-"].includes(event.key)) {
      event.preventDefault();
      changeSize(state.size + (event.key === "-" ? -12 : 12));
    } else if (event.currentTarget === pet && event.key.startsWith("Arrow")) {
      event.preventDefault();
      const { width, height } = bounds();
      const step = event.shiftKey ? 30 : 10;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") state.x = clamp(state.x + (event.key === "ArrowLeft" ? -step : step) / (width || 1), 0, 1);
      if (event.key === "ArrowUp" || event.key === "ArrowDown") state.y = clamp(state.y + (event.key === "ArrowUp" ? -step : step) / (height || 1), 0, 1);
      render(); save();
    }
  }
  pet.addEventListener("keydown", keyboard);
  resize.addEventListener("keydown", keyboard);
  host.addEventListener("click", (event) => {
    const target = event.target.closest(".pet-quota-pilot-button");
    if (target?.getAttribute("aria-expanded") === "true") {
      for (const other of host.querySelectorAll('.pet-quota-pilot-button[aria-expanded="true"]')) {
        if (other !== target) other.click();
      }
    }
    placeMenu();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !widget.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) { setOpen(false, true); event.preventDefault(); }
  });
  function localize() {
    const zh = (document.documentElement.lang || "").startsWith("zh");
    label.textContent = zh ? "小熊工具箱" : "Bear tools";
    hint.textContent = zh ? "拖动小熊移动 · 滚轮或右下角调整大小" : "Drag to move · Scroll or drag the corner to resize";
    for (const [target, text] of [[pet, zh ? "拖动小熊移动，点击展开工具" : "Drag bear to move; click for tools"],
      [toggle, zh ? "展开或收起小熊工具箱" : "Toggle bear tools"], [resize, zh ? "拖动调整大小，或按加减键" : "Drag to resize, or press + or −"],
      [smaller, zh ? "缩小小熊" : "Smaller bear"], [larger, zh ? "放大小熊" : "Larger bear"], [reset, zh ? "恢复默认大小和位置" : "Reset size and position"]]) {
      target.title = text;
      target.setAttribute("aria-label", text);
    }
    menu.setAttribute("aria-label", label.textContent);
  }
  window.addEventListener("remotelab:themechange", () => { setOpen(false); render(); });
  window.addEventListener("remotelab:localechange", localize);
  window.addEventListener("storage", (event) => {
    if (!event.key || event.key === storageKey()) { load(); render(); }
    if (!event.key || event.key === "remotelab.theme") { setOpen(false); render(); }
  });
  window.addEventListener("resize", render);
  new ResizeObserver(render).observe(workspace);
  new ResizeObserver(placeMenu).observe(menu);
  localize();
  render();
})();

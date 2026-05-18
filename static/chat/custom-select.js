/* custom-select.js — wraps native <select> into a styled dropdown */
/* @version 2026-05-18b */

(function () {
  "use strict";

  const INSTANCES = new WeakMap();

  class CustomSelect {
    constructor(selectEl, options = {}) {
      if (INSTANCES.has(selectEl)) return INSTANCES.get(selectEl);
      this.native = selectEl;
      this.opts = options;
      this._open = false;
      this._selectedIdx = -1;
      this._hoverIdx = -1;

      this._build();
      this._syncFromNative();
      this._bindEvents();

      INSTANCES.set(selectEl, this);

      // Force-sync with increasing delays to catch async option loading
      [50, 150, 400, 1000, 2500].forEach((ms) => {
        setTimeout(() => this._syncFromNative(), ms);
      });
    }

    _build() {
      const wrap = document.createElement("div");
      wrap.className = "custom-select-wrap";
      if (this.opts.className) {
        String(this.opts.className)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .forEach((className) => wrap.classList.add(className));
      }

      // Trigger button
      this.trigger = document.createElement("button");
      this.trigger.type = "button";
      this.trigger.className = "cs-trigger";
      this.trigger.setAttribute("aria-haspopup", "listbox");
      this.trigger.setAttribute("aria-expanded", "false");

      this.triggerText = document.createElement("span");
      this.triggerText.className = "cs-trigger-text";
      this.trigger.appendChild(this.triggerText);

      // Dropdown panel
      this.panel = document.createElement("div");
      this.panel.className = "cs-panel";
      this.panel.setAttribute("role", "listbox");

      // Insert before native select, hide native
      this.native.classList.add("cs-native");
      this.native.parentNode.insertBefore(wrap, this.native);
      wrap.appendChild(this.native);
      wrap.appendChild(this.trigger);
      wrap.appendChild(this.panel);
      this.wrap = wrap;

      // Link trigger aria to native id
      const nativeId = this.native.id;
      if (nativeId) {
        this.trigger.id = nativeId + "-cs-trigger";
        this.panel.setAttribute("aria-labelledby", this.trigger.id);
      }
    }

    _syncFromNative() {
      this._rebuildOptions();
      this._updateSelected();
      this._updateDisabled();
      this._updateVisibility();
    }

    _rebuildOptions() {
      this.panel.innerHTML = "";
      this._options = [];
      this._selectedIdx = -1;
      const nativeOpts = this.native.querySelectorAll("option");
      nativeOpts.forEach((opt, i) => {
        const item = document.createElement("div");
        item.className = "cs-option";
        item.setAttribute("role", "option");
        item.dataset.index = i;
        item.textContent = opt.textContent;
        if (opt.disabled) item.classList.add("disabled");
        if (i === this.native.selectedIndex) {
          item.classList.add("selected");
          item.setAttribute("aria-selected", "true");
        }
        this._options.push(item);
        this.panel.appendChild(item);
      });
    }

    _updateSelected() {
      let idx = this.native.selectedIndex;
      // If native select has options but no selection (selectedIndex === -1),
      // attempt to set it to the first option so trigger text is populated on mobile browsers
      if (idx < 0 && this.native.options && this.native.options.length > 0) {
        try {
          this.native.selectedIndex = 0;
        } catch (e) {
          // ignore if browser disallows setting selectedIndex
        }
        idx = this.native.selectedIndex;
      }
      this._selectedIdx = idx;
      this._options.forEach((el, i) => {
        const isSel = i === idx;
        el.classList.toggle("selected", isSel);
        el.setAttribute("aria-selected", String(isSel));
      });
      const text =
        idx >= 0 && this.native.options[idx]
          ? this.native.options[idx].textContent
          : "";
      this.triggerText.textContent = text;
      this.trigger.removeAttribute("title");
    }

    _updateDisabled() {
      this.wrap.classList.toggle("disabled", this.native.disabled);
    }

    _updateVisibility() {
      const nativeDisplay = this.native.style.display;
      if (nativeDisplay === "none") {
        this.wrap.style.display = "none";
      } else {
        this.wrap.style.display = "";
      }
    }

    _bindEvents() {
      // Trigger click → toggle open
      this.trigger.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.native.disabled) return;
        this._open ? this.close() : this.open();
      });

      // Option click
      this.panel.addEventListener("click", (e) => {
        const item = e.target.closest(".cs-option");
        if (!item || item.classList.contains("disabled")) return;
        const idx = parseInt(item.dataset.index, 10);
        this._selectIndex(idx);
        this.close();
      });

      // Hover highlight
      this.panel.addEventListener("pointerenter", (e) => {
        const item = e.target.closest(".cs-option");
        if (item) this._hoverIdx = parseInt(item.dataset.index, 10);
      }, true);

      // Native change (programmatic or user)
      this.native.addEventListener("change", () => {
        this._updateSelected();
      });

      // MutationObserver to sync when native options change
      this._observer = new MutationObserver(() => {
        this._syncFromNative();
      });
      this._observer.observe(this.native, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "selected", "style"],
      });

      // Global close — panel is fixed, check both wrap and panel
      this._outsideHandler = (e) => {
        if (!this.wrap.contains(e.target) && !this.panel.contains(e.target)) this.close();
      };
      this._keydownHandler = (e) => {
        if (!this._open) return;
        if (e.key === "Escape") { this.close(); this.trigger.focus(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); this._moveHover(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); this._moveHover(-1); }
        else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (this._hoverIdx >= 0) this._selectIndex(this._hoverIdx);
          this.close();
        }
      };
    }

    _selectIndex(idx) {
      if (idx === this.native.selectedIndex) return;
      this.native.selectedIndex = idx;
      this._updateSelected();
      this.native.dispatchEvent(new Event("change", { bubbles: true }));
    }

    _moveHover(dir) {
      const len = this._options.length;
      if (!len) return;
      let next = this._hoverIdx + dir;
      if (next < 0) next = len - 1;
      if (next >= len) next = 0;
      // Skip disabled
      let attempts = len;
      while (this._options[next]?.classList.contains("disabled") && attempts-- > 0) {
        next += dir;
        if (next < 0) next = len - 1;
        if (next >= len) next = 0;
      }
      this._hoverIdx = next;
      this._options.forEach((el, i) => {
        el.classList.toggle("hover", i === next);
      });
      this._options[next]?.scrollIntoView({ block: "nearest" });
    }

    open() {
      if (this._open) return;
      this._syncFromNative(); // Always sync before opening
      this._open = true;
      this._hoverIdx = this._selectedIdx;
      this.wrap.classList.add("open");
      this.trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", this._outsideHandler, true);
      document.addEventListener("keydown", this._keydownHandler, true);

      // Position panel as fixed to escape overflow clipping
      requestAnimationFrame(() => {
        const triggerRect = this.trigger.getBoundingClientRect();
        const panelEl = this.panel;
        const spaceBelow = window.innerHeight - triggerRect.bottom;
        const composerMobileUpward =
          window.matchMedia?.("(max-width: 767px)")?.matches
          && !!this.wrap.closest("#inputConfigRow");
        const gap = 4;

        // Estimate panel height
        panelEl.style.left = triggerRect.left + "px";
        panelEl.style.minWidth = triggerRect.width + "px";

        if ((composerMobileUpward && triggerRect.top > 80) || (spaceBelow < 200 && triggerRect.top > spaceBelow)) {
          // Open above
          this.wrap.classList.add("above");
          panelEl.style.top = "auto";
          panelEl.style.bottom = (window.innerHeight - triggerRect.top + gap) + "px";
        } else {
          // Open below
          this.wrap.classList.remove("above");
          panelEl.style.top = (triggerRect.bottom + gap) + "px";
          panelEl.style.bottom = "auto";
        }

        // Clamp to viewport
        requestAnimationFrame(() => {
          const panelRect = panelEl.getBoundingClientRect();
          if (panelRect.right > window.innerWidth - 8) {
            panelEl.style.left = Math.max(8, window.innerWidth - panelRect.width - 8) + "px";
          }
          if (panelRect.left < 8) {
            panelEl.style.left = "8px";
          }
        });
      });

      // Close on scroll or resize (but not when scrolling inside the panel)
      this._scrollHandler = (e) => {
        if (this.panel.contains(e.target)) return;
        this.close();
      };
      this._resizeHandler = () => this.close();
      window.addEventListener("scroll", this._scrollHandler, true);
      window.addEventListener("resize", this._resizeHandler);
    }

    close() {
      if (!this._open) return;
      this._open = false;
      this.wrap.classList.remove("open", "above");
      this.trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", this._outsideHandler, true);
      document.removeEventListener("keydown", this._keydownHandler, true);
      window.removeEventListener("scroll", this._scrollHandler, true);
      window.removeEventListener("resize", this._resizeHandler);
      // Clear inline positioning
      this.panel.style.left = "";
      this.panel.style.top = "";
      this.panel.style.bottom = "";
      this.panel.style.minWidth = "";
    }

    destroy() {
      this.close();
      this._observer.disconnect();
      if (this._scrollHandler) window.removeEventListener("scroll", this._scrollHandler, true);
      if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
      // Restore native select
      this.wrap.parentNode.insertBefore(this.native, this.wrap);
      this.native.classList.remove("cs-native");
      this.wrap.remove();
      INSTANCES.delete(this.native);
    }
  }

  // Public API
  window.CustomSelect = CustomSelect;

  // Convenience: upgrade all selects matching a selector
  window.upgradeSelects = function (selector, options = {}) {
    const instances = [];
    document.querySelectorAll(selector).forEach((el) => {
      if (!INSTANCES.has(el)) {
        instances.push(new CustomSelect(el, options));
      }
    });
    return instances;
  };

  // Get existing instance
  window.getCustomSelect = function (selectEl) {
    return INSTANCES.get(selectEl) || null;
  };
})();

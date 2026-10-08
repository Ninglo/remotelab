"use strict";

(function attachInlineFlow(root) {
  const MAX_SOURCE = 30000;
  const MAX_NODES = 64;
  const MAX_EDGES = 128;

  function parse(source) {
    if (typeof source !== "string" || source.length > MAX_SOURCE) return null;
    const text = source.trim();
    const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*(?:;|\r?\n|$)/.exec(text);
    if (!header) return null;
    const statements = [];
    let current = "", quote = "", stack = [], pipe = false;
    for (const char of text.slice(header[0].length)) {
      if (quote) {
        current += char;
        if (char === quote) quote = "";
      } else if (char === '"') {
        quote = char; current += char;
      } else if (char === "|" && stack.length === 0) {
        pipe = !pipe; current += char;
      } else if ("[({".includes(char) && !pipe) {
        stack.push(char); current += char;
      } else if ("])}".includes(char) && !pipe) {
        if (stack.pop() !== ({ "]": "[", ")": "(", "}": "{" })[char]) return null;
        current += char;
      } else if ((char === "\n" || char === ";") && !stack.length && !pipe) {
        if (current.trim()) statements.push(current.trim());
        current = "";
      } else current += char;
    }
    if (quote || stack.length || pipe) return null;
    if (current.trim()) statements.push(current.trim());
    const nodes = new Map(), edges = [];

    function label(value) {
      let result = value.trim();
      if (/^(["'])[\s\S]*\1$/.test(result)) result = result.slice(1, -1);
      return result.replace(/<br\s*\/?\s*>/gi, "\n");
    }

    function node(statement, offset) {
      const match = /^\s*([A-Za-z_]\w*(?:-\w+)*)/.exec(statement.slice(offset));
      if (!match) return null;
      const id = match[1];
      let end = offset + match[0].length, nodeLabel = null, kind = "step";
      const opening = statement[end];
      if (opening && "[({".includes(opening)) {
        const closing = ({ "[": "]", "(": ")", "{": "}" })[opening];
        let depth = 0, quoted = "", cursor = end;
        for (; cursor < statement.length; cursor += 1) {
          const char = statement[cursor];
          if (quoted) { if (char === quoted) quoted = ""; }
          else if (char === '"') quoted = char;
          else if (char === opening) depth += 1;
          else if (char === closing && --depth === 0) break;
        }
        if (cursor >= statement.length) return null;
        nodeLabel = label(statement.slice(end + 1, cursor));
        if (opening === "(" && nodeLabel.startsWith("(") && nodeLabel.endsWith(")")) nodeLabel = nodeLabel.slice(1, -1);
        if (opening === "{" && nodeLabel.startsWith("{") && nodeLabel.endsWith("}")) nodeLabel = nodeLabel.slice(1, -1);
        if (!nodeLabel || nodeLabel.length > 1500) return null;
        kind = opening === "{" ? "decision" : "step";
        end = cursor + 1;
      }
      const prior = nodes.get(id);
      if (!prior) nodes.set(id, { id, label: nodeLabel || id, kind });
      else if (nodeLabel !== null) {
        if (prior.explicit && prior.label !== nodeLabel) return null;
        Object.assign(prior, { label: nodeLabel, kind });
      }
      if (nodeLabel !== null) nodes.get(id).explicit = true;
      return { id, end };
    }

    for (const statement of statements) {
      if (statement.startsWith("%%")) continue;
      let from = node(statement, 0);
      if (!from) return null;
      let offset = from.end;
      while (statement.slice(offset).trim()) {
        const arrow = /^\s*(-->|==>|-\.->)\s*/.exec(statement.slice(offset));
        if (!arrow) return null;
        offset += arrow[0].length;
        let condition = "";
        if (statement[offset] === "|") {
          const end = statement.indexOf("|", offset + 1);
          if (end < 0) return null;
          condition = label(statement.slice(offset + 1, end));
          if (!condition || condition.length > 1500) return null;
          offset = end + 1;
        }
        const to = node(statement, offset);
        if (!to) return null;
        edges.push({ source: from.id, target: to.id, label: condition });
        from = to; offset = to.end;
        if (edges.length > MAX_EDGES) return null;
      }
      if (nodes.size > MAX_NODES) return null;
    }
    if (!nodes.size) return null;
    return { nodes: Array.from(nodes.values(), ({ explicit, ...value }) => value), edges };
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function translate(key, vars) {
    return root.remotelabT(key, vars);
  }

  // Break only DFS return edges for ranking; every connection is still drawn.
  function layout(graph) {
    const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
    graph.edges.forEach((edge, index) => outgoing.get(edge.source).push({ ...edge, index }));
    const active = new Set(), seen = new Set(), returns = new Set(), order = [];
    function visit(id) {
      if (seen.has(id)) return;
      seen.add(id); active.add(id);
      for (const edge of outgoing.get(id)) {
        if (active.has(edge.target)) returns.add(edge.index);
        else visit(edge.target);
      }
      active.delete(id); order.unshift(id);
    }
    graph.nodes.forEach(node => visit(node.id));
    const ranks = new Map(graph.nodes.map(node => [node.id, 0]));
    for (const id of order) for (const edge of outgoing.get(id)) {
      if (!returns.has(edge.index)) ranks.set(edge.target, Math.max(ranks.get(edge.target), ranks.get(id) + 1));
    }
    const rows = new Map();
    let row = 0;
    function place(id) {
      if (rows.has(id)) return rows.get(id);
      const children = outgoing.get(id).filter(edge => !returns.has(edge.index));
      const values = children.map(edge => place(edge.target));
      const value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : row++ * 170;
      rows.set(id, value); return value;
    }
    order.forEach(place);
    const columns = [];
    graph.nodes.forEach(node => (columns[ranks.get(node.id)] ||= []).push(node.id));
    for (const column of columns) {
      column.sort((a, b) => rows.get(a) - rows.get(b));
      let bottom = -170;
      for (const id of column) { rows.set(id, Math.max(rows.get(id), bottom + 170)); bottom = rows.get(id); }
    }
    const routes = graph.edges.filter((edge, index) => returns.has(index) || ranks.get(edge.target) > ranks.get(edge.source) + 1);
    const top = 32 + routes.length * 54;
    const xs = [24];
    for (let rank = 1; rank < columns.length; rank += 1) {
      const labeled = graph.edges.some(edge => ranks.get(edge.source) === rank - 1 && ranks.get(edge.target) === rank && edge.label);
      xs.push(xs[rank - 1] + 180 + (labeled ? 172 : 76));
    }
    const nodes = graph.nodes.map(node => ({ ...node, x: xs[ranks.get(node.id)], y: top + rows.get(node.id), width: 180, height: 110 }));
    const byId = new Map(nodes.map(node => [node.id, node]));
    let route = 0;
    const edges = graph.edges.map((edge, index) => {
      const from = byId.get(edge.source), to = byId.get(edge.target);
      const peers = outgoing.get(edge.source), port = peers.findIndex(value => value.index === index);
      const spacing = Math.min(18, (from.height - 32) / Math.max(1, peers.length - 1));
      const sx = from.x + from.width, sy = from.y + from.height / 2 + (port - (peers.length - 1) / 2) * spacing;
      const tx = to.x, ty = to.y + to.height / 2;
      const returning = returns.has(index), long = returning || ranks.get(edge.target) > ranks.get(edge.source) + 1;
      const mid = (sx + tx) / 2;
      let path, labelX = mid, labelY = (sy + ty) / 2 - 12, labelWidth = Math.max(60, tx - sx - 12);
      if (long) {
        const lane = 24 + route++ * 54;
        const exit = sx + 24, entry = tx - 24;
        path = `M ${sx} ${sy} H ${exit} V ${lane} H ${entry} V ${ty} H ${tx - 4}`;
        labelY = lane; labelWidth = Math.max(100, Math.min(164, Math.abs(exit - entry) - 16));
      } else path = `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx - 4} ${ty}`;
      return { ...edge, path, labelX, labelY, labelWidth, returning };
    });
    return { nodes, edges, width: xs.at(-1) + 204, height: Math.max(...nodes.map(node => node.y + node.height)) + 32 };
  }

  const svgNS = "http://www.w3.org/2000/svg";
  function svgElement(tag, attributes = {}) {
    const element = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function arrowMarker(id) {
    const defs = svgElement("defs"), marker = svgElement("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto" });
    marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "currentColor" }));
    defs.append(marker); return defs;
  }

  function previewText(parent, value, x, y, width) {
    const lines = [""];
    let units = 0;
    for (const char of value) {
      const size = /[\x00-\x7f]/.test(char) ? 0.55 : 1;
      if (char === "\n" || units + size > width / 16) {
        if (lines.length === 3) { lines[2] += "…"; break; }
        lines.push(""); units = 0;
      }
      if (char !== "\n") { lines[lines.length - 1] += char; units += size; }
    }
    const text = svgElement("text", { x, y, "text-anchor": "middle", class: "inline-flow-preview-text" });
    lines.forEach((line, index) => {
      const span = svgElement("tspan", { x, y: y + (index - (lines.length - 1) / 2) * 22 });
      span.textContent = line; text.append(span);
    });
    parent.append(text);
  }

  function createPreview(diagram, id) {
    const svg = svgElement("svg", { viewBox: `0 0 ${diagram.width} ${diagram.height}`, "aria-hidden": "true", class: "inline-flow-preview-svg" });
    svg.append(arrowMarker(`${id}-preview-arrow`));
    for (const edge of diagram.edges) {
      svg.append(svgElement("path", { d: edge.path, class: `inline-flow-edge${edge.returning ? " inline-flow-edge-return" : ""}`, "marker-end": `url(#${id}-preview-arrow)` }));
      if (edge.label) previewText(svg, edge.label, edge.labelX, edge.labelY, edge.labelWidth);
    }
    for (const node of diagram.nodes) {
      const group = svgElement("g", { "data-flow-preview-node": node.id });
      const title = svgElement("title"); title.textContent = node.label; group.append(title);
      group.append(svgElement("rect", { x: node.x, y: node.y, width: node.width, height: node.height, rx: 9, class: `inline-flow-preview-node${node.kind === "decision" ? " inline-flow-preview-decision" : ""}` }));
      previewText(group, node.label, node.x + node.width / 2, node.y + node.height / 2, node.width - 24);
      svg.append(group);
    }
    return svg;
  }

  function createViewer(graph, diagram, id, saved = {}) {
    const nodes = new Map(diagram.nodes.map(node => [node.id, node]));
    const widget = createElement("section", "inline-flow-viewer");
    widget.setAttribute("aria-label", translate("flow.title"));
    const header = createElement("div", "inline-flow-header");
    header.append(createElement("strong", "inline-flow-title", translate("flow.title")));
    header.append(createElement("span", "inline-flow-count", translate("flow.count", { nodes: graph.nodes.length, branches: graph.edges.filter(edge => edge.label).length })));
    const controls = createElement("div", "inline-flow-controls");
    function control(key, action, text) {
      const button = createElement("button", "inline-flow-view", text || translate(key));
      button.type = "button"; button.setAttribute("aria-label", translate(key));
      button.addEventListener("click", action); controls.append(button); return button;
    }
    header.append(controls); widget.append(header);
    const hint = createElement("p", "inline-flow-hint", translate("flow.hint"));
    widget.append(hint);
    const viewport = createElement("div", "inline-flow-viewport");
    viewport.tabIndex = 0; viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", translate("flow.canvas"));
    const space = createElement("div", "inline-flow-space"), board = createElement("div", "inline-flow-board");
    board.style.width = `${diagram.width}px`; board.style.height = `${diagram.height}px`;
    space.append(board); viewport.append(space); widget.append(viewport);
    const svg = svgElement("svg", { width: diagram.width, height: diagram.height, "aria-hidden": "true", class: "inline-flow-connections" });
    svg.append(arrowMarker(`${id}-arrow`)); board.append(svg);
    const connections = [];
    for (const edge of diagram.edges) {
      const path = svgElement("path", { d: edge.path, class: `inline-flow-edge${edge.returning ? " inline-flow-edge-return" : ""}`, "marker-end": `url(#${id}-arrow)` });
      path.dataset.flowSource = edge.source; path.dataset.flowTarget = edge.target;
      svg.append(path);
      let label;
      if (edge.label) {
        label = createElement("span", "inline-flow-edge-label", edge.label);
        label.title = edge.label; label.style.left = `${edge.labelX}px`; label.style.top = `${edge.labelY}px`; label.style.width = `${edge.labelWidth}px`;
        board.append(label);
      }
      connections.push({ edge, path, label });
    }
    const cards = new Map();
    for (const node of diagram.nodes) {
      const card = createElement("button", `inline-flow-node${node.kind === "decision" ? " inline-flow-decision" : ""}`);
      card.type = "button"; card.dataset.flowNode = node.id; card.setAttribute("aria-controls", `${id}-detail`);
      card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
      card.style.width = `${node.width}px`; card.style.height = `${node.height}px`;
      const label = createElement("span", "inline-flow-label", node.label); card.append(label);
      card.title = node.label; card.setAttribute("aria-label", node.label);
      card.addEventListener("click", () => select(selected === node.id ? "" : node.id));
      board.append(card); cards.set(node.id, card);
    }
    const detail = createElement("div", "inline-flow-detail"); detail.id = `${id}-detail`; detail.hidden = true; widget.append(detail);
    let selected = "", zoom = 1, fit = saved.fit !== false, initialized = false;
    function centerNode(nodeId) {
      const node = nodes.get(nodeId);
      if (!node) return;
      viewport.scrollLeft = (node.x + node.width / 2) * zoom + (parseFloat(board.style.left) || 0) - viewport.clientWidth / 2;
      viewport.scrollTop = (node.y + node.height / 2) * zoom + (parseFloat(board.style.top) || 0) - viewport.clientHeight / 2;
    }
    function select(nodeId) {
      selected = nodes.has(nodeId) ? nodeId : "";
      for (const [key, card] of cards) card.setAttribute("aria-pressed", String(key === selected));
      for (const { edge, path, label } of connections) {
        const highlighted = selected && (edge.source === selected || edge.target === selected);
        path.classList.toggle("inline-flow-edge-selected", !!highlighted);
        if (label) label.classList.toggle("inline-flow-edge-label-selected", !!highlighted);
      }
      detail.replaceChildren(); detail.hidden = !selected;
      if (!selected) return;
      detail.append(createElement("strong", "inline-flow-detail-title", nodes.get(selected).label));
      for (const edge of graph.edges) {
        if (edge.source !== selected && edge.target !== selected) continue;
        const previous = edge.target === selected, target = previous ? edge.source : edge.target;
        const row = createElement("p", "inline-flow-relation");
        const link = createElement("button", "inline-flow-relation-link", translate(previous ? "flow.from" : "flow.to", { step: nodes.get(target).label }));
        link.type = "button"; link.addEventListener("click", () => { select(target); centerNode(target); });
        row.append(link);
        if (edge.label) row.append(createElement("span", "inline-flow-relation-condition", translate("flow.when", { condition: edge.label })));
        detail.append(row);
      }
    }
    function setZoom(value, reset = false) {
      const cx = (viewport.scrollLeft + viewport.clientWidth / 2 - (parseFloat(board.style.left) || 0)) / zoom;
      const cy = (viewport.scrollTop + viewport.clientHeight / 2 - (parseFloat(board.style.top) || 0)) / zoom;
      zoom = Math.max(0.01, Math.min(1.5, value));
      const left = fit ? Math.max(0, (viewport.clientWidth - diagram.width * zoom) / 2) : 0;
      const top = fit ? Math.max(0, (viewport.clientHeight - diagram.height * zoom) / 2) : 0;
      space.style.width = `${diagram.width * zoom + 2 * left}px`; space.style.height = `${diagram.height * zoom + 2 * top}px`;
      board.style.left = `${left}px`; board.style.top = `${top}px`;
      board.style.transform = `scale(${zoom})`;
      scale.textContent = `${Math.round(zoom * 100)}%`;
      viewport.scrollLeft = reset ? 0 : cx * zoom + left - viewport.clientWidth / 2;
      viewport.scrollTop = reset ? 0 : cy * zoom + top - viewport.clientHeight / 2;
    }
    function overview() {
      fit = true; setZoom(Math.min((viewport.clientWidth - 24) / diagram.width, (viewport.clientHeight - 24) / diagram.height, 1), true);
    }
    control("flow.fit", overview);
    control("flow.read", () => { fit = false; setZoom(1); });
    const fork = diagram.nodes.find(node => graph.edges.filter(edge => edge.source === node.id).length > 1);
    if (fork) control("flow.branch", () => {
      fit = false;
      setZoom(Math.min(1, (viewport.clientWidth - 24) / 468));
      viewport.scrollLeft = Math.max(0, (fork.x - 12) * zoom);
      centerVertical(fork);
      select(fork.id);
    });
    function centerVertical(node) { viewport.scrollTop = (node.y + node.height / 2) * zoom - viewport.clientHeight / 2; }
    control("flow.zoomOut", () => { fit = false; setZoom(zoom / 1.25); }, "−");
    const scale = createElement("span", "inline-flow-scale"); controls.append(scale);
    control("flow.zoomIn", () => { fit = false; setZoom(zoom * 1.25); }, "+");
    // Scroll is native on touch/keyboard; mouse dragging pans the same viewport.
    let drag;
    viewport.addEventListener("pointerdown", event => {
      if (event.pointerType !== "mouse" || event.button !== 0 || event.target.closest("button")) return;
      drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add("inline-flow-dragging"); event.preventDefault();
    });
    viewport.addEventListener("pointermove", event => {
      if (!drag) return;
      viewport.scrollLeft = drag.left + drag.x - event.clientX; viewport.scrollTop = drag.top + drag.y - event.clientY;
    });
    function endDrag() { drag = null; viewport.classList.remove("inline-flow-dragging"); }
    viewport.addEventListener("pointerup", endDrag); viewport.addEventListener("pointercancel", endDrag);
    select(saved.selected);
    function resize() {
      if (!widget.isConnected || !viewport.clientWidth || !viewport.clientHeight) return;
      if (!initialized) {
        initialized = true;
        if (fit) overview();
        else {
          setZoom(Number.isFinite(saved.zoom) ? saved.zoom : 1, true);
          viewport.scrollLeft = saved.left || 0; viewport.scrollTop = saved.top || 0;
        }
      } else if (fit) overview();
    }
    root.requestAnimationFrame(resize);
    let observer;
    if (root.ResizeObserver) {
      observer = new root.ResizeObserver(() => {
        if (!widget.isConnected) { observer.disconnect(); return; }
        resize();
      });
      observer.observe(viewport);
    }
    widget.inlineFlowState = () => ({ zoom, fit, selected, left: viewport.scrollLeft, top: viewport.scrollTop });
    widget.disposeInlineFlow = () => observer?.disconnect();
    return widget;
  }

  let widgetId = 0, activeViewer = null;
  function createWidget(graph, pre, source, saved = {}) {
    const diagram = layout(graph), id = `inline-flow-${++widgetId}`;
    const widget = createElement("section", "inline-flow");
    widget.setAttribute("aria-label", translate("flow.title"));
    widget.inlineFlowViewState = saved;
    const header = createElement("div", "inline-flow-header");
    header.append(createElement("strong", "inline-flow-title", translate("flow.title")));
    header.append(createElement("span", "inline-flow-count", translate("flow.count", { nodes: graph.nodes.length, branches: graph.edges.filter(edge => edge.label).length })));
    const open = createElement("button", "inline-flow-view inline-flow-open", translate("flow.open"));
    open.type = "button"; open.setAttribute("aria-haspopup", "dialog"); header.append(open); widget.append(header);
    const preview = createElement("button", "inline-flow-preview");
    preview.type = "button"; preview.setAttribute("aria-label", translate("flow.open")); preview.setAttribute("aria-haspopup", "dialog");
    preview.append(createPreview(diagram, id));
    preview.append(createElement("span", "inline-flow-preview-hint", translate("flow.previewHint")));
    widget.append(preview);
    widget.inlineFlowOpenButton = open;

    function openViewer() {
      if (activeViewer?.owner === widget) return;
      activeViewer?.dialog.close();
      const dialog = createElement("dialog", "inline-flow-dialog md-content");
      dialog.setAttribute("aria-label", translate("flow.title"));
      const viewer = createViewer(graph, diagram, `${id}-expanded`, widget.inlineFlowViewState);
      const close = createElement("button", "inline-flow-view inline-flow-close", "×");
      close.type = "button"; close.setAttribute("aria-label", translate("action.close")); close.autofocus = true;
      close.addEventListener("click", () => dialog.close());
      viewer.querySelector(".inline-flow-controls").append(close);
      dialog.append(viewer); document.body.append(dialog);
      const state = { owner: widget, source, dialog, viewer };
      activeViewer = state;
      // Ownership transfers to the new message component during a same-source rerender.
      const observer = new root.MutationObserver(() => {
        if (!state.owner.isConnected) dialog.close();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      dialog.addEventListener("close", () => {
        observer.disconnect();
        state.owner.inlineFlowViewState = viewer.inlineFlowState();
        viewer.disposeInlineFlow(); dialog.remove();
        if (activeViewer === state) activeViewer = null;
        if (state.owner.isConnected) state.owner.inlineFlowOpenButton.focus({ preventScroll: true });
      }, { once: true });
      dialog.addEventListener("click", event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      });
      dialog.showModal();
    }
    open.addEventListener("click", openViewer); preview.addEventListener("click", openViewer);
    const original = createElement("details", "inline-flow-source");
    original.append(createElement("summary", "inline-flow-source-title", translate("flow.source")));
    original.append(pre); original.open = saved.sourceOpen === true || (saved.openKeys || []).includes("source"); widget.append(original);
    if (saved.expanded && activeViewer?.source === source) activeViewer.owner = widget;
    widget.inlineFlowState = () => ({ source, ...((activeViewer?.owner === widget ? activeViewer.viewer.inlineFlowState() : widget.inlineFlowViewState) || {}), expanded: activeViewer?.owner === widget, sourceOpen: original.open });
    return widget;
  }

  function captureState(container) {
    return Array.from(container.querySelectorAll(".inline-flow"), widget => widget.inlineFlowState?.()).filter(Boolean);
  }

  function enhance(container, prior = []) {
    const remaining = prior.slice();
    for (const code of container.querySelectorAll("pre > code")) {
      const pre = code.parentElement;
      if (pre.closest(".inline-flow")) continue;
      const language = /(?:^|\s)language-([^\s]+)/.exec(code.className || "")?.[1];
      if (language && language !== "mermaid") continue;
      const source = code.textContent.trim();
      const graph = parse(source);
      if (!graph) continue;
      const index = remaining.findIndex(value => value.source === source);
      const saved = index >= 0 ? remaining.splice(index, 1)[0] : {};
      const placeholder = document.createComment("inline flow");
      pre.replaceWith(placeholder);
      placeholder.replaceWith(createWidget(graph, pre, source, saved));
    }
  }

  root.RemoteLabInlineFlow = { parse, layout, enhance, captureState };
})(typeof window === "undefined" ? globalThis : window);

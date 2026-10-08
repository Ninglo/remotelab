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

  function createWidget(graph, pre, source, saved = {}) {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const outgoing = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.source === node.id)]));
    const incoming = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.target === node.id)]));
    const widget = createElement("section", "inline-flow");
    widget.setAttribute("aria-label", translate("flow.title"));
    const openKeys = new Set(saved.openKeys || []);
    const header = createElement("div", "inline-flow-header");
    header.append(createElement("strong", "inline-flow-title", translate("flow.title")));
    header.append(createElement("span", "inline-flow-count", translate("flow.count", { nodes: graph.nodes.length, branches: graph.edges.filter(edge => edge.label).length })));
    const viewButton = createElement("button", "inline-flow-view");
    viewButton.type = "button";
    header.append(viewButton); widget.append(header);
    const content = createElement("div", "inline-flow-content");
    widget.append(content);
    let all = saved.all === true;

    function track(details, key) {
      details.dataset.flowKey = key;
      details.open = openKeys.has(key);
      details.addEventListener("toggle", () => {
        if (details.open) openKeys.add(key); else openKeys.delete(key);
      });
    }

    function stepCard(id) {
      const node = nodes.get(id);
      const details = createElement("details", `inline-flow-step${node.kind === "decision" ? " inline-flow-decision" : ""}`);
      details.dataset.flowNode = id;
      const summary = createElement("summary", "inline-flow-step-title");
      summary.append(createElement("span", "inline-flow-dot"));
      summary.append(createElement("span", "inline-flow-label", node.label));
      details.append(summary);
      const body = createElement("div", "inline-flow-step-body");
      const parents = incoming.get(id);
      if (!parents.length) body.append(createElement("p", "inline-flow-relation", translate("flow.start")));
      for (const edge of parents) {
        const row = createElement("p", "inline-flow-relation", translate("flow.from", { step: nodes.get(edge.source).label }));
        if (edge.label) row.append(createElement("span", "inline-flow-relation-condition", translate("flow.when", { condition: edge.label })));
        body.append(row);
      }
      if (all) {
        for (const edge of outgoing.get(id)) {
          const row = createElement("p", "inline-flow-relation", translate("flow.to", { step: nodes.get(edge.target).label }));
          if (edge.label) row.append(createElement("span", "inline-flow-relation-condition", translate("flow.when", { condition: edge.label })));
          body.append(row);
        }
      }
      details.append(body); track(details, `node:${id}`);
      return details;
    }

    function branch(edge, index, visited, path) {
      const details = createElement("details", "inline-flow-branch");
      const summary = createElement("summary", "inline-flow-branch-title");
      if (edge.label) summary.append(createElement("span", "inline-flow-condition", edge.label));
      summary.append(createElement("span", "inline-flow-branch-label", nodes.get(edge.target).label));
      details.append(summary);
      const panel = createElement("div", "inline-flow-branch-content");
      details.append(panel);
      const key = `${path}/${index}:${edge.target}`;
      track(details, key);
      let filled = false;
      function fill() {
        if (filled || !details.open) return;
        filled = true;
        panel.append(renderPath(edge.target, new Set(visited), key));
      }
      details.addEventListener("toggle", fill);
      fill();
      return details;
    }

    function renderPath(start, visited, path) {
      const list = createElement("ol", "inline-flow-path");
      let current = start;
      while (current) {
        if (visited.has(current)) {
          list.append(createElement("li", "inline-flow-return", translate("flow.returns", { step: nodes.get(current).label })));
          break;
        }
        visited.add(current);
        const item = createElement("li", "inline-flow-item");
        item.append(stepCard(current)); list.append(item);
        const next = outgoing.get(current);
        if (next.length > 1) {
          const branches = createElement("div", "inline-flow-branches");
          branches.append(createElement("div", "inline-flow-branches-label", translate("flow.directions", { count: next.length })));
          next.forEach((edge, index) => branches.append(branch(edge, index, visited, `${path}/${current}`)));
          item.append(branches); break;
        }
        if (!next.length) {
          item.append(createElement("div", "inline-flow-end", translate("flow.end"))); break;
        }
        if (next[0].label) item.append(createElement("div", "inline-flow-next-condition", next[0].label));
        current = next[0].target;
      }
      return list;
    }

    function render() {
      content.replaceChildren();
      viewButton.textContent = translate(all ? "flow.segmented" : "flow.all");
      viewButton.setAttribute("aria-pressed", String(all));
      if (all) {
        const list = createElement("ol", "inline-flow-path inline-flow-all");
        for (const node of graph.nodes) {
          const item = createElement("li", "inline-flow-item");
          item.append(stepCard(node.id)); list.append(item);
        }
        content.append(list);
      } else {
        const roots = graph.nodes.filter(node => !incoming.get(node.id).length);
        const covered = new Set();
        function cover(id) {
          if (covered.has(id)) return;
          covered.add(id);
          outgoing.get(id).forEach(edge => cover(edge.target));
        }
        roots.forEach(node => cover(node.id));
        for (const node of graph.nodes) {
          if (!covered.has(node.id)) { roots.push(node); cover(node.id); }
        }
        if (roots.length > 1) {
          roots.forEach((node, index) => content.append(branch({ target: node.id }, index, new Set(), "root")));
        } else content.append(renderPath((roots[0] || graph.nodes[0]).id, new Set(), "root"));
      }
    }
    viewButton.addEventListener("click", () => { all = !all; render(); });
    render();

    const original = createElement("details", "inline-flow-source");
    original.append(createElement("summary", "inline-flow-source-title", translate("flow.source")));
    original.append(pre); track(original, "source");
    widget.append(original);
    widget.inlineFlowState = () => {
      // Read the DOM too: a native disclosure can toggle just before its event fires.
      for (const details of widget.querySelectorAll("details[data-flow-key]")) {
        if (details.open) openKeys.add(details.dataset.flowKey); else openKeys.delete(details.dataset.flowKey);
      }
      return { source, all, openKeys: Array.from(openKeys) };
    };
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

  root.RemoteLabInlineFlow = { parse, enhance, captureState };
})(typeof window === "undefined" ? globalThis : window);

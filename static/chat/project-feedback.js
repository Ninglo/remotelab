"use strict";
(function attachFeedback(globalScope) {
  const root = document.getElementById("monitoringFeedback");
  if (!root) return;
  const t = (key, vars) => globalScope.remotelabT?.(`feedback.${key}`, vars) || key;
  const node = (tag, text = "", cls = "") => {
    const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n;
  };
  const time = v => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : t("unknown");
  const button = (label, action) => { const b = node("button", label, "task-center-action"); b.type = "button"; b.addEventListener("click", action); return b; };
  let summary = null, detail = null, selected = new URL(globalScope.location.href).searchParams.get("feedback") || "";
  let serial = 0, detailSerial = 0, key = null, keyContent = "", related = "";
  const toolbar = node("div", "", "monitoring-toolbar");
  const refresh = button(t("refresh"), () => void load()); toolbar.appendChild(refresh);
  const note = node("p", "", "monitoring-note"); note.setAttribute("role", "status");
  const list = node("div"), detailRoot = node("section", "", "feedback-detail"); detailRoot.hidden = true;
  const composer = node("details", "", "feedback-composer");
  composer.appendChild(node("summary", t("give")));
  const form = node("form", "", "feedback-form");
  const field = (label, control) => { const wrap = node("label", "", "task-center-field"); const title = node("span", t(label)); title.dataset.feedbackLabel = label; wrap.append(title, control); form.appendChild(wrap); return control; };
  const project = field("project", node("select")); project.id = "feedbackProject";
  const signal = field("signal", node("select")); signal.id = "feedbackSignal";
  for (const [value, label] of [["", "textOnly"], ["useful", "useful"], ["not_useful", "notUseful"]]) {
    const o = node("option", t(label)); o.value = value; o.dataset.feedbackLabel = label; signal.appendChild(o);
  }
  const target = field("target", node("input")); target.maxLength = 300; target.placeholder = t("targetHint");
  const targetUrl = field("url", node("input")); targetUrl.type = "url"; targetUrl.maxLength = 2048;
  const comment = field("comment", node("textarea")); comment.rows = 3; comment.maxLength = 4000; comment.id = "feedbackComment"; comment.placeholder = t("commentHint");
  const example = field("example", node("textarea")); example.rows = 2; example.maxLength = 2000; example.placeholder = t("exampleHint");
  const relatedNote = node("p", "", "monitoring-note"); relatedNote.hidden = true;
  const clearRelated = button(t("clearRelated"), () => { related = ""; relatedNote.hidden = true; clearRelated.hidden = true; }); clearRelated.hidden = true;
  const submit = node("button", t("submit"), "task-center-primary"); submit.type = "submit"; submit.id = "feedbackSubmit"; submit.dataset.feedbackLabel = "submit";
  const receipt = node("p", "", "monitoring-note"); receipt.id = "feedbackReceipt"; receipt.setAttribute("role", "status");
  const saveNote = node("p", t("saveNote"), "monitoring-note"); saveNote.dataset.feedbackLabel = "saveNote";
  form.append(relatedNote, clearRelated, saveNote, submit, receipt);
  composer.appendChild(form); root.append(toolbar, note, list, detailRoot, composer);
  function give(id, record) {
    project.value = id || ""; related = record?.id || "";
    target.value = record?.target_title || ""; targetUrl.value = record?.target_url || record?.source_url || "";
    relatedNote.textContent = related ? t("related", { text: (record.comment || record.target_title || record.emoji || record.id).slice(0, 100) }) : "";
    relatedNote.hidden = !related; clearRelated.hidden = !related;
    composer.open = true; comment.focus();
  }
  project.addEventListener("change", () => { related = ""; relatedNote.hidden = true; clearRelated.hidden = true; });
  function renderSummary() {
    list.replaceChildren();
    if (!summary) return;
    note.textContent = !summary.configured ? t("notConfigured") : t("scope", { count: summary.counts.raw_records, time: time(summary.review_at) });
    if (summary.gaps.length) list.appendChild(node("p", t("gaps", { count: summary.gaps.length }), "monitoring-note"));
    project.replaceChildren(); const unknown = node("option", t("unassigned")); unknown.value = ""; project.appendChild(unknown);
    const table = node("table", "", "feedback-table"), head = node("thead"), tr = node("tr");
    ["project", "count", "pending", "direction", "details"].forEach(k => { const th = node("th", t(k)); th.scope = "col"; tr.appendChild(th); });
    head.appendChild(tr); table.appendChild(head); const body = node("tbody");
    for (const p of summary.projects) {
      const o = node("option", p.name); o.value = p.id; project.appendChild(o);
      const row = node("tr"); row.dataset.subproject = p.id;
      const name = node("td"); name.appendChild(button(p.name, () => void select(p.id))); row.appendChild(name);
      row.appendChild(node("td", p.coverage === "not_represented" ? t("notCovered") : String(p.feedback_count)));
      row.appendChild(node("td", String(p.pending_analysis_count)));
      row.appendChild(node("td", p.directions[0] || t("noDirection")));
      const actions = node("td"); actions.appendChild(button(t("give"), () => give(p.id))); row.appendChild(actions); body.appendChild(row);
    }
    for (const row of body.children) [...row.children].forEach((td, index) => { td.dataset.label = t(["project", "count", "pending", "direction", "details"][index]); });
    table.appendChild(body); const wrap = node("div", "", "monitoring-table-wrap"); wrap.appendChild(table); list.appendChild(wrap);
    const extras = node("div", "", "feedback-extras");
    for (const [id, label] of [["unassigned_feedback", "unassigned"], ["related_context", "context"], ["paused_history", "paused"]]) {
      extras.appendChild(button(`${t(label)} · ${summary.counts[id]}`, () => void select(id)));
    }
    list.appendChild(extras); submit.disabled = !summary.configured;
    if (summary.projects.some(p => p.id === selected)) project.value = selected;
  }
  function sourceLink(url, label, parent) {
    try { const parsed = new URL(url, globalScope.location.origin); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return; }
    catch { return; }
    if (!url) return;
    const a = node("a", label); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; parent.appendChild(a);
  }
  function renderDetail() {
    detailRoot.replaceChildren(); detailRoot.hidden = !selected; list.hidden = Boolean(selected);
    if (!selected) return;
    detailRoot.appendChild(button(t("back"), () => {
      selected = ""; detail = null; ++detailSerial; renderDetail();
      const url = new URL(globalScope.location.href); url.searchParams.delete("feedback"); globalScope.history.replaceState(null, "", url);
    }));
    if (!detail) { detailRoot.appendChild(node("p", t("loading"), "monitoring-note")); return; }
    const labels = { unassigned_feedback: "unassigned", related_context: "context", paused_history: "paused" };
    detailRoot.appendChild(node("h3", detail.project?.name || t(labels[selected] || "details")));
    if (detail.project) {
      detailRoot.appendChild(button(t("giveProject"), () => give(selected)));
      detailRoot.appendChild(node("p", t("directionNote"), "monitoring-note"));
      const directions = node("ul");
      for (const d of detail.project.directions) directions.appendChild(node("li", d));
      detailRoot.appendChild(directions);
    }
    if (detail.gaps.length) detailRoot.appendChild(node("p", t("gaps", { count: detail.gaps.length }), "monitoring-note"));
    detailRoot.appendChild(node("p", t("records", { count: detail.records.length }), "monitoring-note"));
    for (const r of detail.records) {
      const card = node("details", "", "feedback-record"); card.dataset.feedbackId = r.id;
      const title = node("summary", `${r.author} · ${time(r.created_at)} · ${(r.comment || r.target_title || r.emoji || t(r.usefulness === "useful" ? "useful" : r.usefulness === "not_useful" ? "notUseful" : "noText")).slice(0, 120)}`);
      card.appendChild(title);
      const row = (label, value) => { if (!value) return; const p = node("div", "", "feedback-record-field"); p.append(node("strong", t(label)), node("p", String(value))); card.appendChild(p); };
      row("comment", r.comment); row("signal", r.emoji || (r.usefulness && t(r.usefulness === "useful" ? "useful" : "notUseful")));
      row("target", r.target_title); row("quote", r.target_quote); row("example", r.example);
      row("analysis", r.analysis); row("theme", r.theme); row("reason", r.classification_reason);
      row("direction", r.suggested_direction); row("candidate", r.pending_candidate);
      row("state", t(r.review_state === "collected" ? "collected" : "historicalState", { state: r.review_state || t("unknown") }));
      row("revision", r.target_revision); row("recordId", r.id); row("relatedId", r.related_feedback_id);
      const links = node("div", "", "feedback-extras"); sourceLink(r.source_url, t("source"), links); sourceLink(r.target_url, t("targetLink"), links);
      if (r.source_session_id) sourceLink(`/?tab=sessions&session=${encodeURIComponent(r.source_session_id)}`, t("conversation"), links);
      card.appendChild(links);
      if (r.bucket !== "paused_history") card.appendChild(button(t("supplement"), () => give(r.subproject_id, r)));
      detailRoot.appendChild(card);
    }
  }
  async function select(id, { sync = true } = {}) {
    selected = id; detail = null; const request = ++detailSerial; renderDetail();
    if (sync) { const url = new URL(globalScope.location.href); url.searchParams.set("feedback", id); globalScope.history.replaceState(null, "", url); }
    try {
      const next = await fetchJsonOrRedirect(`/api/project-feedback?subproject=${encodeURIComponent(id)}`, { revalidate: false });
      if (request === detailSerial) { detail = next; renderDetail(); }
    } catch (error) {
      if (request === detailSerial) { detailRoot.appendChild(node("p", error.message || t("failed"), "monitoring-note")); detailRoot.hidden = false; }
    }
  }
  async function load() {
    const request = ++serial; refresh.disabled = true;
    if (!summary) note.textContent = t("loading");
    try {
      const next = await fetchJsonOrRedirect("/api/project-feedback", { revalidate: false });
      if (request === serial) {
        const chosen = project.value; summary = next; renderSummary();
        if ([...project.options].some(o => o.value === chosen)) project.value = chosen;
        if (selected) await select(selected, { sync: false });
      }
      return true;
    } catch (error) { if (request === serial) note.textContent = error.message || t("failed"); return false; }
    finally { if (request === serial) refresh.disabled = false; }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!signal.value && !comment.value.trim()) { receipt.textContent = t("required"); comment.focus(); return; }
    const payload = { subproject_id: project.value, usefulness: signal.value, comment: comment.value.trim(),
      example: example.value.trim(), target_title: target.value.trim(), target_url: targetUrl.value.trim(), related_feedback_id: related };
    const fingerprint = JSON.stringify(payload);
    if (!key || fingerprint !== keyContent) { key = globalScope.crypto.randomUUID(); keyContent = fingerprint; }
    submit.disabled = true; receipt.textContent = t("saving");
    try {
      const saved = await fetchJsonOrRedirect("/api/project-feedback", { method: "POST", revalidate: false,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, client_id: key }) });
      receipt.textContent = t("saved", { time: time(saved.record.created_at) });
      key = null; keyContent = ""; comment.value = ""; example.value = ""; signal.value = ""; related = "";
      relatedNote.hidden = true; clearRelated.hidden = true;
      const refreshed = await load();
      if (!refreshed) receipt.textContent += " " + t("refreshFailed");
    } catch (error) { receipt.textContent = (error.message || t("failed")) + " " + t("retryNote"); }
    finally { submit.disabled = !summary?.configured; }
  });
  globalScope.addEventListener("remotelab:localechange", () => {
    root.querySelectorAll("[data-feedback-label]").forEach(n => { n.textContent = t(n.dataset.feedbackLabel); });
    target.placeholder = t("targetHint"); comment.placeholder = t("commentHint"); example.placeholder = t("exampleHint");
    clearRelated.textContent = t("clearRelated");
    refresh.textContent = t("refresh"); composer.firstChild.textContent = t("give");
    if (summary) { const chosen = project.value; renderSummary(); if ([...project.options].some(o => o.value === chosen)) project.value = chosen; } if (detail) renderDetail();
  });
  globalScope.RemoteLabProjectFeedback = { load };
})(window);

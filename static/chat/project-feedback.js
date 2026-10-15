"use strict";
(function attachFeedback(globalScope) {
  const root = document.getElementById("monitoringFeedback");
  if (!root) return;
  const activityText = {
    projectsHeading: ['项目进展', 'Projects'], projectIntro: ['先选项目，再看子项目的当前判断、待推进事项、案例和反馈。', 'Choose a project to review its subprojects, next steps, cases and feedback.'],
    findProject: ['搜索子项目', 'Find a subproject'], overview: ['进展与下一步', 'Progress and next steps'], enterProject: ['查看进展', 'Open project'], usageOnDemand: ['查看使用统计', 'Load usage statistics'], noMatches: ['没有匹配的子项目', 'No matching subprojects'],
    caseUnknown: ['案例待整理', 'Cases not reviewed'], rawFeedback: ['原始反馈', 'Source feedback'],
    relatedItems: ['关联案例／反馈', 'Related cases / feedback'], actualChanges: ['实际修改与处理结果', 'Changes and outcomes'],
    changeUnknown: ['尚无可核实的修改记录。', 'No verified change recorded.'], nextStep: ['下一步建议', 'Suggested next step'],
    viewStart: ['查看并确认开工', 'Review and start'], confirmStart: ['确认开工', 'Confirm and start'],
    actionTarget: ['接续位置', 'Continue in'], actionSending: ['正在提交…', 'Submitting…'],
    actionSent: ['已提交到原事项；是否开工及结果以原事项为准。', 'Submitted to the original work; follow its execution and results there.'],
    actionRetry: ['提交结果未确认。可重试同一请求，或先查看原事项。', 'Delivery not confirmed. Retry this same request or check the original work.'],
    actionOpen: ['查看原事项进度', 'Open original work'],
    reviewComment: ['补充评审', 'Add a review'],
    reviewTopics: ['已整理反馈主题', 'Reviewed feedback themes'], reviewCases: ['真实案例', 'Work cases'],
    reviewFocus: ['优先关注', 'Review priorities'], reviewHistory: ['其他处理结论', 'Other dispositions'],
    reviewEvidence: ['原文与依据', 'Sources and evidence'], reviewKnowledge: ['项目认知', 'Project understanding'],
    reviewFull: ['完整认知与依据', 'Full understanding and evidence'],
    reviewAsOf: ['本次核对截至', 'Reviewed through'], reviewScope: ['范围与判断边界', 'Scope and limits'],
    reviewInitial: ['以下为 Agent 初评，人的复核仍待补充；无反馈不代表好或坏。', 'Agent assessment awaiting human review; silence indicates neither success nor failure.'],
    started: ['开始日期', 'Start date'], usage: ['功能触发 · 近30天', 'Feature calls · 30 days'],
    attention: ['关注状态', 'Attention'], recent: ['近14天', '14 days'],
    groupNote: ['按大项目暂分组；子项目分别统计。最近反馈优先，30天未触发的成熟项目下沉。没有反馈不代表稳定，采集未覆盖不记作无人使用。此排序不改变巡检日程。',
      'Grouped by parent project for review; counts remain per subproject. Recent feedback comes first; mature projects with no calls for 30 days move down. Silence does not establish quality. Missing sampling is unknown. This order does not change schedules.'],
    groupTrial: ['展示分组', 'Review grouping'], registered: ['登记', 'Registered'], rollout: ['推广', 'Rollout'],
    observation: ['开始观察', 'Observation started'], sampling: ['采集始于', 'Sampling since'],
    noHook: ['使用度待接入', 'Usage not instrumented'], usageUnknown: ['采集不完整', 'Sampling incomplete'],
    sampled: ['窗口内已采集', 'Observed in window'], succeeded: ['完成', 'Completed'],
    human: ['人工直接触发', 'Direct human'], agent: ['Agent调用', 'Agent calls'], automated: ['自动任务', 'Automated'],
    lastUse: ['最近触发', 'Latest call'], pending_analysis: ['有反馈待分析', 'Feedback awaiting analysis'],
    samplingScope: ['采集范围', 'Sampling scope'],
    cumulative: ['已记录累计操作', 'Recorded cumulative actions'], exposures: ['展示', 'Presented'],
    qianyanScope: ['展开／打开原文／筛选／复制／播放／文档打开；累计数不当作近30天用量。', 'Expand / source open / filter / copy / play / document open; cumulative counts are not 30-day usage.'],
    recent_feedback: ['近期有反馈', 'Recent feedback'], new_observation: ['新项目待观察', 'New project to observe'],
    usage_failures: ['触发失败待核查', 'Invocation failures to review'], not_launched: ['尚未启动', 'Not launched'],
    quiet_observation: ['少反馈，低频观察', 'Quiet; review less often'], sampling_new: ['新埋点待观察', 'New sampling to observe'],
    coverage_unknown: ['使用度待核实', 'Usage needs verification'], idle_candidate: ['暂闲置，待确认', 'Possibly idle; verify'],
    attentionPaused: ['暂停', 'Paused'], groupCount: ['子项目', 'Subprojects'], pendingCount: ['待分析', 'Awaiting analysis'],
  };
  const t = (key, vars) => {
    const words = activityText[key];
    if (words) return words[globalScope.remotelabGetActiveUiLanguage?.() === 'en' ? 1 : 0];
    return globalScope.remotelabT?.(`feedback.${key}`, vars) || key;
  };
  const node = (tag, text = "", cls = "") => {
    const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n;
  };
  const time = v => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : t("unknown");
  const button = (label, action) => { const b = node("button", label, "task-center-action"); b.type = "button"; b.addEventListener("click", action); return b; };
  let summary = null, detail = null, selected = new URL(globalScope.location.href).searchParams.get("feedback") || "";
  let serial = 0, detailSerial = 0, key = null, keyContent = "", related = "";
  let selectedSection = new URL(globalScope.location.href).searchParams.get('feedbackView') || 'overview';
  const actionRequests = new Map();
  let chosenGroup = new URL(globalScope.location.href).searchParams.get("projectGroup") || "", searchText = "";
  const countedLink = (label, id, section) => button(label, () => void select(id, { section }));
  const projectName = name => { const n = node('span', name); n.translate = false; return n; };
  root.append(node("h2", t("projectsHeading")), node("p", t("projectIntro"), "monitoring-note"));
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
  function usageContent(p) {
    const box = node('div', '', 'feedback-usage');
    const u = p.usage;
    if (!u || u.status === 'not_instrumented') { box.textContent = t('noHook'); return box; }
    const scope = node('details', '', 'feedback-usage-scope'); scope.appendChild(node('summary', t('samplingScope')));
    if (u.status === 'cumulative') {
      box.append(node('strong', `${t('cumulative')} ${u.calls}`), node('small', `${t('exposures')} ${u.exposures}`));
      if (u.latest_at) box.appendChild(node('small', `${t('lastUse')}：${time(u.latest_at)}`));
      scope.appendChild(node('small', t('qianyanScope'))); box.appendChild(scope);
      return box;
    }
    if (u.status === 'unknown') { box.textContent = t('usageUnknown'); return box; }
    box.append(node('strong', `${u.calls} · ${t('succeeded')} ${u.completed}`));
    box.append(node('small', `${t('human')} ${u.direct_human} · ${t('agent')} ${u.agent} · ${t('automated')} ${u.automated}`));
    if (u.latest_at) box.append(node('small', `${t('lastUse')}：${time(u.latest_at)}`));
    scope.appendChild(node('small', `${t('sampling')}：${time(u.sampling_since)}`));
    if (u.scope) scope.appendChild(node('small', u.scope)); box.appendChild(scope);
    return box;
  }
  function startContent(p) {
    const box = node('div');
    box.appendChild(node('span', p.started_at ? `${p.start_kind === 'project' ? '' : t(p.start_kind) + ' · '}${new Date(p.started_at).toLocaleDateString()}` : t('unknown')));
    if (p.observation_started_at) box.appendChild(node('small', `${t('observation')}：${time(p.observation_started_at)}`));
    sourceLink(p.start_source_url, t('source'), box); return box;
  }
  function renderSummary() {
    list.replaceChildren();
    if (!summary) return;
    note.textContent = !summary.configured ? t("notConfigured") : "";
    if (summary.gaps.length) list.appendChild(node("p", t("gaps", { count: summary.gaps.length }), "monitoring-note"));
    project.replaceChildren(); const unknown = node("option", t("unassigned")); unknown.value = ""; project.appendChild(unknown);
    for (const p of summary.projects) {
      const o = node("option", p.name); o.value = p.id; project.appendChild(o);
    }
    if (!summary.groups.some(g => g.id === chosenGroup)) chosenGroup = summary.groups[0]?.id || '';
    const picker = node('nav', '', 'feedback-project-picker'); picker.setAttribute('aria-label', t('projectsHeading'));
    for (const g of summary.groups) {
      const tab = button(g.name, () => {
        chosenGroup = g.id; searchText = ''; selected = ''; detail = null; ++detailSerial;
        const url = new URL(globalScope.location.href); url.searchParams.set('projectGroup', chosenGroup); url.searchParams.delete('feedback'); url.searchParams.delete('feedbackView'); globalScope.history.replaceState(null, '', url);
        renderSummary(); renderDetail();
      });
      tab.translate = false; tab.setAttribute('aria-pressed', String(g.id === chosenGroup)); picker.appendChild(tab);
    }
    list.appendChild(picker);
    const search = node('input'); search.type = 'search'; search.placeholder = t('findProject'); search.setAttribute('aria-label', t('findProject')); search.value = searchText; search.className = 'feedback-search';
    list.appendChild(search);
    for (const g of summary.groups.filter(g => g.id === chosenGroup)) {
      const group = node('section', '', 'feedback-group'); group.dataset.feedbackGroup = g.id;
      const groupTitle = node('header'); groupTitle.append(node('h3', g.name), node('span', `${g.subproject_count} ${t('groupCount')}`)); groupTitle.firstChild.translate = false;
      groupTitle.appendChild(countedLink(`${t('rawFeedback')} ${g.feedback_count}`, 'group:' + g.id, 'records'));
      group.appendChild(groupTitle);
      const grid = node('div', '', 'feedback-project-grid');
      for (const p of summary.projects.filter(p => p.group_id === g.id)) {
        const card = node('article', '', 'feedback-project-card'); card.dataset.subproject = p.id;
        const name = button(p.name, () => void select(p.id)); name.translate = false; name.classList.add('feedback-project-name'); card.appendChild(name);
        const state = p.phase === 'paused' ? t('attentionPaused') : p.review ? `${t('reviewAsOf')} ${time(p.review.as_of)}` : t(p.attention.state);
        card.append(node('small', state), node('p', p.review?.summary || p.directions[0] || t('noDirection')));
        const links = node('div', '', 'feedback-extras');
        links.appendChild(button(t('enterProject'), () => void select(p.id)));
        links.appendChild(p.review ? countedLink(`${t('reviewCases')} ${p.review.case_count}`, p.id, 'cases') : node('span', t('caseUnknown')));
        links.appendChild(countedLink(`${t('rawFeedback')} ${p.feedback_count}`, p.id, 'records'));
        if (p.review) links.appendChild(countedLink(`${t('reviewTopics')} ${p.review.feedback_count}`, p.id, 'feedback'));
        card.appendChild(links); grid.appendChild(card);
      }
      const empty = node('p', t('noMatches')); empty.hidden = true;
      const filter = () => { searchText = search.value; let count = 0; for (const card of grid.children) { card.hidden = !card.textContent.toLowerCase().includes(searchText.toLowerCase()); if (!card.hidden) count++; } empty.hidden = count > 0; };
      search.addEventListener('input', filter); filter();
      group.append(grid, empty); list.appendChild(group);
    }
    const extras = node("div", "", "feedback-extras");
    for (const [id, label] of [["unassigned_feedback", "unassigned"], ["related_context", "context"], ["paused_history", "paused"]]) {
      extras.appendChild(button(`${t(label)} · ${summary.counts[id]}`, () => void select(id)));
    }
    const coverage = node("details", "", "feedback-observations"); coverage.append(node("summary", t("reviewScope")), node("p", t("scope", { count: summary.counts.raw_records, time: time(summary.review_at) })), node("p", t("groupNote")), extras); list.appendChild(coverage); submit.disabled = !summary.configured;
    if (summary.projects.some(p => p.id === selected)) project.value = selected;
  }
  function sourceLink(url, label, parent) {
    try { const parsed = new URL(url, globalScope.location.origin); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return; }
    catch { return; }
    if (!url) return;
    const a = node("a", label); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; parent.appendChild(a);
  }
  function renderAction(item) {
    const a = item.action, panel = node('details', '', 'feedback-start');
    panel.appendChild(node('summary', t('viewStart')));
    panel.appendChild(node('p', `${t('actionTarget')}：${a.session_name}`));
    const text = node('textarea'); text.value = a.text; text.rows = 6; text.setAttribute('aria-label', t('nextStep')); panel.appendChild(text);
    const receipt = node('p', '', 'monitoring-note'); receipt.setAttribute('role', 'status');
    const cacheKey = `${selected}:${item.id}:${a.session_id}`;
    const confirm = button(t('confirmStart'), async () => {
      const content = text.value.trim(); if (!content) { text.focus(); return; }
      let request = actionRequests.get(cacheKey);
      if (request?.sent && request.text === content) { receipt.textContent = t('actionSent'); return; }
      confirm.disabled = true; text.disabled = true; receipt.textContent = t('actionSending');
      try {
        if (!request || request.text !== content) {
          const identity = await fetchJsonOrRedirect('/api/auth/me', { revalidate: false });
          if (!identity.person?.id) throw new Error(t('failed'));
          const bytes = new TextEncoder().encode(JSON.stringify([identity.person.id, selected, item.id, a.session_id, content]));
          const digest = [...new Uint8Array(await globalScope.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
          request = { requestId: 'feedback-start:' + digest, text: content, sent: false }; actionRequests.set(cacheKey, request);
        }
        await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(a.session_id)}/messages`, {
          method: 'POST', revalidate: false, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: request.requestId, text: request.text }),
        });
        request.sent = true; receipt.textContent = t('actionSent');
      } catch (error) { receipt.textContent = `${error.message || t('failed')} ${t('actionRetry')}`; confirm.disabled = false; text.disabled = false; }
    });
    if (actionRequests.get(cacheKey)?.sent) { confirm.disabled = true; text.disabled = true; receipt.textContent = t('actionSent'); }
    panel.append(confirm, receipt);
    sourceLink(`/?tab=sessions&session=${encodeURIComponent(a.session_id)}`, t('actionOpen'), panel);
    return panel;
  }
  function focusSection(section) {
    if (!['overview', 'cases', 'feedback', 'records', 'history'].includes(section)) return;
    selectedSection = section;
    const url = new URL(globalScope.location.href); url.searchParams.set('feedbackView', section); globalScope.history.replaceState(null, '', url);
    detailRoot.querySelectorAll('[data-review-section]').forEach(n => { n.hidden = n.dataset.reviewSection !== section; });
    detailRoot.querySelectorAll('.feedback-review > nav button').forEach(n => n.setAttribute('aria-pressed', String(n.dataset.section === section)));
    const target = detailRoot.querySelector(`[data-review-section="${section}"]`) || (section === 'records' && detailRoot.querySelector('.feedback-raw-records'));
    if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); }
  }
  function renderReview(review) {
    const box = node('section', '', 'feedback-review');
    const navigation = node('nav', '', 'feedback-extras');
    for (const [section, label] of [['overview', 'overview'], ['cases', 'reviewCases'], ['feedback', 'reviewTopics'], ['records', 'rawFeedback'], ['history', 'reviewHistory']]) {
      const count = section === 'overview' ? '' : ' ' + (section === 'records' ? detail.records.length : review[section].length);
      const tab = button(t(label) + count, () => focusSection(section)); tab.dataset.section = section; navigation.appendChild(tab);
    }
    box.appendChild(navigation);
    const overview = node('section'); overview.dataset.reviewSection = 'overview'; box.appendChild(overview);
    overview.append(node('p', review.summary), node('small', `${t('reviewAsOf')} ${time(review.as_of)}`));
    const renderItem = (item, parent, label = item.title) => {
      const card = node('details', '', 'feedback-record'); card.dataset.reviewItem = item.id;
      card.appendChild(node('summary', `${label}${item.state ? ' · ' + item.state : ''}`));
      const populate = () => { if (!card.open || card.dataset.loaded) return; card.dataset.loaded = 'true';
      if (item.body) card.appendChild(node('p', item.body));
      if (item.changes) card.append(node('strong', t('actualChanges')), node('p', item.changes));
      if (item.next) card.append(node('strong', t('nextStep')), node('p', item.next));
      if (item.related_ids?.length) {
        const links = node('div', '', 'feedback-extras'); links.appendChild(node('span', t('relatedItems')));
        for (const id of item.related_ids) {
          const related = [...review.cases, ...review.feedback].find(r => r.id === id);
          const link = button(related?.title || id, () => {
          focusSection(review.cases.some(r => r.id === id) ? 'cases' : 'feedback');
          const target = [...box.querySelectorAll('[data-review-item]')].find(n => n.dataset.reviewItem === id);
          if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); }
        });
          link.dataset.relatedReviewId = id; links.appendChild(link);
        }
        card.appendChild(links);
      }
      for (const source of item.sources) {
        const evidence = node('div', '', 'feedback-record-field');
        if (source.quote) evidence.appendChild(node('blockquote', source.quote));
        sourceLink(source.url, source.label || t('reviewEvidence'), evidence); card.appendChild(evidence);
      }
      card.appendChild(button(t('reviewComment'), () => give(selected, {
        target_title: `${item.id} ${item.title}`, target_url: item.sources[0]?.url || '',
      })));
      }; card.addEventListener('toggle', populate);
      parent.appendChild(card);
    };
    overview.appendChild(node('h4', t('reviewFocus')));
    for (const item of review.attention) {
      const row = node('div', '', 'feedback-record-field');
      row.append(node('strong', item.title), node('p', item.next || item.body));
      renderItem(item, row, t('reviewEvidence')); if (item.action) row.appendChild(renderAction(item)); overview.appendChild(row);
    }
    if (review.knowledge.summary) {
      const knowledge = node('details'); knowledge.append(node('summary', t('reviewKnowledge')), node('p', review.knowledge.summary));
      sourceLink(review.knowledge.url, t('reviewFull'), knowledge); overview.appendChild(knowledge);
    }
    for (const [key, label] of [['feedback', 'reviewTopics'], ['cases', 'reviewCases'], ['history', 'reviewHistory']]) {
      const rows = review[key]; if (!rows.length) continue;
      const section = node('details', '', 'feedback-review-section'); section.dataset.reviewSection = key; section.open = selectedSection === key;
      section.appendChild(node('summary', `${t(label)} · ${rows.length}`));
      if (key === 'cases') section.appendChild(node('p', t('reviewInitial'), 'monitoring-note'));
      for (const item of rows) renderItem(item, section);
      box.appendChild(section);
    }
    const scope = node('details'); scope.append(node('summary', t('reviewScope')), node('p', review.scope)); overview.appendChild(scope);
    return box;
  }
  function renderDetail() {
    detailRoot.replaceChildren(); detailRoot.hidden = !selected; list.hidden = Boolean(selected);
    if (!selected) return;
    detailRoot.appendChild(button(t("back"), () => {
      selected = ""; detail = null; ++detailSerial; renderSummary(); renderDetail();
      const url = new URL(globalScope.location.href); url.searchParams.delete("feedback"); url.searchParams.delete("feedbackView"); globalScope.history.replaceState(null, "", url);
    }));
    if (!detail) { detailRoot.appendChild(node("p", t("loading"), "monitoring-note")); return; }
    const labels = { unassigned_feedback: "unassigned", related_context: "context", paused_history: "paused" };
    detailRoot.appendChild(node("h3", detail.project?.name || detail.group?.name || t(labels[selected] || "details")));
    if (detail.project) {
      const parent = summary?.groups.find(g => g.id === detail.project.group_id);
      if (parent) detailRoot.appendChild(button(parent.name, () => void select('group:' + parent.id)));
    }
    if (detail.group) {
      for (const p of detail.projects) {
        const child = node('div', '', 'feedback-extras'); child.appendChild(countedLink(p.name, p.id, 'overview'));
        child.appendChild(countedLink(`${t('rawFeedback')} ${p.feedback_count}`, p.id, 'records'));
        if (p.review) { child.appendChild(countedLink(`${t('reviewCases')} ${p.review.cases.length}`, p.id, 'cases')); child.appendChild(countedLink(`${t('reviewTopics')} ${p.review.feedback.length}`, p.id, 'feedback')); }
        detailRoot.appendChild(child);
      }
    }
    if (detail.project) {
      const stats = node('details', '', 'feedback-observations'); stats.appendChild(node('summary', t('usageOnDemand')));
      stats.addEventListener('toggle', async () => {
        if (!stats.open || stats.dataset.loaded) return; stats.dataset.loaded = 'true'; const content = node('div', t('loading')); stats.appendChild(content);
        try { const data = await fetchJsonOrRedirect(`/api/project-feedback?subproject=${encodeURIComponent(detail.project.id)}`, { revalidate: false }); content.replaceChildren(startContent(data.project), usageContent(data.project)); }
        catch (error) { content.textContent = error.message || t('failed'); delete stats.dataset.loaded; }
      });
      detailRoot.appendChild(stats);
    }
    if (detail.project?.review) {
      detailRoot.appendChild(renderReview(detail.project.review));
      detailRoot.appendChild(button(t("giveProject"), () => give(selected)));
    } else if (detail.project) {
      const facts = node('div', '', 'feedback-activity');
      facts.append(node('p', t(detail.project.attention.state === 'paused' ? 'attentionPaused' : detail.project.attention.state)));
      detailRoot.appendChild(facts);
      detailRoot.appendChild(button(t("giveProject"), () => give(selected)));
      detailRoot.appendChild(node("p", t("directionNote"), "monitoring-note"));
      const directions = node("ul");
      for (const d of detail.project.directions) directions.appendChild(node("li", d));
      detailRoot.appendChild(directions);
    }
    if (detail.gaps.length) detailRoot.appendChild(node("p", t("gaps", { count: detail.gaps.length }), "monitoring-note"));
    let recordRoot = detailRoot;
    if (detail.project?.review) {
      recordRoot = node('details', '', 'feedback-raw-records'); recordRoot.dataset.reviewSection = 'records';
      recordRoot.open = selectedSection === 'records' || detail.records.some(r => r.review_state === 'collected');
      recordRoot.appendChild(node('summary', t('records', { count: detail.records.length })));
      detailRoot.appendChild(recordRoot);
    } else detailRoot.appendChild(node("p", t("records", { count: detail.records.length }), "monitoring-note"));
    for (const r of detail.records) {
      const card = node("details", "", "feedback-record"); card.dataset.feedbackId = r.id;
      const title = node("summary", `${r.author} · ${time(r.created_at)} · ${(r.comment || r.target_title || r.emoji || t(r.usefulness === "useful" ? "useful" : r.usefulness === "not_useful" ? "notUseful" : "noText")).slice(0, 120)}`);
      card.appendChild(title);
      card.addEventListener('toggle', () => { if (!card.open || card.dataset.loaded) return; card.dataset.loaded = 'true';
      const row = (label, value) => { if (!value) return; const p = node("div", "", "feedback-record-field"); p.append(node("strong", t(label)), node("p", String(value))); card.appendChild(p); };
      row("comment", r.comment); row("signal", r.emoji || (r.usefulness && t(r.usefulness === "useful" ? "useful" : "notUseful")));
      row("target", r.target_title); row("quote", r.target_quote); row("example", r.example);
      row("analysis", r.analysis); row("theme", r.theme); row("reason", r.classification_reason);
      row("actualChanges", r.change_summary || t("changeUnknown"));
      row("nextStep", r.suggested_direction); row("candidate", r.pending_candidate);
      row("state", t(r.review_state === "collected" ? "collected" : "historicalState", { state: r.review_state || t("unknown") }));
      row("revision", r.target_revision); row("recordId", r.id); row("relatedId", r.related_feedback_id);
      const links = node("div", "", "feedback-extras"); sourceLink(r.source_url, t("source"), links); sourceLink(r.target_url, t("targetLink"), links);
      if (r.source_session_id) sourceLink(`/?tab=sessions&session=${encodeURIComponent(r.source_session_id)}`, t("conversation"), links);
      card.appendChild(links);
      if (r.bucket !== "paused_history") card.appendChild(button(t("supplement"), () => give(r.subproject_id, r)));
      });
      recordRoot.appendChild(card);
    }
    if (detail.project?.review) focusSection(selectedSection);
  }
  async function select(id, { sync = true, section = "overview" } = {}) {
    selectedSection = section; selected = id; detail = null; const request = ++detailSerial; renderDetail();
    if (sync) { const url = new URL(globalScope.location.href); url.searchParams.set("feedback", id); url.searchParams.set("feedbackView", section); globalScope.history.replaceState(null, "", url); }
    try {
      const next = await fetchJsonOrRedirect(`/api/project-feedback?usage=defer&subproject=${encodeURIComponent(id)}`, { revalidate: false });
      if (request === detailSerial) { detail = next; chosenGroup = detail.project?.group_id || detail.group?.id || chosenGroup; renderDetail(); detailRoot.scrollIntoView({ block: "start" }); }
    } catch (error) {
      if (request === detailSerial) { detailRoot.appendChild(node("p", error.message || t("failed"), "monitoring-note")); detailRoot.hidden = false; }
    }
  }
  async function load() {
    const request = ++serial; refresh.disabled = true;
    if (!summary) note.textContent = t("loading");
    try {
      const next = await fetchJsonOrRedirect("/api/project-feedback?usage=defer", { revalidate: false });
      if (request === serial) {
        const chosen = project.value; summary = next; renderSummary();
        if ([...project.options].some(o => o.value === chosen)) project.value = chosen;
        if (selected) await select(selected, { sync: false, section: selectedSection });
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

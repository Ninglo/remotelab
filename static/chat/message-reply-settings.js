import { DEFAULT_REPLY_DRAFT, buildReplyPreview } from './message-reply-model.js';

const root = document.getElementById('settings-message-replies');
const byId = id => document.getElementById(id);
let state = null;
let groups = [];
let defaultMechanism = '';
let busy = false;
let changed = false;
const english = () => document.documentElement.lang.startsWith('en');
const copy = (zh, en) => english() ? en : zh;
const status = text => { byId('replySettingsStatus').textContent = text; };

function readDraft() {
  return { opening: byId('replyOpening').checked, checklist: byId('replyChecklist').checked,
    progress: byId('replyShowProgress').checked ? byId('replyProgress').value : 'none',
    groups: [...byId('replyGroups').querySelectorAll('input:checked')].map(input => groups[Number(input.value)])
      .map(({ sourceRouteId, chatId }) => ({ sourceRouteId, chatId })) };
}

function renderPreview() {
  const preview = byId('replyMechanismPreview');
  preview.replaceChildren();
  for (const step of buildReplyPreview(readDraft(), english() ? 'en' : 'zh')) {
    const item = document.createElement('div');
    item.className = 'reply-preview-step';
    item.dataset.kind = step.kind;
    const title = document.createElement('strong');
    title.textContent = step.title;
    const text = document.createElement('p');
    text.textContent = step.text;
    item.append(title);
    if (step.text) item.append(text);
    if (step.card) {
      if (step.collapsed) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = copy('展开全部进展', 'Show all progress');
        const body = document.createElement('p');
        body.textContent = step.history.join('\n\n');
        details.append(summary, body);
        item.append(details);
        const behavior = document.createElement('p');
        behavior.className = 'settings-section-note';
        behavior.textContent = copy('记录较多时在原卡内翻页。后续更新保留上次展开、折叠和页码选择。',
          'Long histories use pages in the original card. Updates preserve your expand, collapse and page choice.');
        item.append(behavior);
      } else {
        const behavior = document.createElement('p');
        behavior.className = 'settings-section-note';
        behavior.textContent = copy('新进展替换卡片里显示的上一条，只保留最新一条。',
          'New progress replaces the previous visible update; the card shows the latest only.');
        item.append(behavior);
      }
      const note = document.createElement('p');
      note.className = 'settings-section-note';
      note.textContent = step.combined ? copy('进展更新上面的清单原卡，不另发一张卡。', 'Progress updates the checklist card above.')
        : copy('没有清单时，只创建一张进展卡，后续更新原卡。', 'Without a checklist, one progress card is created and updated.');
      item.append(note);
      if (step.textMessages?.length) {
        const messages = document.createElement('p');
        messages.textContent = copy('同时在原话题单独发送文字进展：\n', 'Also send separate text updates in the original topic:\n') + step.textMessages.join('\n\n');
        item.append(messages);
      }
    }
    preview.append(item);
  }
  byId('replyActivate').disabled = busy || changed || !state || !readDraft().groups.length;
  byId('replyProgress').disabled = busy || !byId('replyShowProgress').checked;
}

function describeChoices(value) {
  return copy(`首条文字${value.opening ? '开启' : '关闭'}；清单${value.checklist ? '按需显示' : '不显示'}；${({ none: '不发过程进展', messages: '卡片＋单独文字进展', card_latest: '卡片展示最新进展', card_all: '卡片展示全部进展（默认折叠）', card: '原已保存的卡片进展' })[value.progress]}`,
    `first reply ${value.opening ? 'on' : 'off'}; checklist ${value.checklist ? 'when useful' : 'off'}; ${({ none: 'no progress updates', messages: 'card + separate text updates', card_latest: 'latest progress in a card', card_all: 'all progress in a collapsed card', card: 'previously saved card progress' })[value.progress]}`);
}

function groupLabel(group) {
  return `${group.name} · ${copy('机器人来源', 'Bot source')}：${group.sourceRouteId}`;
}

function renderCurrent() {
  const activeNames = state?.active?.groups.map(value => groups.find(group => group.chatId === value.chatId
    && group.sourceRouteId === value.sourceRouteId)?.name || value.chatId) || [];
  byId('replySettingsCurrent').removeAttribute('data-i18n');
  byId('replySettingsCurrent').textContent = activeNames.length
    ? copy(`以下群已使用自定义回复：${activeNames.join('、')}（${describeChoices(state.active)}）。其余群沿用默认机制。下面显示的是草案，可能与正在使用的设置不同。`,
      `Custom replies are active for ${activeNames.join(', ')} (${describeChoices(state.active)}). Other groups use instance defaults. The draft below may differ from the active settings.`)
    : copy('所有群沿用当前默认机制。下面是尚未应用的自定义草案。', 'All groups use current instance defaults. The custom draft below has not been applied.');
  byId('replySettingsDefault').textContent = defaultMechanism === 'selectable_progress_card'
    ? copy('默认更新原卡并发送文字进展。群内卡片可选择“卡片＋新消息”或“只更新卡片”；选过的会话继续沿用自己的选择。简单答复不额外生成卡片。',
      'By default, progress updates the original card and sends text messages. The group card offers “Card + new messages” and “Card only”; each conversation keeps its existing choice. Simple answers need no extra card.')
    : defaultMechanism === 'folded_task_card'
      ? copy('有任务清单时，进展更新原卡，详情默认折叠、可展开；没有清单时直接给最终答复。会话已有的展开或收起选择继续有效。',
        'With a checklist, progress updates its original card and details start collapsed. Without a checklist, send the final reply directly. Existing conversation disclosure choices remain in effect.')
      : copy('未自定义的群沿用本实例当前默认方式，群内已有的进展选择继续有效。', 'Groups without custom settings use the current instance defaults and retain their existing progress choices.');
}

function renderState() {
  byId('replySaveDraft').disabled = busy || !state;
  const draft = state?.draft || DEFAULT_REPLY_DRAFT;
  byId('replyOpening').checked = draft.opening;
  byId('replyChecklist').checked = draft.checklist;
  byId('replyShowProgress').checked = draft.progress !== 'none';
  byId('replyProgress').value = draft.progress === 'none' ? 'messages' : draft.progress;
  const list = byId('replyGroups');
  list.replaceChildren();
  groups.forEach((group, index) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = String(index);
    input.checked = draft.groups.some(value => value.chatId === group.chatId && value.sourceRouteId === group.sourceRouteId);
    const name = document.createElement('span');
    name.textContent = groupLabel(group);
    label.append(input, name); list.append(label);
  });
  if (!groups.length) list.textContent = copy('还没有可选择的飞书群对话记录。', 'No recorded Feishu group conversations are available.');
  renderCurrent();
  byId('replyLegacy').disabled = busy || !state?.active;
  changed = false;
  renderPreview();
}

async function load() {
  try {
    const data = await fetchJsonOrRedirect('/api/message-reply-settings', { revalidate: false });
    state = data.settings; groups = data.groups || []; defaultMechanism = data.defaultMechanism || '';
    renderState();
  } catch (error) { status(error.message); }
}

async function mutate(action) {
  if (!state || busy) return;
  const body = { action, expectedRevision: state.revision };
  if (action === 'draft') body.draft = readDraft();
  else {
    const selectedNames = state.draft.groups.map(value => groups.find(group => group.chatId === value.chatId
      && group.sourceRouteId === value.sourceRouteId)?.name || value.chatId).join('、');
    const message = action === 'activate'
      ? copy(`将已保存的自定义回复应用到这些群吗：${selectedNames}？\n${describeChoices(state.draft)}\n\n只影响后续新工作，进行中的工作保持原样。`,
        `Apply the saved custom replies to ${selectedNames}?\n${describeChoices(state.draft)}\n\nOnly future work changes. Running work keeps its original settings.`)
      : copy('让后续新工作改回本实例当前默认机制吗？卡片内已有的进展选择继续有效；进行中的工作沿用原方式。',
        'Return future work to current instance defaults? Existing card progress choices remain in effect; running work keeps its original settings.');
    if (!window.confirm(message)) return;
    body.confirm = true;
  }
  busy = true;
  for (const field of root.querySelectorAll('input, select')) field.disabled = true;
  for (const button of root.querySelectorAll('button')) button.disabled = true;
  try {
    const data = await fetchJsonOrRedirect('/api/message-reply-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), revalidate: false });
    state = data.settings;
    renderState();
    status(action === 'draft' ? copy('草案已保存，尚未应用。当前正在使用的方式未改变。', 'Draft saved, without applying it. Active reply settings have not changed.')
      : action === 'activate' ? copy('自定义回复已应用到所选群，仅影响后续新工作。', 'Custom replies applied to selected groups for future work only.')
        : copy('已改回当前默认机制，原有会话选择继续有效。', 'Returned to current instance defaults. Existing conversation choices remain in effect.'));
  } catch (error) { status(error.message); }
  finally {
    busy = false;
    for (const field of root.querySelectorAll('input, select')) field.disabled = false;
    byId('replySaveDraft').disabled = !state;
    byId('replyLegacy').disabled = !state?.active;
    renderPreview();
  }
}

if (root) {
  root.addEventListener('change', event => {
    if (!event.target.matches('input, select')) return;
    changed = true;
    renderPreview();
    status(copy('正在编辑草案，当前回复方式未改变。请先保存，再确认应用。', 'Editing the draft has not changed active replies. Save it before confirming application.'));
  });
  byId('replySaveDraft').addEventListener('click', () => void mutate('draft'));
  byId('replyActivate').addEventListener('click', () => void mutate('activate'));
  byId('replyLegacy').addEventListener('click', () => void mutate('legacy'));
  window.addEventListener('remotelab:localechange', () => {
    if (state) renderCurrent();
    byId('replyGroups').querySelectorAll('label span').forEach((name, index) => {
      name.textContent = groupLabel(groups[index]);
    });
    renderPreview();
  });
  void load();
}

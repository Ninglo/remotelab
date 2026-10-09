import { DEFAULT_REPLY_DRAFT, buildReplyPreview } from './message-reply-model.js';

const root = document.getElementById('settings-message-replies');
const byId = id => document.getElementById(id);
let state = null;
let groups = [];
let busy = false;
let changed = false;
const english = () => document.documentElement.lang.startsWith('en');
const copy = (zh, en) => english() ? en : zh;
const status = text => { byId('replySettingsStatus').textContent = text; };

function readDraft() {
  return { opening: byId('replyOpening').checked, checklist: byId('replyChecklist').checked,
    progress: byId('replyProgress').value,
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
    item.append(title, text);
    if (step.card) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = copy('点击显示进展', 'Show progress');
      const body = document.createElement('p');
      body.textContent = copy('这里显示近期进展记录。真实卡片沿用同一条消息，更新后保留手动展开选择。',
        'Recent progress appears here. The real card updates the same message and preserves the shared disclosure choice.');
      details.append(summary, body);
      item.append(details);
      const note = document.createElement('p');
      note.className = 'settings-section-note';
      note.textContent = step.combined ? copy('进展更新上面的清单原卡，不另发一张卡。', 'Progress updates the checklist card above.')
        : copy('没有清单时，只创建一张进展卡，后续更新原卡。', 'Without a checklist, one progress card is created and updated.');
      item.append(note);
    }
    preview.append(item);
  }
  byId('replyActivate').disabled = busy || changed || !state || !readDraft().groups.length;
}

function renderState() {
  byId('replySaveDraft').disabled = busy || !state;
  const draft = state?.draft || DEFAULT_REPLY_DRAFT;
  byId('replyOpening').checked = draft.opening;
  byId('replyChecklist').checked = draft.checklist;
  byId('replyProgress').value = draft.progress;
  const list = byId('replyGroups');
  list.replaceChildren();
  groups.forEach((group, index) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = String(index);
    input.checked = draft.groups.some(value => value.chatId === group.chatId && value.sourceRouteId === group.sourceRouteId);
    const name = document.createElement('span');
    name.textContent = `${group.name} · ${group.sourceRouteId}`;
    label.append(input, name); list.append(label);
  });
  if (!groups.length) list.textContent = copy('还没有可选择的飞书群对话记录。', 'No recorded Feishu group conversations are available.');
  const activeNames = state?.active?.groups.map(value => groups.find(group => group.chatId === value.chatId
    && group.sourceRouteId === value.sourceRouteId)?.name || value.chatId) || [];
  const activeChoices = state?.active ? copy(
    `首条文字${state.active.opening ? '开启' : '关闭'}，清单${state.active.checklist ? '开启' : '关闭'}，${({ none: '不发进展', messages: '文字进展', card: '卡片进展' })[state.active.progress]}`,
    `opening ${state.active.opening ? 'on' : 'off'}, checklist ${state.active.checklist ? 'on' : 'off'}, progress: ${state.active.progress}`) : '';
  byId('replySettingsCurrent').removeAttribute('data-i18n');
  byId('replySettingsCurrent').textContent = activeNames.length
    ? copy(`当前：新模式已用于 ${activeNames.join('、')}（${activeChoices}）。其他群继续旧模式。`, `Active: new mode for ${activeNames.join(', ')} (${activeChoices}). Other groups keep the existing mode.`)
    : copy('当前：全部继续使用旧模式。保存草案和查看预览都不会生效。', 'Current: all groups use the existing mode. Saving and previewing a draft does not activate it.');
  byId('replyLegacy').disabled = busy || !state?.active;
  changed = false;
  renderPreview();
}

async function load() {
  try {
    const data = await fetchJsonOrRedirect('/api/message-reply-settings', { revalidate: false });
    state = data.settings; groups = data.groups || [];
    renderState();
  } catch (error) { status(error.message); }
}

async function mutate(action) {
  if (!state || busy) return;
  const body = { action, expectedRevision: state.revision };
  if (action === 'draft') body.draft = readDraft();
  else {
    const message = action === 'activate'
      ? copy('确认在选中群的新请求中采用已保存的消息回复草案？进行中的请求保持原模式。', 'Apply the saved draft to new requests in the selected groups? Running requests keep their original mode.')
      : copy('确认让后续新请求恢复旧模式？已接受的请求和原有卡片保留原机制。', 'Return future requests to the existing mode? Accepted requests and existing cards retain their original policy.');
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
    status(action === 'draft' ? copy('草案已保存，正在使用的模式未改变。', 'Draft saved. The active mode has not changed.')
      : copy('切换已保存。新请求按选定模式处理。', 'Mode saved for future requests.'));
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
    status(copy('预览已更新；请先保存草案，之后才能确认生效。', 'Preview updated. Save the draft before activating it.'));
  });
  byId('replySaveDraft').addEventListener('click', () => void mutate('draft'));
  byId('replyActivate').addEventListener('click', () => void mutate('activate'));
  byId('replyLegacy').addEventListener('click', () => void mutate('legacy'));
  window.addEventListener('remotelab:localechange', renderPreview);
  void load();
}

import { buildReplyPreview } from './message-reply-model.js';

const root = document.getElementById('settings-message-replies');
const byId = id => document.getElementById(id);
let state = null, busy = false, changed = false;
const english = () => document.documentElement.lang.startsWith('en');
const copy = (zh, en) => english() ? en : zh;
const status = text => { byId('replySettingsStatus').textContent = text; };
function readChoices() {
  return { opening: byId('replyOpening').checked, checklist: byId('replyChecklist').checked,
    strictStartCheck: byId('replyStrictStartCheck').checked,
    progress: byId('replyShowProgress').checked ? byId('replyProgress').value : 'none' };
}
function readDraft() { return { ...readChoices(), groups: [] }; }

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
  byId('replyActivate').disabled = busy || !state || !changed;
  byId('replyProgress').disabled = busy || !byId('replyShowProgress').checked;
}

function describeChoices(value) {
  return copy(`开工严格检查${value.strictStartCheck ? '开启' : '关闭'}；首条文字${value.opening ? '开启' : '关闭'}；清单${value.checklist ? '按需显示' : '不显示'}；${({ none: '不发过程进展', messages: '卡片＋单独文字进展', card_latest: '卡片展示最新进展', card_all: '卡片展示全部进展（默认折叠）', card: '原已保存的卡片进展' })[value.progress]}`,
    `strict work-start check ${value.strictStartCheck ? 'on' : 'off'}; first reply ${value.opening ? 'on' : 'off'}; checklist ${value.checklist ? 'when useful' : 'off'}; ${({ none: 'no progress updates', messages: 'card + separate text updates', card_latest: 'latest progress in a card', card_all: 'all progress in a collapsed card', card: 'previously saved card progress' })[value.progress]}`);
}

function renderCurrent() {
  byId('replySettingsCurrent').removeAttribute('data-i18n');
  byId('replySettingsCurrent').textContent = state?.active
    ? copy(`已生效：${describeChoices(state.active)}。`, `Active: ${describeChoices(state.active)}.`)
    : copy('正在使用默认回复方式。保存后，网页与飞书将沿用你的选择。',
      'Using default replies. Save to use your choices on Web and Feishu.');
}
function renderState() {
  const value = state.choices;
  byId('replyStrictStartCheck').checked = value.strictStartCheck === true;
  byId('replyOpening').checked = value.opening;
  byId('replyChecklist').checked = value.checklist;
  byId('replyShowProgress').checked = value.progress !== 'none';
  byId('replyProgress').value = value.progress === 'none' ? 'messages' : value.progress;
  changed = !state.active;
  byId('replyLegacy').disabled = busy || !state.active;
  renderCurrent();
  renderPreview();
}
async function load() {
  try {
    const data = await fetchJsonOrRedirect('/api/message-reply-settings', { revalidate: false });
    state = data.settings;
    renderState();
  } catch (error) { status(error.message); }
}
async function mutate(action) {
  if (!state || busy) return;
  const body = { action, expectedRevision: state.revision, confirm: true };
  if (action === 'apply') body.choices = readChoices();
  busy = true;
  for (const field of root.querySelectorAll('input, select, button')) field.disabled = true;
  try {
    const data = await fetchJsonOrRedirect('/api/message-reply-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), revalidate: false });
    state = data.settings;
    renderState();
    status(action === 'apply'
      ? copy('已保存并生效。你在网页和飞书发起的新工作都会使用这套设置。',
        'Saved and applied to new work you start on Web and Feishu.')
      : copy('已恢复你的默认回复方式。', 'Your default reply settings have been restored.'));
  } catch (error) { status(error.message); }
  finally {
    busy = false;
    for (const field of root.querySelectorAll('input, select, button')) field.disabled = false;
    byId('replyLegacy').disabled = !state.active;
    renderPreview();
  }
}
if (root) {
  root.addEventListener('change', event => {
    if (!event.target.matches('input, select')) return;
    changed = true;
    renderPreview();
    status(copy('尚未保存。点击“保存并应用”后生效。', 'Not saved yet. Click “Save and apply” to use these choices.'));
  });
  byId('replyActivate').addEventListener('click', () => void mutate('apply'));
  byId('replyLegacy').addEventListener('click', () => void mutate('reset'));
  window.addEventListener('remotelab:localechange', () => { if (state) renderCurrent(); renderPreview(); });
  void load();
}

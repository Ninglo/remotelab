const root = document.getElementById('settings-personal-memory');
const button = document.getElementById('personalMemoryToggle');
const status = document.getElementById('personalMemoryStatus');
let state = null, busy = false, errorMessage = '';
const copy = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;
function render() {
  for (const title of document.querySelectorAll('[data-personal-memory-title]')) title.textContent = copy('个人记忆', 'Personal memory');
  document.getElementById('personalMemoryNote').textContent = copy(
    '从协作中发现有用的个人习惯。飞书新候选会发送确认卡，也可以在这里审阅。只有本人确认后才按需使用。',
    'Review useful personal habits here or on their Feishu confirmation cards. Only your confirmed memories are used when relevant.');
  button.textContent = state?.conversational && state.enabled ? copy('停用个人记忆', 'Pause personal memory') : copy('启用个人记忆', 'Enable personal memory');
  button.disabled = busy || !state?.available;
  button.setAttribute('aria-pressed', String(Boolean(state?.conversational && state.enabled)));
  status.textContent = errorMessage || (!state ? copy('正在读取……', 'Loading…')
    : !state.available ? copy('当前尚未向你的账号开放试点。', 'The trial is not available for your account yet.')
      : state.conversational && state.enabled ? copy('已启用。确认后才作为长期偏好；未回复不会反复催问。', 'Enabled. Candidates become lasting preferences only after confirmation; unanswered questions are not repeated.')
        : state.conversational ? copy('已停用。停止新增观察、自动读取和记忆询问，已有记录保留。', 'Paused. No new observations, automatic retrieval or memory questions. Existing records are retained.')
          : copy('开启后，新候选由你确认后使用。', 'Enable to review new candidates before use.'));
}
async function load() {
  try { state = (await fetchJsonOrRedirect('/api/personal-memory-settings', { revalidate: false })).settings; errorMessage = ''; }
  catch (error) { errorMessage = error.message; }
  render();
}
async function toggle() {
  if (busy || !state?.available) return;
  busy = true; errorMessage = ''; render();
  try {
    const data = await fetchJsonOrRedirect('/api/personal-memory-settings', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, revalidate: false,
      body: JSON.stringify({ enabled: !(state.conversational && state.enabled), expectedRevision: state.revision, confirm: true }) });
    state = data.settings;
  } catch (error) { errorMessage = error.message; }
  finally { busy = false; render(); }
}
if (root) {
  button.addEventListener('click', () => void toggle());
  window.addEventListener('remotelab:localechange', render);
  // Recover a stale revision when returning from a different device/tab.
  window.addEventListener('focus', () => { if (!busy) void load(); });
  void load();
}


const reviewButton = document.getElementById('personalMemoryReview');
const reviewList = document.getElementById('personalMemoryEntries');
let nextPage = '', reviewBusy = false;
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
async function decide(entry, action, fields = {}) {
  await fetchJsonOrRedirect('/api/personal-memory-entries', { method: 'POST', revalidate: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: entry.id, expectedVersion: entry.version, action, ...fields }) });
  await loadEntries();
}
function entryRow(entry) {
  const row = element('article', undefined, 'personal-memory-entry');
  row.append(element('p', entry.status === 'confirmed' ? copy('已确认', 'Confirmed') : copy('待确认', 'Pending'), 'settings-section-note'));
  row.append(element('p', entry.content));
  if (entry.conditions) row.append(element('p', copy('适用：', 'When: ') + entry.conditions, 'settings-section-note'));
  if (entry.exceptions) row.append(element('p', copy('例外：', 'Except: ') + entry.exceptions, 'settings-section-note'));
  const actions = element('div', undefined, 'settings-app-actions');
  const add = (text, callback) => {
    const b = element('button', text, 'settings-app-btn'); b.type = 'button';
    b.addEventListener('click', async () => {
      if (reviewBusy) return;
      reviewBusy = true; b.disabled = true;
      try { await callback(); }
      catch (error) { status.textContent = error.message; }
      finally { reviewBusy = false; b.disabled = false; }
    }); actions.append(b);
  };
  if (entry.status !== 'confirmed') add(copy('保留', 'Keep'), () => decide(entry, 'keep'));
  add(copy('修改', 'Edit'), () => {
    const form = element('form'); const inputs = {};
    for (const [key, label, limit] of [['content',copy('记忆内容','Memory'),800],['conditions',copy('适用时机','When to use'),500],['exceptions',copy('例外','Exceptions'),500]]) {
      const labelNode = element('label', label); const input = element('textarea');
      input.value = entry[key] || ''; input.maxLength = limit; input.rows = key === 'content' ? 3 : 2;
      input.required = key === 'content'; input.style.width = '100%'; inputs[key] = input;
      labelNode.append(input); form.append(labelNode);
    }
    const save = element('button',copy('保存修改','Save'),'settings-app-btn'); save.type = 'submit';
    const cancel = element('button',copy('取消','Cancel'),'settings-app-btn'); cancel.type = 'button';
    cancel.addEventListener('click',()=>row.replaceWith(entryRow(entry)));
    form.append(save,cancel);
    form.addEventListener('submit',async event=>{
      event.preventDefault(); if(reviewBusy) return; reviewBusy=true; save.disabled=true;
      try { await decide(entry,'edit',Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value]))); }
      catch(error){ status.textContent=error.message; }
      finally { reviewBusy=false; save.disabled=false; }
    });
    row.replaceChildren(form);
  });
  add(copy('删除', 'Delete'), () => decide(entry, 'delete'));
  row.append(actions); return row;
}
async function loadEntries(append = false) {
  const data = await fetchJsonOrRedirect('/api/personal-memory-entries' + (append && nextPage ? '?after=' + encodeURIComponent(nextPage) : ''), { revalidate: false });
  if (!append) reviewList.replaceChildren();
  reviewList.querySelector('[data-memory-more]')?.remove();
  reviewList.hidden = false;
  for (const entry of data.entries) reviewList.append(entryRow(entry));
  if (!data.total) reviewList.append(element('p', copy('暂无需要审阅的记忆。', 'No memories to review.')));
  nextPage = data.next;
  if (nextPage) {
    const more=element('button',copy('继续查看','Load more'),'settings-app-btn'); more.type='button'; more.dataset.memoryMore='true';
    more.addEventListener('click',()=>loadEntries(true).catch(error=>{status.textContent=error.message;})); reviewList.append(more);
  }
  status.textContent=copy('只显示本人的记忆。删除后不再检索或使用，审计历史保留。','Only your memories are shown. Deleted memories stop being retrieved or used; audit history is retained.');
}
reviewButton?.addEventListener('click',()=>loadEntries().catch(error=>{status.textContent=error.message;}));

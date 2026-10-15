const root = document.getElementById('settings-personal-memory');
const button = document.getElementById('personalMemoryToggle');
const status = document.getElementById('personalMemoryStatus');
let state = null, busy = false, errorMessage = '';
const copy = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;
function render() {
  for (const title of document.querySelectorAll('[data-personal-memory-title]')) title.textContent = copy('个人记忆', 'Personal memory');
  document.getElementById('personalMemoryNote').textContent = copy(
    '从与你的协作中发现有用的习惯，在自然对话中补充一句询问是否记住。只影响本人在网页和飞书的消息，不另发私聊核验。',
    'Notice useful collaboration patterns and ask briefly in the conversation whether to remember them. Applies only to your Web and Feishu messages, without separate review messages.');
  button.textContent = state?.conversational && state.enabled ? copy('停用个人记忆', 'Pause personal memory') : copy('启用个人记忆', 'Enable personal memory');
  button.disabled = busy || !state?.available;
  button.setAttribute('aria-pressed', String(Boolean(state?.conversational && state.enabled)));
  status.textContent = errorMessage || (!state ? copy('正在读取……', 'Loading…')
    : !state.available ? copy('当前尚未向你的账号开放试点。', 'The trial is not available for your account yet.')
      : state.conversational && state.enabled ? copy('已启用。确认后才作为长期偏好；未回复不会反复催问。', 'Enabled. Candidates become lasting preferences only after confirmation; unanswered questions are not repeated.')
        : state.conversational ? copy('已停用。停止新增观察、自动读取和记忆询问，已有记录保留。', 'Paused. No new observations, automatic retrieval or memory questions. Existing records are retained.')
          : copy('开启后，改为在对话中询问是否记住。', 'Enable to review memories naturally in conversation.'));
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

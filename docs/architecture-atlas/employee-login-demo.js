// A local presentation state machine. Deliberately no auth API, cookies or storage.
const states = {
  login: { tab: '原标签页', address: '当前域名 /site-login?returnTo=/public-pages/employee-login-demo-a/', text: '打开站点 A → 服务器发现未登录 → 跳到统一员工登录页，并记住原网址。' },
  feishu: { tab: '新标签页：飞书（示意）', address: 'accounts.feishu.cn / 身份确认', text: '点击“使用飞书登录”会新开飞书页面。原标签页仍停在员工登录页，按飞书给定的间隔等待授权结果。' },
  a: { tab: '回到原标签页', address: '当前域名 /public-pages/employee-login-demo-a/', text: '飞书确认完成 → 服务器核对公司身份，签发共享登录 Cookie → 原标签页自动进入最初请求的站点 A。' },
  b: { tab: '同一浏览器内打开另一个网站', address: '当前域名 /public-pages/employee-login-demo-b/', text: '站点 B 与 A 使用同一域名。浏览器自动携带有效 Cookie，服务器直接放行，本次不会再打开登录页或飞书。' },
};
function show(name) {
  const state = states[name];
  if (!state) return;
  for (const key of Object.keys(states)) document.getElementById(`screen-${key}`).hidden = key !== name;
  for (const button of document.querySelectorAll('[data-stage]')) button.setAttribute('aria-pressed', String(button.dataset.stage === name));
  document.getElementById('tab-label').textContent = state.tab;
  document.getElementById('address').textContent = state.address;
  document.getElementById('explanation').textContent = state.text;
}
for (const button of document.querySelectorAll('[data-stage],[data-next]')) button.addEventListener('click', () => show(button.dataset.stage || button.dataset.next));
document.getElementById('reset').addEventListener('click', () => show('login'));

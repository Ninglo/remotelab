// A local presentation state machine. Deliberately no auth API, cookies or storage.
const states = {
  login: { tab: '当前标签页：公司统一登录', address: 'auth.mukarobotics.com / 登录', text: '打开站点 A → 网关跳到公司 SSO；已有 Hub/Data 有效登录时直接继续，否则显示飞书登录。' },
  feishu: { tab: '飞书身份确认（示意）', address: '公司 SSO / 飞书扫码或当前设备登录', text: '首次登录使用公司现有飞书入口。无需为每个网站创建账号，也不再使用网站自己的设备授权轮询。' },
  a: { tab: '自动返回原网站', address: '网站入口 /public-pages/employee-login-demo-a/', text: '公司身份已确认或已有有效主会话 → 网关完成 OAuth 回调 → 返回原网站 A；RemoteLab 接收已核员工身份。' },
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

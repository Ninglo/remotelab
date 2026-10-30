const isB = location.pathname.split('/').includes('employee-login-demo-b');
const label = isB ? 'B' : 'A';
document.title = `站点 ${label} · 员工登录示例`;
document.getElementById('title').textContent = `站点 ${label} · ${isB ? '实验看板' : '项目资料'}`;
const other = document.getElementById('other');
other.href = `/public-pages/employee-login-demo-${isB ? 'a' : 'b'}/`;
other.textContent = `打开示例站 ${isB ? 'A' : 'B'}`;
async function readIdentity() {
  const status = document.getElementById('identity');
  try {
    const response = await fetch('/api/site-login/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error('无法读取');
    const { person } = await response.json();
    status.textContent = `当前登录：${person.name || '公司员工'}。已由共享登录服务确认身份。`;
  } catch { status.textContent = '当前未能读取登录身份，请刷新页面重试。'; }
}
readIdentity();

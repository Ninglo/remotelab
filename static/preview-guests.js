const $ = id => document.getElementById(id);
const base = document.body.dataset.base;
const status = $('status');
function show(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}
async function api(action, body) {
  const response = await fetch(`${base}/_invite/api/${action}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (response.status === 401 && $('issue')) {
    location.assign(`/site-login?returnTo=${encodeURIComponent(location.pathname)}`);
    throw Error('请重新登录');
  }
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '操作没有完成');
  return data;
}
function item(grant, active) {
  const row = document.createElement('li'), detail = document.createElement('span'), label = document.createElement('strong');
  const meta = document.createElement('small');
  label.textContent = grant.label;
  const date = at => new Date(at).toLocaleString();
  meta.textContent = grant.revokedAt ? `已撤销 · ${date(grant.revokedAt)}` : grant.redeemedAt ? `已接受 · ${date(grant.redeemedAt)}`
    : `${active ? '待接受，到期' : '已过期'} · ${date(grant.expiresAt)}`;
  detail.append(label, meta);
  row.append(detail);
  if (active) {
    const revoke = document.createElement('button');
    revoke.type = 'button'; revoke.className = 'secondary'; revoke.textContent = '撤销';
    revoke.addEventListener('click', async () => {
      if (!confirm(`撤销「${grant.label}」的邀请与访问权限？`)) return;
      revoke.disabled = true; show('');
      try {
        await api('revoke', { id: grant.id });
        if ($('result').dataset.grant === grant.id) { $('result').hidden = true; $('link').value = ''; }
        await refresh(); show('已撤销。');
      } catch (error) { show(error.message, true); revoke.disabled = false; }
    });
    row.append(revoke);
  }
  return row;
}
function renderList(node, rows, active) {
  if (rows.length) node.replaceChildren(...rows.map(row => item(row, active)));
  else {
    const empty = document.createElement('li'); empty.className = 'empty';
    empty.textContent = active ? '暂无有效邀请或访客。' : '暂无近期记录。';
    node.replaceChildren(empty);
  }
}
async function refresh() {
  const data = await api('grants');
  renderList($('current'), data.current, true);
  renderList($('inactive'), data.inactive, false);
}
if ($('issue')) {
  $('issue').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true; show('');
    try {
      const data = await api('grants', { label: $('label').value });
      $('result').dataset.grant = data.grant.id;
      $('link').value = data.link; $('result').hidden = false; $('label').value = '';
      $('link').focus(); $('link').select();
      await refresh();
    } catch (error) { show(error.message, true); }
    finally { button.disabled = false; }
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('link').value); show('已复制，请通过私聊发送。'); }
    catch { $('link').focus(); $('link').select(); show('请复制已选中的链接。'); }
  });
  refresh().catch(error => show(error.message, true));
}
if ($('accept')) {
  const secret = location.hash.slice(1);
  // The fragment stays local, survives refresh, and is replaced after redemption.
  const accept = $('accept');
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    accept.disabled = true;
    show('请打开收到的完整邀请链接；如果你已经接受，可返回网站。', true);
  }
  accept.addEventListener('click', async () => {
    accept.disabled = true; show('');
    try { await api('redeem', { secret }); location.replace(`${base}/`); }
    catch (error) { show(error.message, true); accept.disabled = false; }
  });
}

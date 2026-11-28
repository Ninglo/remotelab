(() => {
  const root = document.getElementById('settings-model-sources');
  if (!root) return;
  const content = root.querySelector('[data-model-source-content]');
  const status = root.querySelector('[role=status]');
  const base = '/api/model-sources';
  const scopeName = { personal: '个人', group: '小组', shared: '公用' };
  const request = (path, body) => fetchJsonOrRedirect(base + path, {
    revalidate: false, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const element = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };
  function editor(item, people, path, scopes) {
    const box = element('form');
    box.append(element('strong', item.name));
    const scope = element('select'); scope.setAttribute('aria-label', `${item.name}的使用范围`);
    for (const key of scopes) {
      const option = element('option', scopeName[key]); option.value = key; scope.append(option);
    }
    scope.value = item.scope;
    const members = element('fieldset');
    members.append(element('legend', '选择可使用的成员（不含本人）'));
    const list = element('div'); list.style.maxHeight = '12rem'; list.style.overflow = 'auto';
    for (const person of people) {
      const label = element('label'); label.style.display = 'block';
      const check = element('input'); check.type = 'checkbox'; check.value = person.id;
      check.checked = item.memberPersonIds.includes(person.id);
      label.append(check, ` ${person.name}${person.handle ? `（${person.handle}）` : ''}`);
      list.append(label);
    }
    members.append(list); members.hidden = scope.value !== 'group';
    const hint = element('p');
    function explain() {
      members.hidden = scope.value !== 'group';
      hint.textContent = scope.value === 'shared' ? '本实例中有使用权限的所有人均可调用。'
        : scope.value === 'group' ? '只有你和选中的成员可以使用。' : '只有你可以使用。';
    }
    scope.addEventListener('change', explain); explain();
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = item.enabled !== false;
    if (scopes.includes('shared')) {
      const label = element('label'); label.append(enabled, ' 启用'); box.append(label);
    }
    const save = element('button', '确认并保存范围'); save.className = 'settings-app-btn'; save.type = 'submit';
    box.append(scope, hint, members, save);
    box.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try {
        await request(path, { scope: scope.value, revision: item.revision, enabled: enabled.checked,
          memberPersonIds: scope.value === 'group' ? [...list.querySelectorAll('input:checked')].map(input => input.value) : [] });
        await load('已保存。变更后的请求按新范围处理。');
      } catch (error) { status.textContent = error.message || '无法保存范围'; }
      finally { save.disabled = false; }
    });
    return box;
  }
  async function load(message = '') {
    try {
      const data = await request('');
      const fragment = document.createDocumentFragment();
      const codex = data.codex;
      if (codex.owned) fragment.append(editor({ name: '我的 Codex 绑定', ...codex.owned }, data.people, '/codex-sharing', ['personal', 'group']));
      else if (codex.canBind) {
        const link = element('a', '在「我的 Codex」绑定账号'); link.href = '?tab=settings#settings-personal-codex';
        fragment.append(link);
      }
      for (const group of codex.groups.filter(group => !group.owned)) fragment.append(element('p', `${group.label || 'Codex'} · 小组授权`));
      for (const source of data.sources) {
        fragment.append(source.owned ? editor(source, data.people, `/${encodeURIComponent(source.id)}/sharing`, Object.keys(scopeName))
          : element('p', `${source.name} · ${scopeName[source.scope]}`));
      }
      if (!fragment.childNodes.length) fragment.append(element('p', '暂无分配到你的模型来源。'));
      content.replaceChildren(fragment);
      status.textContent = message;
    } catch (error) { status.textContent = error.message || '无法读取模型来源'; }
  }
  const refresh = root.querySelector('button');
  refresh.addEventListener('click', () => void load());
  for (const link of document.querySelectorAll('[data-settings-target="settings-model-sources"]')) link.addEventListener('click', () => void load());
  if (window.location.hash === '#settings-model-sources') void load();
})();

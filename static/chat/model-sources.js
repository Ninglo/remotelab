(() => {
  const root = document.getElementById('settings-accounts');
  if (!root) return;
  const status = document.getElementById('settings-model-sources');
  const otherProviders = document.getElementById('settingsOtherAccountProviders');
  const providers = ['codex', 'claude', 'google', 'pi'];
  const scopes = ['personal', 'group', 'shared'];
  const tr = key => window.remotelabT(`settings.accounts.${key}`);
  const base = '/api/model-sources';
  const request = (path, body) => fetchJsonOrRedirect(base + path, {
    revalidate: false, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const element = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };
  const say = message => { status.textContent = message; status.hidden = !message; };
  let latest = null, inflight = null;

  function editor(item, people, path, availableScopes) {
    const card = element('details'); card.className = 'settings-fold settings-source-editor';
    card.dataset.sourceEditor = path;
    card.append(element('summary', item.name));
    const form = element('form');
    const scope = element('select'); scope.className = 'settings-inline-select'; scope.setAttribute('aria-label', tr('scope'));
    for (const key of availableScopes) {
      const option = element('option', tr(key)); option.value = key; scope.append(option);
    }
    scope.value = item.scope;
    const members = element('fieldset');
    members.append(element('legend', tr('selectMembers')));
    const search = element('input'); search.type = 'search'; search.className = 'settings-inline-input';
    search.placeholder = tr('peopleSearchHint'); search.setAttribute('aria-label', tr('peopleSearch'));
    const list = element('div'); list.className = 'settings-source-members';
    for (const person of people) {
      const label = element('label');
      const check = element('input'); check.type = 'checkbox'; check.value = person.id;
      check.checked = item.memberPersonIds.includes(person.id);
      label.append(check, ` ${person.name}${person.handle ? ` (@${person.handle})` : ''}`);
      list.append(label);
    }
    search.addEventListener('input', () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const label of list.children) label.hidden = !label.textContent.toLocaleLowerCase().includes(query);
    });
    members.append(search, list);
    const hint = element('p'); hint.className = 'settings-section-note';
    function explain() {
      members.hidden = scope.value !== 'group';
      hint.textContent = tr(`${scope.value}Hint`);
    }
    scope.addEventListener('change', explain); explain();
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = item.enabled !== false;
    form.append(scope, hint, members);
    if (availableScopes.includes('shared')) {
      const label = element('label'); label.append(enabled, ` ${tr('enabled')}`); form.append(label);
    }
    const save = element('button', tr('save')); save.className = 'settings-app-btn'; save.type = 'submit';
    const feedback = element('p'); feedback.className = 'settings-section-note'; feedback.setAttribute('role', 'status');
    form.append(save, feedback);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; feedback.textContent = '';
      try {
        await request(path, { scope: scope.value, revision: item.revision, enabled: enabled.checked,
          memberPersonIds: scope.value === 'group' ? [...list.querySelectorAll('input:checked')].map(input => input.value) : [] });
        await load(true);
        const moved = [...root.querySelectorAll('[data-source-editor]')].find(node => node.dataset.sourceEditor === path);
        if (moved) {
          const publicSection = moved.closest('[data-account-public]');
          if (publicSection) publicSection.open = true;
          moved.open = true;
          moved.querySelector('summary').focus();
          moved.querySelector('[role=status]').textContent = tr('saved');
        }
      } catch (error) { feedback.textContent = error.message || tr('saveError'); }
      finally { save.disabled = false; }
    });
    card.append(form);
    return card;
  }

  function render(data) {
    const expanded = new Set([...root.querySelectorAll('[data-source-editor][open]')].map(node => node.dataset.sourceEditor));
    const slots = new Map([...root.querySelectorAll('[data-source-slot]')].map(slot => [slot.dataset.sourceSlot, slot]));
    for (const [key, slot] of slots) if (providers.includes(key.split(':')[0])) slot.replaceChildren();
    const codex = data.codex;
    const binding = document.getElementById('settings-personal-codex');
    const bindingScope = codex.owned?.scope || 'personal';
    const bindingSlot = root.querySelector(`[data-codex-binding="${bindingScope}"]`);
    if (binding && binding.parentElement !== bindingSlot) {
      bindingSlot.append(binding);
      window.remotelabPersonalCodex?.layoutChanged();
    }
    if (codex.owned) slots.get(`codex:${bindingScope}`).append(editor({ name: tr('manageSharing'), ...codex.owned },
      data.people, '/codex-sharing', ['personal', 'group']));
    for (const group of codex.groups.filter(group => !group.owned)) {
      slots.get('codex:group').append(element('p', `${group.label || 'Codex'} · ${tr('granted')}`));
    }
    const futureIds = new Set();
    for (const source of data.sources) {
      let provider = source.provider;
      if (!providers.includes(provider)) {
        provider = `api-${source.id}`;
        futureIds.add(provider);
        let panel = document.getElementById(`settings-accounts-${provider}`);
        if (!panel) {
          panel = element('details'); panel.id = `settings-accounts-${provider}`;
          panel.className = 'settings-fold settings-account-provider';
          panel.append(element('summary', source.name)); otherProviders.append(panel);
          for (const scope of scopes) {
            const section = element(scope === 'shared' ? 'details' : 'div');
            section.className = scope === 'shared' ? 'settings-fold settings-account-public' : 'settings-account-scope';
            section.append(element(scope === 'shared' ? 'summary' : 'h4', tr(scope)));
            const slot = element('div'); slot.dataset.sourceSlot = `${provider}:${scope}`;
            section.append(slot); panel.append(section); slots.set(slot.dataset.sourceSlot, slot);
          }
        } else {
          [...panel.querySelectorAll('[data-source-slot]')].forEach((slot, index) => {
            slot.previousElementSibling.textContent = tr(scopes[index]); slot.replaceChildren();
          });
        }
      }
      const slot = slots.get(`${provider}:${source.scope}`);
      if (!slot) continue;
      slot.append(source.owned ? editor(source, data.people, `/${encodeURIComponent(source.id)}/sharing`, scopes)
        : element('p', `${source.name} · ${tr('granted')}`));
    }
    for (const panel of [...otherProviders.children]) {
      if (!futureIds.has(panel.id.replace('settings-accounts-', ''))) panel.remove();
    }
    const google = document.getElementById('settings-accounts-google');
    const googleSources = data.sources.some(source => source.provider === 'google');
    google.dataset.hasSources = String(googleSources);
    google.hidden = document.getElementById('settings-personal-antigravity').hidden && !googleSources;
    for (const [key, slot] of slots) {
      if (!root.contains(slot) || slot.childNodes.length) continue;
      const [provider, scope] = key.split(':');
      if (scope === 'shared' && providers.includes(provider) && provider !== 'google') continue;
      if (scope === 'personal' && ((provider === 'codex' && codex.canBind && bindingScope === 'personal')
        || (provider === 'google' && !document.getElementById('settings-personal-antigravity').hidden))) continue;
      const empty = element('p', tr('empty')); empty.className = 'settings-section-note'; slot.append(empty);
    }
    for (const node of root.querySelectorAll('[data-source-editor]')) if (expanded.has(node.dataset.sourceEditor)) node.open = true;
  }

  async function load(force = false) {
    if (inflight) {
      if (!force) return inflight;
      await inflight.catch(() => {});
    }
    if (latest && !force) return;
    inflight = (async () => { latest = await request(''); render(latest); say(''); })();
    try { await inflight; } finally { inflight = null; }
  }
  const refresh = force => void load(force).catch(error => say(error.message || tr('loadError')));
  window.remotelabModelSources = { shown() { refresh(false); } };
  window.addEventListener('remotelab:personal-codex-changed', () => refresh(true));
  window.addEventListener('remotelab:localechange', () => { if (latest) render(latest); });
  const legacy = () => {
    if (location.hash === '#settings-model-sources') window.remotelabOpenSettingsTarget?.('settings-accounts-codex');
  };
  requestAnimationFrame(legacy);
  window.addEventListener('hashchange', legacy);
})();

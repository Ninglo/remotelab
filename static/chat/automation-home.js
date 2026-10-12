/* Stable automation entry; reads durable task/run state without messaging a worker. */
(() => {
  let attached = null, generation = 0;
  const panel = document.getElementById('automationHomePanel');
  const tr = (zh, en) => String(window.remotelabGetActiveUiLanguage?.() || document.documentElement.lang).startsWith('zh') ? zh : en;
  const node = (tag, text) => { const el = document.createElement(tag); if (text != null) el.textContent = text; return el; };
  const link = (label, href) => { const el = node('a', label); el.href = href; return el; };
  const sessionLink = (id, label) => link(label, `/?session=${encodeURIComponent(id)}&tab=sessions`);
  const stamp = value => value ? new Date(value).toLocaleString() : tr('未记录', 'Not recorded');
  const labels = { established:['建立主 Session','Home established'], definition_changed:['定义调整','Definition changed'],
    state_changed:['状态变更','State changed'], state_observed:['观测到任务完成','Observed completion'], pause:['暂停后续触发','Future triggers paused'], resume:['恢复触发','Triggers resumed'],
    cancel:['停止后续触发','Future triggers stopped'], delete:['任务已删除，历史保留','Task deleted; history retained'],
    active:['启用','Active'], paused:['已暂停','Paused'], cancelled:['已停止','Stopped'], completed:['已完成','Completed'],
    running:['运行中','Running'], starting:['启动中','Starting'], queued:['排队中','Queued'], failed:['失败','Failed'],
    pending:['待触发','Pending'], delivered:['已提交','Submitted'], deleted:['已删除','Deleted'] };
  const label = value => labels[value] ? tr(...labels[value]) : value || tr('未知','Unknown');
  const disclosure = (title, parent = panel) => { const el = node('details'); el.append(node('summary', title)); parent.append(el); return el; };
  async function render(force = false) {
    if (!panel || !attached?.automationTaskId) return;
    const seq = ++generation, session = attached;
    const previousOpen = new Set([...panel.querySelectorAll('details[open]')].map(el => el.firstChild.textContent));
    try {
      const response = await fetch(`/api/automation-tasks/${encodeURIComponent(session.automationTaskId)}/home`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { home } = await response.json();
      if (seq !== generation) return;
      panel.replaceChildren(); panel.hidden = false;
      const nav = node('div'); nav.className = 'automation-home-nav';
      nav.append(link(tr('打开对应自动化任务','Open automation task'), `/?tab=tasks&monitor=automations&task=${encodeURIComponent(home.taskId)}`));
      if (session.id !== home.sessionId) nav.append(sessionLink(home.sessionId, tr('返回自动化主 Session','Back to automation home')));
      nav.append(sessionLink(home.sourceSessionId, tr('查看原始讨论','Original discussion')));
      const refresh = node('button', tr('刷新状态','Refresh status')); refresh.type = 'button'; refresh.onclick = () => render(true); nav.append(refresh);
      panel.append(nav);
      if (session.id !== home.sessionId) return;
      panel.append(node('strong', home.task?.title || home.definitions.at(-1)?.definition.title || home.taskId));
      panel.append(node('p', `${tr('任务状态','Task status')}: ${label(home.task?.state || 'deleted')} · ${tr('当前运行','Active runs')}: ${home.activeExecutions.length}`));
      panel.append(node('p', tr('暂停或停止后续触发，不代表当前运行已结束。运行完成也不等于业务已交付，请核对结果回执。', 'Stopping future triggers does not end active runs. Run completion is separate from business delivery; check the result receipt.')));
      const origin = disclosure(tr('来源与当前定义','Origin and current definition'));
      origin.append(node('p', `${tr('原创建身份','Original creator')}: ${home.author.name || home.author.identityId || tr('原记录未明确','Not recorded')} · ${stamp(home.taskCreatedAt)}`),
        node('p', `${tr('主 Session 建立','Home established')}: ${stamp(home.establishedAt)}`), node('p', home.brief));
      const latest = home.definitions.at(-1); origin.append(node('pre', latest?.definition.text || ''));
      const history = disclosure(`${tr('历次运行','Execution history')} (${home.executions.length})`);
      history.open = previousOpen.has(history.firstChild.textContent) || !force;
      for (const run of home.executions) {
        const row = node('div'); row.className = 'automation-home-row';
        row.append(node('span', `${stamp(run.scheduledAt)} · ${label(run.state)} · ${run.definitionRevision ? `v${run.definitionRevision}` : tr('旧版本未记录','Version not recorded')}`));
        if (run.sessionId) row.append(sessionLink(run.sessionId, tr('查看执行与结果','Execution and result')));
        if (run.error) row.append(node('p', run.error)); history.append(row);
      }
      const changes = disclosure(`${tr('创建、调整与停止记录','Creation, changes and stops')} (${home.events.length})`);
      for (const event of [...home.events].reverse()) {
        const row = node('p', `${stamp(event.at)} · ${label(event.type)} · ${event.actor?.name || event.actor?.identityId || tr('身份未记录','Actor not recorded')} · ${label(event.state)}${event.revision ? ` · v${event.revision}` : ''}${event.reason ? ` · ${event.reason}` : ''}`);
        changes.append(row);
      }
      const versions = disclosure(`${tr('保留的定义版本','Saved definition versions')} (${home.definitions.length})`);
      for (const version of [...home.definitions].reverse()) {
        const item = disclosure(`v${version.revision} · ${stamp(version.at)}`, versions);
        item.append(node('pre', JSON.stringify(version.definition, null, 2)));
      }
      for (const el of panel.querySelectorAll('details')) if (previousOpen.has(el.firstChild.textContent)) el.open = true;
    } catch (error) {
      if (seq !== generation) return;
      panel.replaceChildren(node('p', `${tr('自动化记录暂未读取成功','Unable to read automation records')}: ${error.message}`));
      const retry = node('button', tr('重试','Retry')); retry.type = 'button'; retry.onclick = () => render(true); panel.append(retry); panel.hidden = false;
    }
  }
  window.updateAutomationHomeSession = session => {
    if (attached?.id === session?.id && attached?.automationTaskId === session?.automationTaskId) return;
    attached = session; generation++;
    if (panel) { panel.hidden = true; panel.replaceChildren(); }
    if (session?.automationTaskId) void render();
  };
  window.refreshAutomationHome = () => render(true);
})();

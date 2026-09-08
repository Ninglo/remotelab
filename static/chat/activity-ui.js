// Transcript activity owns DOM-only disclosure state. Event history stays immutable.
function activityText(key, vars) { return t('activity.' + key, vars); }

function createActivityDisclosure(title, { kind = 'note', meta = '', open = false } = {}) {
  const card = document.createElement('details');
  card.className = `activity-card activity-${kind}`;
  card.open = open;
  const header = document.createElement('summary');
  header.className = 'activity-header';
  const icon = document.createElement('span');
  icon.className = 'activity-marker';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = { tool: '›_', file: '±', reasoning: '○', plan: '☷', note: '·', context: '↳' }[kind] || '·';
  const label = document.createElement('span');
  label.className = 'activity-title';
  label.textContent = title;
  const status = document.createElement('span');
  status.className = 'activity-meta';
  status.textContent = meta;
  header.append(icon, label, status);
  const body = document.createElement('div');
  body.className = 'activity-detail';
  card.append(header, body);
  card.addEventListener('toggle', () => {
    if (card.open) hydrateLazyNodes(body).catch(() => {});
  });
  return { card, header, body, label, status };
}

function activityPre(evt, field) {
  const pre = document.createElement('pre');
  pre.className = 'activity-code';
  pre.textContent = typeof evt?.[field] === 'string' ? evt[field] : '';
  if (evt?.bodyAvailable && !evt.bodyLoaded) {
    pre.dataset.eventSeq = String(evt.seq || '');
    pre.dataset.bodyPending = 'true';
    pre.dataset.preview = pre.textContent;
  }
  return pre;
}

function activityScope(evt) {
  return String(evt?.runId || evt?.responseId || '');
}

function findActivityTool(root, evt, { result = false } = {}) {
  if (evt.toolCallId && typeof messagesInner !== 'undefined' && messagesInner.contains(root)) root = messagesInner;
  const cards = [...(root?.querySelectorAll('.tool-card') || [])];
  const scope = activityScope(evt);
  const callId = String(evt.toolCallId || '');
  const scoped = cards.filter(card => card.dataset.scope === scope);
  if (callId) return scoped.find(card => card.dataset.callId === callId) || null;
  // Old histories discarded call IDs. Only coalesce adjacent, identical pending
  // starts (Codex's start/update/completion echo), never completed repeated commands.
  if (!result) {
    const last = scoped.at(-1);
    return last && !last._activityResult && !last.dataset.callId
      && last._activityUse.toolName === evt.toolName
      && last._activityUse.toolInput === evt.toolInput ? last : null;
  }
  return scoped.find(card => !card._activityResult && !card.dataset.callId
    && (!evt.toolName || card._activityUse.toolName === evt.toolName))
    || (String(evt.toolName || '').startsWith('toolu_')
      ? scoped.find(card => !card._activityResult && !card.dataset.callId) : null);
}

function updateActivityTool(card) {
  const use = card._activityUse;
  const result = card._activityResult;
  const failed = result && Number.isFinite(result.exitCode) && result.exitCode !== 0;
  const complete = Boolean(result) || use.toolState === 'completed';
  card.classList.toggle('is-running', !complete && !card._activitySettled);
  card.classList.toggle('is-complete', complete);
  card.classList.toggle('is-failed', Boolean(failed));
  const state = failed ? 'failed' : complete ? 'done' : card._activitySettled ? 'unconfirmed' : 'running';
  const status = card.querySelector('.activity-meta');
  status.textContent = activityText(state);
  if (failed) status.textContent += ` · ${result.exitCode}`;
  const title = card.querySelector('.activity-title');
  title.textContent = summarizeToolInput(use.toolInput) || use.toolName || t('ui.toolFallback');
  title.title = use.toolInput || '';
  card.querySelector('.activity-tool-name').textContent = use.toolName || t('ui.toolFallback');
  card.querySelector('.activity-header').title = use.toolName || t('ui.toolFallback');
  // Keep mounted input/output nodes and user selection across live updates.
  const body = card.querySelector('.activity-detail');
  let tabs = body.querySelector('.activity-tabs');
  if (!tabs) {
    tabs = document.createElement('div');
    tabs.className = 'activity-tabs';
    body.append(tabs);
  }
  let input = body.querySelector('.activity-input');
  if (!input) {
    input = activityPre(use, 'toolInput');
    input.classList.add('activity-input');
    body.append(input);
  }
  if (card._activityInputText !== use.toolInput) {
    const nextInput = activityPre(use, 'toolInput');
    input.textContent = nextInput.textContent;
    Object.assign(input.dataset, nextInput.dataset);
    card._activityInputText = use.toolInput;
  }
  let output = body.querySelector('.activity-output');
  if (result && !output) {
    output = activityPre(result, 'output');
    output.classList.add('activity-output');
    if (!output.textContent && !result.bodyAvailable) output.textContent = activityText('emptyOutput');
    body.append(output);
    card._activityTab = 'output';
  }
  if (output && card._activityOutputText !== result.output) {
    output.textContent = result.output || activityText('emptyOutput');
    Object.assign(output.dataset, activityPre(result, 'output').dataset);
    card._activityOutputText = result.output;
  }
  const select = (tab) => {
    card._activityTab = tab;
    input.hidden = tab !== 'input';
    if (output) output.hidden = tab !== 'output';
    for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    if (card.open) hydrateLazyNodes(body).catch(() => {});
  };
  tabs.replaceChildren();
  for (const tab of result ? ['output', 'input'] : ['input']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.tab = tab;
    button.textContent = activityText(tab);
    if (tab === 'input') button.title = use.toolName || t('ui.toolFallback');
    button.addEventListener('click', () => select(tab));
    tabs.append(button);
  }
  select(card._activityTab || 'input');
}

function renderActivityToolUse(container, evt, { toolTracker = null } = {}) {
  if (!container) return null;
  if (evt.toolName) toolTracker?.add(evt.toolName);
  let card = findActivityTool(container, evt);
  if (!card) {
    const disclosure = createActivityDisclosure('', { kind: 'tool' });
    card = disclosure.card;
    card.classList.add('tool-card');
    card.dataset.callId = String(evt.toolCallId || '');
    card.dataset.scope = activityScope(evt);
    const name = document.createElement('span');
    name.className = 'activity-tool-name';
    disclosure.header.insertBefore(name, disclosure.status);
    container.append(card);
  }
  card._activityUse = evt;
  updateActivityTool(card);
  return card;
}

function renderActivityToolResult(container, evt) {
  if (!container) return null;
  let card = findActivityTool(container, evt, { result: true });
  if (!card) card = renderActivityToolUse(container, { ...evt, toolInput: '' });
  card._activityResult = evt;
  updateActivityTool(card);
  return card;
}

function settleActivityTools(container) {
  for (const card of container?.querySelectorAll('.tool-card.is-running') || []) {
    card._activitySettled = true;
    updateActivityTool(card);
  }
}

function renderActivityFile(container, evt) {
  const path = String(evt.filePath || '');
  const name = path.split(/[\\/]/).pop() || path;
  const diff = typeof evt.diff === 'string' ? evt.diff : '';
  const lines = diff.split('\n');
  const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  const meta = diff ? `+${additions} −${deletions}` : formatFileChangeTypeLabel(evt.changeType || 'edit');
  const { card, body, label } = createActivityDisclosure(name, { kind: 'file', meta });
  label.title = path;
  const location = document.createElement('div');
  location.className = 'activity-path';
  location.textContent = path;
  body.append(location);
  if (diff) {
    const pre = document.createElement('pre');
    pre.className = 'activity-code activity-diff';
    for (const line of lines) {
      const row = document.createElement('span');
      row.className = line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-delete' : 'diff-context';
      row.textContent = line + '\n';
      pre.append(row);
    }
    body.append(pre);
  } else {
    const note = document.createElement('p');
    note.className = 'activity-empty';
    note.textContent = activityText('noDiff');
    body.append(note);
  }
  if (evt.changeState === 'failed') card.classList.add('is-failed');
  container.append(card);
  return card;
}

function renderActivityNote(container, evt, kind = 'note') {
  const source = evt.content || evt.bodyPreview || '';
  const title = kind === 'reasoning' ? activityText('reasoning')
    : kind === 'context' ? (evt.title || activityText('context'))
    : kind === 'plan' ? activityText('plan') : summarizeToolInput(source) || activityText('details');
  const { card, body } = createActivityDisclosure(title, { kind, meta: kind === 'context' ? String(evt.phase || '') : '' });
  const content = document.createElement('div');
  content.className = 'md-content';
  renderMarkdownIntoNode(content, source);
  markLazyEventBodyNode(content, evt, { preview: source, renderMode: 'markdown' });
  body.append(content);
  if (evt.reason && evt.reason !== source) {
    const reason = document.createElement('p');
    reason.textContent = evt.reason;
    body.append(reason);
  }
  if (/^error:/i.test(source) || evt.phase === 'failed') card.classList.add('is-failed');
  container.append(card);
  return card;
}

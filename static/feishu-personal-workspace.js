(() => {
  globalThis.__RLFE_WORKSPACE__?.cleanup();
  const base = 'https://index.jiujianian.dev', key = 'feishuWebExplore.workspaceConnection.v1';
  const live = !!globalThis.__RLFE_LIVE__, account = () => String((live ? globalThis.userId : document.documentElement.dataset.rlfeAccountId) || '');
  const scope = () => /^\d{10,30}$/.test(account()) && globalThis.__RLFE_PREFS__?.status().accountBound ? location.origin + ':' + account() : '';
  const storage = live ? { async get(k) { return { [k]: JSON.parse(localStorage.getItem(k) || 'null') }; }, async set(v) { for (const [k, data] of Object.entries(v)) localStorage.setItem(k, JSON.stringify(data)); } } : chrome.storage.local;
  let alive = true, connection, bound = '', popup, nonce = '', selected = '', epoch = 0, timer, observer, lastFocus, context, pending = {}, attempts = {}, watchingUntil = 0;
  const drafts = { index: '', thinking: '' }, views = {};
  const nav = document.createElement('nav'); nav.id = 'rlfe-personal-nav'; nav.setAttribute('aria-label', 'Index 与 thinking');
  const menu = nav.attachShadow({ mode: 'open' });
  menu.innerHTML = `<style>:host{display:block;flex:none;min-width:0;margin:0 0 4px}*{box-sizing:border-box}div{display:grid;gap:4px}button{display:flex;align-items:center;gap:10px;height:32px;padding:0 8px 0 11px;border-radius:6px;border:0;background:transparent;color:var(--rlfe-text,var(--text-title,#1f2329));font:14px/1 var(--rlfe-ui-font,system-ui),sans-serif;cursor:pointer;white-space:nowrap}button:hover,button[aria-current=page]{background:var(--rlfe-hover,var(--udtoken-bg-text-hover,#e8e9eb))}button:focus-visible{outline:2px solid var(--rlfe-accent,#3370ff);outline-offset:-2px}svg{width:20px;height:20px;flex:none}span{overflow:hidden;text-overflow:ellipsis}:host([data-compact=true]) button{height:60px;flex-direction:column;justify-content:center;gap:4px;padding:6px 0;font-size:11px}</style><div><button data-surface="index"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/></svg><span>Index</span></button><button data-surface="thinking"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 18h6m-5 3h4M8 13a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3z"/></svg><span>thinking</span></button></div>`;
  const host = document.createElement('section'); host.id = 'rlfe-personal-workspace'; host.hidden = true;
  host.setAttribute('role', 'region'); host.setAttribute('aria-label', 'Index');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{position:fixed;inset:0 0 0 80px;display:block;z-index:1000;color:var(--rlfe-text,var(--text-title,#1f2329));font:14px/1.7 var(--rlfe-ui-font,system-ui),sans-serif;background:var(--rlfe-bg,var(--bg-body,#fff));--line:var(--line-border-component,#dee0e3);--muted:var(--text-caption,#646a73);--accent:var(--rlfe-accent,#3370ff)}:host([hidden]){display:none!important}*{box-sizing:border-box}button,textarea{font:inherit}button{border:1px solid var(--line,#dee0e3);border-radius:6px;background:var(--bg-body,#fff);color:inherit;padding:6px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}a{color:var(--accent);overflow-wrap:anywhere}header{height:68px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 24px;border-bottom:1px solid var(--line,#dee0e3)}h1{font-size:20px;line-height:1.4;margin:0;font-weight:600}header small{display:block;color:var(--muted)}header .actions{display:flex;gap:6px;flex-wrap:wrap}#scroll{height:calc(100dvh - 68px);overflow:auto;overscroll-behavior:contain}#content{max-width:1200px;margin:auto;padding:24px}#notice{margin:0 0 18px;color:var(--muted);white-space:pre-wrap}#connectRow{display:flex;gap:8px;align-items:center;margin-bottom:20px}#indexView{max-width:840px;margin:auto}#conversation{display:grid;gap:20px;min-height:160px}.message{border-bottom:1px solid var(--line,#dee0e3);padding-bottom:16px;overflow-wrap:anywhere}.message .who{color:var(--muted);font-size:12px;margin-bottom:6px}.message.user{padding:14px 18px;border:0;border-radius:8px;background:var(--fill-tag,#f5f6f7)}.markdown h2{font-size:18px;margin:20px 0 8px}.markdown h3{font-size:16px;margin:16px 0 6px}.markdown p{margin:8px 0;white-space:pre-wrap}.markdown ul{padding-left:22px;margin:8px 0}.markdown li{margin:6px 0}.markdown pre{overflow:auto;white-space:pre;font:13px/1.6 ui-monospace,monospace;background:var(--fill-tag,#f5f6f7);padding:12px;border-radius:6px}textarea{width:100%;min-height:90px;max-height:220px;resize:vertical;padding:10px 12px;border:1px solid var(--line,#dee0e3);border-radius:6px;color:inherit;background:var(--bg-body,#fff)}form{margin-top:20px}.formActions{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px;flex-wrap:wrap}.formActions small{margin-right:auto;color:var(--muted)}#thinkingGrid{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:32px}.sources h2{font-size:16px;margin:0 0 8px}.sourceList{display:grid;gap:12px;margin:12px 0 28px}.sourceItem{padding-bottom:12px;border-bottom:1px solid var(--line,#dee0e3);overflow-wrap:anywhere}.sourceItem small{display:block;color:var(--muted)}.sourceItem p{margin:6px 0;white-space:pre-wrap}details summary{cursor:pointer;color:var(--muted)}.result{min-width:0}.result h2{font-size:18px;margin:0 0 8px}#nextBlock{margin-top:28px;border-top:1px solid var(--line,#dee0e3);padding-top:24px}#analysisState{color:var(--muted);margin-bottom:16px;white-space:pre-wrap}#analysisState[data-error=true]{color:var(--text-danger,#b42318)}#analysisEmpty{color:var(--muted);padding:16px 0}#thinkingView[hidden],#indexView[hidden],#connectRow[hidden]{display:none}#chatEmpty{color:var(--muted)}@media(max-width:980px){#thinkingGrid{grid-template-columns:1fr}.sources{border-bottom:1px solid var(--line,#dee0e3);padding-bottom:12px}.sourceList{margin-bottom:16px}}@media(max-width:560px){:host{inset:0}header{padding:10px 12px;height:76px}header small{font-size:11px}#scroll{height:calc(100dvh - 76px)}#content{padding:16px 12px}header button{padding:5px 8px}header .actions{gap:4px}#thinkingGrid{gap:20px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style><header><div><h1 id="title" tabindex="-1">Index</h1><small id="identity">连接本人账号后继续</small></div><div class="actions"><button id="refresh">刷新</button><button id="disconnect">断开</button><button id="close" aria-label="返回飞书">返回飞书</button></div></header><div id="scroll"><main id="content"><p id="notice" role="status" aria-live="polite"></p><div id="connectRow"><button class="primary" id="connect">连接我的账号</button><small>请在连接窗口核对本人姓名</small></div><div id="indexView"><div id="conversation"></div><form id="indexForm"><label for="indexDraft">与你的 Index 继续聊</label><textarea id="indexDraft" placeholder="讨论目标、补充背景或调整方向"></textarea><div class="formActions"><small id="chatState"></small><button class="primary" id="sendIndex" type="submit">发送</button></div></form></div><div id="thinkingView" hidden><div id="thinkingGrid"><aside class="sources"><details open><summary>分析依据</summary><h2>我的待办</h2><div id="todos" class="sourceList"></div><h2>参与项目的进展</h2><div id="projects" class="sourceList"></div><p id="report"></p></details></aside><section class="result"><div class="formActions"><small>结合已有待办与日报判断下一步</small><button id="analyze" class="primary">开始分析</button></div><p id="analysisState" role="status" aria-live="polite"></p><h2>当前重点</h2><div id="analysis" class="markdown"></div><div id="nextBlock"><h2>接着推进</h2><div id="next" class="markdown"></div><form id="thinkingForm"><label for="thinkingDraft">补充约束或继续讨论下一步</label><textarea id="thinkingDraft" placeholder="例如：今天只有两小时，先帮我缩小到一件事"></textarea><div class="formActions"><button id="discussIndex" type="button">与 Index 讨论</button><button id="continueThinking" type="submit">继续分析</button></div></form></div></section></div></div></main></div>`;
  const el = id => root.getElementById(id), say = text => { el('notice').textContent = text || ''; };
  function link(value, label) {
    if (/^todo:todo_[a-f0-9]{16}$/.test(value)) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = () => { if (selected !== 'thinking') open('thinking'); root.getElementById(value.slice(5))?.scrollIntoView({ block: 'center' }); }; return button; }
    try { const url = new URL(value, base); if (url.protocol !== 'https:' || url.username || url.password) return document.createTextNode(label); const a = document.createElement('a'); a.href = url.href; a.textContent = label; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; } catch { return document.createTextNode(label); }
  }
  function inline(parent, text) {
    const pattern = /\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g; let start = 0;
    for (const m of text.matchAll(pattern)) { parent.append(document.createTextNode(text.slice(start, m.index))); if (m[1]) parent.append(link(m[2], m[1])); else { const node = document.createElement(m[3] ? 'strong' : 'code'); node.textContent = m[3] || m[4]; parent.append(node); } start = m.index + m[0].length; } parent.append(document.createTextNode(text.slice(start)));
  }
  function markdown(node, source) {
    node.replaceChildren(); let list, code;
    const text = String(source || '').replace(/<(private|hide)>[\s\S]*?<\/\1>/gi, '').replace(/<\/?(?:progress|reply)>/g, '');
    for (const line of text.split('\n')) {
      if (/^```/.test(line)) { if (code) code = null; else { code = document.createElement('pre'); node.append(code); } list = null; continue; }
      if (code) { code.textContent += line + '\n'; continue; }
      if (!line.trim()) { list = null; continue; }
      const h = /^(#{1,4})\s+(.+)$/.exec(line), li = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
      if (li) { if (!list) { list = document.createElement('ul'); node.append(list); } const item = document.createElement('li'); inline(item, li[1]); list.append(item); }
      else { list = null; const p = document.createElement(h ? (h[1].length <= 2 ? 'h2' : 'h3') : 'p'); inline(p, h ? h[2] : line); node.append(p); }
    }
  }
  async function savedConnection() {
    const identity = scope(); if (!identity) throw Error('正在确认当前飞书账号，请稍后刷新。');
    if (connection && bound === identity) return;
    const item = (await storage.get(key + ':' + encodeURIComponent(identity)))[key + ':' + encodeURIComponent(identity)];
    if (identity !== scope()) throw Error('账号已切换，请重新打开。'); bound = identity;
    connection = /^fwspace_[a-zA-Z0-9_-]{43}$/.test(item?.token || '') && item.expiresAt > Date.now() ? item : null;
  }
  async function request(operation, body, requestId = '') {
    await savedConnection(); if (!connection) throw Object.assign(Error('请先连接本人的账号。'), { status: 401 });
    const ticket = connection, identity = bound, nativeAccount = account(); let result;
    if (!live) result = await chrome.runtime.sendMessage({ type: 'rlfe:personal-workspace-request', operation, token: ticket.token, account: nativeAccount, body, requestId });
    else {
      const routes = { context: ['GET', 'context'], index: ['GET', 'index'], thinking: ['GET', 'thinking'], sendIndex: ['POST', 'index'], analyze: ['POST', 'thinking'], disconnect: ['DELETE', 'connection'] }, route = routes[operation];
      const response = await fetch(base + '/api/feishu-web-workspace/' + route[1] + (requestId ? '?requestId=' + encodeURIComponent(requestId) : ''), {
        method: route[0], credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + ticket.token, 'Content-Type': 'application/json', 'X-Feishu-Origin': location.origin, 'X-Feishu-Account': nativeAccount }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      result = { ok: response.ok, status: response.status, data: await response.json() };
    }
    if (!alive || identity !== scope() || ticket !== connection) throw Error('账号已切换，旧结果已丢弃。');
    if (!result?.ok) { if (result?.status === 401) connection = null; throw Object.assign(Error(result?.data?.error || '连接暂时不可用，请刷新核对结果。'), { status: result?.status }); }
    return result.data;
  }
  function connectionState() { el('connectRow').hidden = !!connection; el('disconnect').hidden = !connection; el('identity').textContent = connection ? connection.person.name : '连接本人账号后继续'; }
  function sources(data) {
    context = data; el('todos').replaceChildren(); el('projects').replaceChildren();
    const status = { todo: '待办', in_progress: '进行中', blocked: '受阻', done: '已完成' };
    for (const todo of data.todos || []) {
      const item = document.createElement('div'); item.className = 'sourceItem'; item.id = todo.id; const title = document.createElement('strong'); title.textContent = todo.title; item.append(title);
      const meta = document.createElement('small'); meta.textContent = [status[todo.status] || todo.status, todo.dueAt ? '截止 ' + new Date(todo.dueAt).toLocaleString('zh-CN') : '', todo.progress ? `${todo.progress.current}/${todo.progress.target} ${todo.progress.unit || ''}` : ''].filter(Boolean).join(' · '); item.append(meta);
      if (todo.note) { const p = document.createElement('p'); p.textContent = todo.note; item.append(p); } el('todos').append(item);
      if (todo.url && !todo.url.startsWith('todo:')) item.append(link(todo.url, '查看来源工作'));
    }
    if (!data.todos?.length) el('todos').textContent = data.errors?.todos || '当前没有个人待办。';
    for (const project of data.projects || []) {
      const item = document.createElement('div'); item.className = 'sourceItem'; const title = document.createElement('strong'); title.textContent = project.name; item.append(title);
      const meta = document.createElement('small'); meta.textContent = `${project.date} 日报${project.status === 'paused' ? ' · 已暂停' : ''} · ${project.association.reason}`; item.append(meta);
      const details = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('div'); summary.textContent = project.sourceTitle || '日报中暂无对应章节'; body.className = 'markdown'; markdown(body, project.excerpt); details.append(summary, body); item.append(details);
      if (project.url) item.append(link(project.url, '查看原日报')); item.append(document.createTextNode(' · '), link('/?session=' + project.association.sessionId, '相关工作')); el('projects').append(item);
    }
    if (!data.projects?.length) el('projects').textContent = data.errors?.projects || '尚无明确参与记录。';
    el('report').replaceChildren(); if (data.report) { el('report').append(document.createTextNode('来源：' + data.report.date + (data.report.stale ? '（不是今日日报）' : '') + ' ')); if (data.report.url) el('report').append(link(data.report.url, '原日报')); }
    if (data.errors?.todos || data.errors?.projects) say(Object.values(data.errors).join('\n')); else say('');
  }
  function renderView(surface, data) {
    views[surface] = data;
    const state = data.activity, running = state && !['completed', 'failed', 'cancelled'].includes(state.state);
    const error = state?.error || (state?.state === 'cancelled' ? '执行已取消，可调整后再开始。' : '');
    if (surface === 'index') {
      const box = el('conversation'); box.replaceChildren();
      for (const message of data.messages || []) { const article = document.createElement('article'); article.className = 'message ' + message.role; const who = document.createElement('div'); who.className = 'who'; who.textContent = message.role === 'user' ? '你' : 'Index'; const body = document.createElement('div'); body.className = 'markdown'; markdown(body, message.content); article.append(who, body); box.append(article); }
      if (!data.messages?.length) { const p = document.createElement('p'); p.id = 'chatEmpty'; p.textContent = '这里会保留你与 Index 的持续对话。'; box.append(p); }
      if (data.latest?.content && !(data.messages || []).some(m => m.role === 'assistant' && m.content === data.latest.content)) { const article = document.createElement('article'); article.className = 'message assistant markdown'; markdown(article, data.latest.content); box.append(article); }
      if (data.session?.url) box.append(link(data.session.url, '查看完整对话与附件'));
      el('chatState').textContent = error || (running ? 'Index 正在回复' : ''); el('sendIndex').disabled = !!running;
    } else {
      const content = state?.final || data.latest?.content || '', parts = content.split(/^##\s*接着推进\s*$/m);
      markdown(el('analysis'), parts[0].replace(/^##\s*当前重点\s*\n?/m, '') || '点击“开始分析”，查看当前重点与理由。');
      markdown(el('next'), parts.slice(1).join('\n') || (content ? '可在下面补充约束，继续讨论下一步。' : '分析后，这里会给出下一步和需要你决定的事项。'));
      el('analysisState').textContent = error || (running ? '正在结合你的待办与日报分析。可以离开页面，稍后回来查看。' : (state?.state === 'completed' ? '分析已完成' : ''));
      if (data.session?.url) el('analysisState').append(document.createTextNode(' '), link(data.session.url, '查看分析对话'));
      el('analysisState').dataset.error = String(!!error); el('analyze').disabled = !!running; el('continueThinking').disabled = !!running; el('discussIndex').disabled = !content;
    }
    return running;
  }
  function stopWatch() { clearTimeout(timer); watchingUntil = 0; }
  function watch(surface, serial, delay = 250) {
    if (!watchingUntil) watchingUntil = Date.now() + 30 * 60 * 1000;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!alive || host.hidden || selected !== surface || serial !== epoch || bound !== scope()) return;
      try { const data = await request(surface, undefined, pending[surface]); if (serial !== epoch) return; const running = renderView(surface, data); if (running && Date.now() < watchingUntil) watch(surface, serial, Math.min(delay * 2, 2000)); else { stopWatch(); if (running) say('执行仍未结束，点击刷新查看最新结果。'); } }
      catch (e) { stopWatch(); say(e.message); connectionState(); }
    }, delay);
  }
  async function load(surface) {
    const serial = ++epoch; stopWatch(); say('正在读取本人的对话与来源。');
    try {
      await savedConnection(); connectionState(); if (!connection) { say('连接账号后，Index 与 thinking 将读取你自己的内容。'); return; }
      const responses = await Promise.all([request(surface, undefined, pending[surface]), ...(surface === 'thinking' ? [request('context')] : [])]);
      if (serial !== epoch || host.hidden) return; if (surface === 'thinking') sources(responses[1]); else say('');
      if (renderView(surface, responses[0])) watch(surface, serial);
    } catch (e) { if (serial === epoch) { say(e.message); connectionState(); } }
  }
  function position() { const navbar = document.querySelector('.appNavbar-navbarMenu'); if (navbar) { nav.dataset.compact = String(navbar.getBoundingClientRect().width < 128); host.style.left = innerWidth <= 560 ? '0' : Math.max(0, document.querySelector('.appNavbar')?.getBoundingClientRect().right || navbar.getBoundingClientRect().right) + 'px'; } }
  function mount() { if (!alive) return; const navbar = document.querySelector('.appNavbar-navbarMenu'); if (navbar && nav.parentNode !== navbar) navbar.insertBefore(nav, document.getElementById('rlfe-resource-nav-host')); if (!host.isConnected) document.body.append(host); position(); }
  function close() { if (selected) drafts[selected] = el(selected + 'Draft').value; ++epoch; stopWatch(); host.hidden = true; selected = ''; menu.querySelectorAll('button').forEach(b => b.removeAttribute('aria-current')); lastFocus?.focus(); }
  function open(surface) { if (!['index', 'thinking'].includes(surface)) return; if (selected) drafts[selected] = el(selected + 'Draft').value; if (host.hidden) lastFocus = document.activeElement; selected = surface; host.hidden = false; host.setAttribute('aria-label', surface === 'index' ? 'Index' : 'thinking'); el('title').textContent = surface === 'index' ? 'Index' : 'thinking'; el('indexView').hidden = surface !== 'index'; el('thinkingView').hidden = surface !== 'thinking'; el(surface + 'Draft').value = drafts[surface]; menu.querySelectorAll('button').forEach(b => b.setAttribute('aria-current', b.dataset.surface === surface ? 'page' : 'false')); position(); el('title').focus(); void load(surface); }
  async function send(surface, text) {
    if (!connection) { say('请先连接本人的账号。'); return; }
    const serial = epoch, operation = surface === 'index' ? 'sendIndex' : 'analyze', button = el(surface === 'index' ? 'sendIndex' : 'analyze'); button.disabled = true; el('continueThinking').disabled = true;
    // Retain the exact request after uncertainty. Refresh reads it; an explicit
    // retry of unchanged text uses the same durable admission key.
    const previous = attempts[surface]; const requestId = previous?.text === text && !previous.accepted ? previous.id : crypto.randomUUID(); attempts[surface] = { id: requestId, text, accepted: false }; pending[surface] = requestId;
    say('正在提交。');
    if (surface === 'thinking') el('analysisState').textContent = '正在提交分析请求。'; else el('chatState').textContent = '正在发送。';
    try { await request(operation, { requestId, text }); attempts[surface].accepted = true; if (serial !== epoch || selected !== surface) return; drafts[surface] = ''; el(surface + 'Draft').value = ''; await load(surface); }
    catch (e) { if (serial === epoch) { say(e.message + (e.status ? '' : ' 点击刷新核对这次执行；重试相同内容会复用原请求。')); button.disabled = false; el('continueThinking').disabled = false; connectionState(); } }
  }
  el('indexForm').onsubmit = e => { e.preventDefault(); const text = el('indexDraft').value.trim(); if (text) void send('index', text); };
  el('thinkingForm').onsubmit = e => { e.preventDefault(); const text = el('thinkingDraft').value.trim(); if (text) void send('thinking', text); };
  el('analyze').onclick = () => void send('thinking', el('thinkingDraft').value.trim());
  el('discussIndex').onclick = () => { const view = views.thinking, result = view?.activity?.final || view?.latest?.content || ''; drafts.index = '继续讨论这份工作重点分析：\n\n' + result.slice(0, 7000); open('index'); };
  el('refresh').onclick = () => void load(selected); el('close').onclick = close;
  el('connect').onclick = () => { if (!scope()) { say('正在确认飞书账号，请稍后刷新。'); return; } nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join(''); popup = window.open(base + '/page/feishu-web-workspace/connect?origin=' + encodeURIComponent(location.origin) + '&account=' + account() + '&state=' + nonce, 'rlfe-workspace-connect', 'popup,width=520,height=600'); if (!popup) say('请允许打开连接窗口后重试。'); };
  el('disconnect').onclick = async () => { try { await request('disconnect'); const identity = bound; await storage.set({ [key + ':' + encodeURIComponent(identity)]: null }); connection = null; context = null; pending = {}; attempts = {}; Object.keys(views).forEach(k => delete views[k]); drafts.index = drafts.thinking = ''; clearContent(); connectionState(); stopWatch(); say('已断开当前账号。'); } catch (e) { say(e.message); } };
  function clearContent() { for (const id of ['conversation', 'todos', 'projects', 'analysis', 'next', 'report', 'chatState', 'analysisState']) el(id).replaceChildren(); el('indexDraft').value = el('thinkingDraft').value = ''; }
  const connected = async event => {
    const data = event.data;
    if (!alive || event.origin !== base || event.source !== popup || data?.type !== 'remotelab:feishu-workspace-connected' || data.state !== nonce || data.origin !== location.origin || data.nativeAccount !== account() || !scope() || !/^fwspace_[a-zA-Z0-9_-]{43}$/.test(data.token || '')) return;
    const identity = scope(); nonce = ''; await storage.set({ [key + ':' + encodeURIComponent(identity)]: data }); if (identity !== scope()) return; connection = data; bound = identity; if (selected) await load(selected);
  };
  const accountChanged = () => { if (bound && bound !== scope()) { ++epoch; stopWatch(); connection = null; bound = ''; nonce = ''; popup = null; context = null; pending = {}; attempts = {}; drafts.index = drafts.thinking = ''; Object.keys(views).forEach(k => delete views[k]); clearContent(); connectionState(); if (!host.hidden) say('账号已切换，请连接当前本人的账号。'); } };
  const escape = e => { if (e.key === 'Escape' && !host.hidden) { e.preventDefault(); close(); } };
  const nativeNavigate = e => { if (!host.hidden && e.target.closest?.('.appNavbar') && !e.composedPath().includes(nav)) close(); };
  menu.querySelectorAll('button').forEach(b => b.onclick = () => open(b.dataset.surface));
  window.addEventListener('message', connected); window.addEventListener('rlfe:preferences', accountChanged); window.addEventListener('resize', position); document.addEventListener('keydown', escape); document.addEventListener('click', nativeNavigate);
  observer = new MutationObserver(records => { if (records.some(r => !host.contains(r.target) && !nav.contains(r.target))) mount(); }); observer.observe(document.body, { childList: true, subtree: true }); mount();
  globalThis.__RLFE_WORKSPACE__ = { open, status: () => ({ surface: selected, visible: !host.hidden, connected: !!connection, accountBound: !!scope(), entries: [...menu.querySelectorAll('span')].map(n => n.textContent), sessionId: views[selected]?.session?.id || '', hasAnalysis: !!views.thinking?.latest, left: host.style.left }), cleanup() { alive = false; ++epoch; stopWatch(); observer.disconnect(); window.removeEventListener('message', connected); window.removeEventListener('rlfe:preferences', accountChanged); window.removeEventListener('resize', position); document.removeEventListener('keydown', escape); document.removeEventListener('click', nativeNavigate); nav.remove(); host.remove(); delete globalThis.__RLFE_WORKSPACE__; } };
})();

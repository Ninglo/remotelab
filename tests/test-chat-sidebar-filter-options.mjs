#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const functionSources = [
  'isSidebarFilterControlVisible',
  'normalizeSourceId',
  'normalizeSourceFilter',
  'getSourceFilterDefinitions',
  'getSourceFilterValues',
  'formatSourceNameFromId',
  'getEffectiveSessionSourceId',
  'sourceIdMatchesFilterRule',
  'getSessionSourceCategory',
  'getVisibleSourceFilterOptions',
  'syncSidebarFiltersVisibility',
  'renderSourceFilterOptions',
].map((name) => extractFunctionSource(bootstrapSource, name)).join('\n\n');

function createSelect(display = '') {
  let innerHTML = '';
  const select = {
    hidden: false,
    style: { display },
    value: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
  Object.defineProperty(select, 'innerHTML', {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      this.children = [];
      this.value = '';
    },
  });
  return select;
}

function getOptionValues(select) {
  return select.children.map((child) => child.value);
}

function createHarness({
  sourceCounts = {},
  activeSourceFilter = '__all__',
} = {}) {
  const state = {
    toggles: [],
    persistedSource: [],
  };
  const context = {
    console,
    t(key) {
      return key;
    },
    FILTER_ALL_VALUE: '__all__',
    SOURCE_FILTER_CHAT_VALUE: 'chat_ui',
    SOURCE_FILTER_FEISHU_VALUE: 'feishu',
    SOURCE_FILTER_EMAIL_VALUE: 'email',
    SOURCE_FILTER_BOT_VALUE: 'bot',
    SOURCE_FILTER_AUTOMATION_VALUE: 'automation',
    SOURCE_FILTER_DEFINITIONS: [
      ['chat_ui', 'sidebar.filter.source.chat'],
      ['feishu', 'sidebar.filter.source.feishu'],
      ['email', 'sidebar.filter.source.email'],
      ['bot', 'sidebar.filter.source.bots'],
      ['automation', 'sidebar.filter.source.automation'],
    ],
    SOURCE_FILTER_SOURCE_ID_RULES: [
      { category: 'automation', exact: ['automation'], prefixes: ['automation'] },
      { category: 'email', exact: ['email', 'mail', 'gmail', 'feishu-mail', 'lark-mail'], prefixes: ['email', 'mail', 'gmail', 'feishu-mail', 'lark-mail'] },
      { category: 'feishu', exact: ['feishu', 'lark'], prefixes: ['feishu-bot', 'lark-bot'] },
    ],
    DEFAULT_APP_ID: 'chat',
    DEFAULT_APP_NAME: 'Chat',
    visitorMode: false,
    activeTab: 'sessions',
    activeSourceFilter,
    accountFilterSelect: createSelect('none'),
    sourceFilterSelect: createSelect(''),
    sidebarFilters: {
      classList: {
        toggle(className, force) {
          state.toggles.push({ className, force });
        },
      },
    },
    document: {
      createElement(tagName) {
        return {
          tagName,
          hidden: false,
          style: {},
          value: '',
          textContent: '',
        };
      },
    },
    getSessionCountForSourceFilter(value) {
      return sourceCounts[value] ?? 0;
    },
    persistActiveSourceFilter(value) {
      state.persistedSource.push(value);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${functionSources}\nObject.assign(globalThis, { renderSourceFilterOptions, syncSidebarFiltersVisibility });`,
    context,
    { filename: 'static/chat/bootstrap-session-catalog.js' },
  );
  return { context, state };
}

{
  const { context, state } = createHarness({
    sourceCounts: {
      __all__: 4,
      chat_ui: 4,
      bot: 0,
      automation: 0,
    },
    activeSourceFilter: 'bot',
  });
  context.renderSourceFilterOptions();
  assert.equal(context.sourceFilterSelect.style.display, 'none', 'source filter should hide when only one origin has matching sessions');
  assert.equal(context.activeSourceFilter, '__all__', 'source filter should reset stale hidden selections back to all');
  assert.deepEqual(state.persistedSource, ['__all__'], 'source filter should persist the reset when the previous origin is no longer available');
}

{
  const { context } = createHarness({
    sourceCounts: {
      __all__: 9,
      chat_ui: 3,
      feishu: 2,
      email: 1,
      bot: 2,
      automation: 1,
    },
  });
  context.renderSourceFilterOptions();
  assert.equal(context.sourceFilterSelect.style.display, '', 'source filter should stay visible when multiple origins have sessions');
  assert.deepEqual(
    getOptionValues(context.sourceFilterSelect),
    ['__all__', 'chat_ui', 'feishu', 'email', 'bot', 'automation'],
    'source filter should render all visible origin options',
  );
}

{
  const { context } = createHarness();
  assert.equal(context.normalizeSourceFilter('feishu'), 'feishu', 'Feishu should be a first-class origin filter');
  assert.equal(context.normalizeSourceFilter('email'), 'email', 'Email should be a first-class origin filter');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'chat' }), 'chat_ui');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'feishu' }), 'feishu');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'lark' }), 'feishu');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'feishu-mail' }), 'email', 'Feishu Mail audit sessions should not be hidden in the Feishu bot origin');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'gmail' }), 'email');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'automation-contract-audit' }), 'automation');
  assert.equal(context.getSessionSourceCategory({ sourceId: 'wechat' }), 'bot');
}

console.log('test-chat-sidebar-filter-options: ok');

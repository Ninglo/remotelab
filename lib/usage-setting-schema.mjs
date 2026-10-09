// Only product choices belong in analytics. Never copy arbitrary settings,
// credentials, custom terms, imported theme JSON or group/person labels.
const choice = (title, scope, values, defaultValue) => ({ title, scope, values, defaultValue });
const toggle = { on: ['开启', 'On'], off: ['关闭', 'Off'] };
export const USAGE_SETTINGS = {
  'web.theme': choice(['工作台主题', 'Workbench theme'], 'browser', {
    system: ['跟随系统', 'Follow system'], light: ['浅色', 'Light'], dark: ['深色', 'Dark'], amber: ['Amber 暖色', 'Amber'],
  }, 'system'),
  'web.thinking': choice(['Web 过程默认展示', 'Web process display'], 'browser', {
    expanded: ['默认展开', 'Expanded'], collapsed: ['默认折叠', 'Collapsed'],
  }, 'collapsed'),
  'web.language': choice(['界面语言', 'Interface language'], 'browser', {
    auto: ['自动', 'Automatic'], 'zh-CN': ['中文', 'Chinese'], en: ['英文', 'English'],
  }, 'auto'),
  'reply.mode': choice(['群消息回复机制', 'Group reply mechanism'], 'group', {
    default: ['实例默认', 'Instance default'], custom: ['自定义', 'Custom'],
  }, 'default'),
  'reply.opening': choice(['首条文字回复', 'Opening reply'], 'group', { ...toggle, inherit: ['沿用默认', 'Inherit default'] }, 'inherit'),
  'reply.checklist': choice(['按需任务清单', 'Optional task checklist'], 'group', { ...toggle, inherit: ['沿用默认', 'Inherit default'] }, 'inherit'),
  'reply.progress': choice(['群过程进展方式', 'Group progress delivery'], 'group', {
    none: ['不发进展', 'No progress'], messages: ['卡片＋新消息', 'Card and messages'],
    card_latest: ['只显示最新进展', 'Latest progress only'], card_all: ['显示全部进展', 'All progress'],
    card: ['原折叠进展卡', 'Legacy folded card'], text_messages: ['原文字进展', 'Legacy text progress'],
    inherit: ['沿用默认', 'Inherit default'],
  }, 'inherit'),
  'instance.auto_archive': choice(['会话自动归档', 'Session auto archive'], 'instance', toggle, 'off'),
  'instance.archive_hours': choice(['自动归档等待时间', 'Auto archive inactivity'], 'instance', {
    12: ['12 小时', '12 hours'], 24: ['24 小时', '24 hours'], 72: ['3 天', '3 days'], 168: ['7 天', '7 days'],
  }, '24'),
  'voice.review': choice(['个人语音整理', 'Personal voice review'], 'person', toggle, 'off'),
  'voice.review_mode': choice(['语音整理方式', 'Voice review mode'], 'person', { asr: ['只纠正识别', 'ASR corrections'], model: ['模型整理', 'Model editing'] }, 'asr'),
  'voice.review_style': choice(['语音整理力度', 'Voice editing style'], 'person', { proofread: ['轻量校对', 'Proofread'], clarify: ['整理表达', 'Clarify'] }, 'proofread'),
  'person.session_filter': choice(['默认会话范围', 'Default conversation filter'], 'person', { all: ['全部', 'All'], mine: ['我的', 'Mine'] }, 'all'),
  'person.mobile_input': choice(['手机默认输入', 'Mobile input mode'], 'person', { text: ['文字', 'Text'], voice: ['语音', 'Voice'] }, 'text'),
  'person.voice_shortcut': choice(['语音快捷键', 'Voice shortcut'], 'person', toggle, 'off'),
  'display.theme': choice(['副屏主题', 'Secondary display theme'], 'display', Object.fromEntries(
    ['classic', 'paper', 'mist', 'midnight', 'rose', 'sky', 'sun', 'mint'].map(value => [value, [value, value]])), 'classic'),
};

export function validUsageSetting(setting, value) {
  return Object.hasOwn(USAGE_SETTINGS, setting || '') && typeof value === 'string'
    && Object.hasOwn(USAGE_SETTINGS[setting].values, value);
}

export function validSettingObservation(row) {
  const spec = USAGE_SETTINGS[row?.setting];
  return validUsageSetting(row?.setting, row?.value) && ['applied', 'draft', 'preview'].includes(row.stage)
    && (row.scope === spec.scope || (row.stage === 'draft' && row.scope === 'instance' && row.setting.startsWith('reply.')))
    && ['server', 'browser'].includes(row.authority)
    && (row.scope === 'browser' ? row.authority === 'browser' : row.authority === 'server')
    && /^[a-f0-9]{64}$/.test(row.scopeKey || '');
}

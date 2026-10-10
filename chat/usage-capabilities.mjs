// Fixed product actions, rather than shell arguments or tool output text.
export const CAPABILITIES = {
  search: ['资料检索', 'Research search'], documents: ['飞书文档', 'Feishu documents'],
  tables: ['飞书表格', 'Feishu tables'], tasks: ['任务管理', 'Task management'],
  calendar: ['日历与提醒', 'Calendar and reminders'], mail: ['邮件', 'Mail'],
  recording: ['录音处理', 'Recording'], knowledge: ['知识读取与维护', 'Knowledge'],
  automation: ['自动化配置', 'Automation configuration'], publishing: ['网页发布与预览', 'Publishing and previews'],
  devices: ['本地设备连接', 'Local devices'], delegation: ['会话分工', 'Session delegation'],
  connectors: ['连接器调用', 'Connector calls'], images: ['图像生成', 'Image generation'],
  project_context: ['开工上下文查询', 'Work context lookup'],
  work_routing: ['工作分流', 'Work routing'],
  response_progress: ['任务清单与进展更新', 'Task checklist and progress updates'],
  feedback: ['网页反馈保存', 'Web feedback saved'],
};
export function nativeCapability(tool) {
  return ({ web_search: 'search', web__run: 'search', qianyan_search: 'search', qianyan_read: 'search',
    image_gen: 'images', image_gen__imagegen: 'images' })[tool] || '';
}
export function commandCapability(command, args = []) {
  if (!args.length || args.some(arg => ['--help', '-h', '--guide', '--dry-run'].includes(arg))) return null;
  const action = args[0];
  if (command === 'work' && ['context', 'route'].includes(action)) return {
    feature: action === 'context' ? 'project_context' : 'work_routing', operation: 'work.' + action,
  };
  if (command === 'workboard' && action === 'update') return { feature: 'response_progress', operation: 'workboard.update' };
  if (command === 'assistant-message' && (args.includes('--workboard-file')
    || args.includes('--source') && args[args.indexOf('--source') + 1] === 'workboard_checklist')) return { feature: 'response_progress', operation: 'workboard.publish' };
  const allowed = {
    memory: ['context', 'apply'], recording: ['start', 'stop', 'toggle', 'retry'],
    todo: ['list', 'get', 'create', 'update', 'complete', 'delete'],
    agenda: ['list', 'get', 'create', 'update', 'delete'],
    trigger: ['create', 'cancel', 'delete'], schedule: ['create', 'update', 'cancel', 'pause', 'resume', 'delete'],
    preview: ['expose', 'unexpose'], publish: ['static'],
    gmail: ['read', 'search', 'send', 'reply', 'archive', 'mark-read', 'mark-unread', 'label'], mail: ['send', 'approve', 'queue', 'ingest'],
    'local-bridge': ['pair-code', 'bootstrap', 'list', 'find', 'stat', 'read-text', 'stage', 'pack'], connector: ['call'],
  };
  command = ({ triggers: 'trigger', schedules: 'schedule', email: 'mail', connectors: 'connector', 'spawn-session': 'session-spawn' })[command] || command;
  if (command === 'session-spawn' && args.some(arg => ['--task', '--task-file'].includes(arg))) return { feature: 'delegation', operation: 'delegate' };
  if (command === 'feishu') {
    const actions = { 'contact.get': 'connectors', 'message.send': 'connectors', 'message.get': 'connectors',
      'card.send': 'connectors', 'reaction.add': 'connectors', 'reaction.list': 'connectors',
      'calendar.list': 'calendar', 'calendar.get': 'calendar', 'calendar.create': 'calendar',
      'task.list': 'tasks', 'task.get': 'tasks', 'task.create': 'tasks', 'base.records': 'tables', 'base.upsert': 'tables' };
    return actions[action] ? { feature: actions[action], operation: action } : null;
  }
  if (!allowed[command]?.includes(action)) return null;
  const feature = ({ memory: 'knowledge', recording: 'recording', todo: 'tasks', agenda: 'calendar',
    trigger: 'automation', schedule: 'automation', preview: 'publishing', publish: 'publishing',
    gmail: 'mail', mail: 'mail', 'local-bridge': 'devices', connector: 'connectors' })[command];
  return { feature, operation: command + '.' + action };
}

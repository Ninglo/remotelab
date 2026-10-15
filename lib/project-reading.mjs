// Shared by cards, discovery and the existing inspection planner.
export const READING_LEVELS = ['focused', 'overview', 'paused', 'excluded'];
export function readingLevel(config, group) {
  if (group?.projectIds?.length && group.projectIds.every(id => config.projects.find(p => p.id === id)?.status === 'paused')) return 'paused';
  return group?.readingLevel || (group ? 'focused' : config.readingPolicy?.defaultLevel || 'excluded');
}
export function projectTrail(config, id) {
  const path = [], seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const project = config.projects.find(p => p.id === id);
    if (!project) break;
    path.unshift(project.name || project.id); id = project.parentId;
  }
  return path.join(' → ');
}
export function groupReadingView(config, chatId, route) {
  const group = config.groups.find(g => g.chatId === chatId && g.sourceRouteId === route);
  const level = !group && config.readingPolicy?.sourceRouteId !== route ? 'excluded' : readingLevel(config, group);
  const labels = { focused: '重点观测', overview: '一般了解', paused: '暂停读取', excluded: '不纳入定时读取' };
  const methods = { focused: '深入读取相关话题与资料，支撑项目认知和日报分析。',
    overview: '限量扫读新增主线，不展开话题或附件；不作为项目分析信源。',
    paused: '保留已有资料，不自动恢复扫描。', excluded: '保留本群协作设置，不进入夜间扫描。' };
  return { level, label: labels[level], method: methods[level], reason: group?.readingReason || '',
    projectPath: group?.projectIds?.map(id => projectTrail(config, id)).filter(Boolean).join('；') || '待明确',
    registered: Boolean(group) };
}

export function reconcileReadingGroups(config, chats, route, tenant) {
  const result = structuredClone(config), changes = [];
  if (!config.readingPolicy?.autoDiscover || config.readingPolicy.sourceRouteId !== route
      || config.readingPolicy.tenantKey !== tenant) throw new Error('Group discovery is not enabled for this route/tenant');
  for (const chat of chats) {
    if (!chat.chat_id || chat.chat_mode === 'p2p') continue;
    let group = result.groups.find(g => g.chatId === chat.chat_id && g.sourceRouteId === route);
    // Only the configured tenant is admitted; unknown and external tenants remain excluded.
    const nameExcluded = (config.readingPolicy.excludeNamePrefixes || []).some(prefix => String(chat.name || '').startsWith(prefix));
    const excluded = chat.external || chat.tenant_key !== tenant || chat.chat_status !== 'normal' || nameExcluded;
    if (!group) {
      group = { sourceRouteId: route, chatId: chat.chat_id, projectIds: [],
        readingLevel: excluded ? 'excluded' : config.readingPolicy.defaultLevel,
        readingReason: excluded ? '外部、租户未核、已解散或明确排除用途，不自动接入' : '新发现群先一般了解，项目归属待明确',
        discoveredAt: new Date().toISOString() };
      result.groups.push(group); changes.push(chat.chat_id);
    }
    group.chatName = chat.name || group.chatName || '';
    group.chatMode = chat.chat_mode || group.chatMode;
    group.tenantKey = chat.tenant_key || group.tenantKey;
    // Never restore an excluded/paused record based on membership or name changes.
    if (chat.chat_status !== 'normal' && !['excluded', 'paused'].includes(readingLevel(result, group))) {
      group.readingLevel = 'excluded'; group.readingReason = '群已解散'; changes.push(chat.chat_id);
    }
  }
  return { config: result, changes: [...new Set(changes)] };
}

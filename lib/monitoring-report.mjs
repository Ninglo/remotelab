const cell = value => String(value ?? '—').replace(/\|/g, '／').replace(/[\r\n]+/g, ' ');
const number = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知';
const bytes = value => typeof value === 'number' ? `${(value / 1024 ** 3).toFixed(2)} GiB` : '未知';
const time = value => Number.isFinite(Date.parse(value || '')) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知';
const table = (fields, rows) => `| ${fields.join(' | ')} |\n| ${fields.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n')}`;

export function renderMonitoringReport(snapshot) {
  const totals = snapshot.usage?.totals;
  const risks = snapshot.attention.map(item => [item.subject, item.severity === 'critical' ? '紧急' : '需关注',
    item.kind === 'disk' ? `可用 ${bytes(item.availableBytes)}；已用 ${item.usedPercent.toFixed(1)}%${Number.isFinite(item.inodeUsedPercent) ? `；inode ${item.inodeUsedPercent.toFixed(1)}%` : ''}`
      : item.kind === 'quota' ? `额度耗尽；另有 ${item.availableAccounts} 个可用账号`
        : item.kind === 'lowQuota' ? '额度窗口剩余不超过10%' : item.detail || '核对原执行或服务回执']);
  const capacity = snapshot.opportunities.flatMap(item => item.accounts || []);
  const recentRequests = (snapshot.automaticRequests || []).filter(item => Date.parse(item.completedAt) >= Date.parse(snapshot.usage?.window?.start || snapshot.generatedAt));
  const sections = [`## 资源与运行\n\n本轮读取：${time(snapshot.generatedAt)}（北京时间）。${risks.length ? `有 ${risks.length} 项需要关注。` : '已核验范围内未发现资源或运行问题。'}\n\n监管持续记录；日常状态随本日报发布，紧急问题单独提醒。`];
  if (risks.length) sections.push(table(['对象', '状态', '需要处理'], risks));
  if (snapshot.apiHealth) {
    sections.push(table(['飞书 API', '当前状态', '已观察调用／失败', '最近实际调用'], snapshot.apiHealth.providers.map(item =>
      [item.label, item.detail, `24h窗口 ${item.calls24h}／${item.failed24h}；5分钟 ${item.calls5m}／${item.failed5m}`, time(item.lastObservedAt)])));
    sections.push(`**飞书调用覆盖：**${snapshot.apiHealth.coverage.detail}。企业真实剩余额度：${snapshot.apiHealth.tenantQuota
      ? `${snapshot.apiHealth.tenantQuota.limit - snapshot.apiHealth.tenantQuota.used}，已用 ${snapshot.apiHealth.tenantQuota.usedPercent.toFixed(1)}%` : '未知，未取得新鲜管理员读数'}。`);
    const componentName = value => ({ connector: '聊天与评论', workboard: '进展卡片', display: '副屏飞书提醒' }[value] || value);
    const components = snapshot.apiHealth.providers.flatMap(item => (item.components || []).map(component =>
      [item.label, componentName(component.component), component.calls, component.failed]));
    if (components.length) sections.push(table(['飞书应用', '调用组件', '窗口内调用', '失败'], components));
    const repeats = snapshot.apiHealth.providers.flatMap(item => (item.duplicateReads || []).map(read =>
      [item.label, componentName(read.component), read.endpoint, read.calls]));
    if (repeats.length) sections.push(table(['可能重复读取', '组件', '5分钟返回相同数据的接口', '次数'], repeats));
    if (snapshot.apiHealth.tenantQuotaLimit) sections.push(`已确认企业月度上限 ${number(snapshot.apiHealth.tenantQuotaLimit)} 次；相同读取比较仅覆盖升级后的成功请求，不补造历史，也不据此断言业务设计错误。`);
  }
  if (snapshot.recovery?.length) sections.push(table(['故障处理', '当前阶段', '结果／阻塞'],
    snapshot.recovery.slice(-20).map(item => [item.subject, `${item.label}；${item.attempts}次补救`, item.reason || item.summary || '沿原任务检查点办理'])));
  const summary = [
    ['Token 消耗', totals ? `${number(totals.totalTokens)} Token；后台 ${number(totals.backgroundTokens)}` : '读取不可用', snapshot.usage ? `${time(snapshot.usage.window.start)} 至 ${time(snapshot.usage.window.end)}，仅本实例` : '待核验'],
    ['账号额度', `${snapshot.accounts.filter(account => account.status === 'available').length} 个可用；${snapshot.coverage.unknownAccounts} 个未知／冲突`, '只统计已接入来源，未知不当作可用'],
    ...snapshot.disks.map(disk => [disk.label, disk.status === 'unknown' ? '读取不可用' : `已用 ${disk.usedPercent.toFixed(1)}%；可用 ${bytes(disk.availableBytes)}`, time(disk.observedAt)]),
    ['自动化运行', `${snapshot.automations.active} 项启用；${snapshot.services.length} 项独立服务／定时器已接入`, '完成、执行成功与结果送达分别核对'],
    ...snapshot.services.filter(item => item.status === 'paused').map(item => [item.label, '按原指令停用', item.maintenanceReason]),
    ['自动请求', `${recentRequests.length} 项窗口内回执；${recentRequests.filter(item => item.status === 'failed').length} 项失败`, '原回执保留，固定验证请求不计为项目成果'],
  ];
  sections.push(table(['项目', '本轮状态', '范围／观测时间'], summary));
  if (totals) sections.push(`接口报告费用：${totals.exactCostRunCount ? `$${Number(totals.costUsd).toFixed(2)}` : '未提供'}；Token 价格估算：$${Number(totals.estimatedCostUsd || 0).toFixed(2)}。估算不代表订阅实际扣费。`);
  sections.push(capacity.length
    ? `**可安排工作的资源：**${capacity.map(account => `${account.label} 七天剩余 ${account.remainingPercent}%（重置 ${time(account.resetsAt)}）`).join('；')}。结合本日报已有项目任务、当前进展和可核对交付选择工作，不能仅为消耗额度创建无用任务。`
    : '**资源利用：**本轮没有已核验的七天富余额度，不用未知或旧快照推断闲置。');
  const gaps = snapshot.coverage.gaps.map(gap => `${gap.source}（${gap.code}）`);
  sections.push(`**覆盖与缺口：**消耗覆盖本实例，额度覆盖已接入账号；未接入机器与账号不在本轮结论内。${gaps.length ? `读取缺口：${gaps.join('、')}。` : ''}${snapshot.coverage.unknownAccounts ? `另有 ${snapshot.coverage.unknownAccounts} 个账号读数待核验。` : ''}${snapshot.coverage.unverifiedAdmissions ? `${snapshot.coverage.unverifiedAdmissions} 条准入记录缺少可核验执行状态，原记录保留，不计为正在运行。` : ''}`);
  return sections.join('\n\n') + '\n';
}

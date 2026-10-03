const cell = value => String(value ?? '—').replace(/\|/g, '／').replace(/[\r\n]+/g, ' ');
const number = value => typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知';
const bytes = value => typeof value === 'number' ? `${(value / 1024 ** 3).toFixed(2)} GiB` : '未知';
const table = (fields, rows) => `| ${fields.join(' | ')} |\n| ${fields.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n')}`;

export function renderMonitoringReport(snapshot) {
  const totals = snapshot.usage?.totals;
  const risks = snapshot.attention.map(item => [item.subject, item.severity === 'critical' ? '紧急' : '需关注',
    item.kind === 'disk' ? `可用 ${bytes(item.availableBytes)}；已用 ${item.usedPercent.toFixed(1)}%`
      : item.kind === 'quota' ? `额度耗尽；另有 ${item.availableAccounts} 个可用账号`
        : item.kind === 'lowQuota' ? '额度窗口剩余不超过10%' : '核对原执行或服务回执']);
  const capacity = snapshot.opportunities.flatMap(item => item.accounts || []);
  const recentRequests = (snapshot.automaticRequests || []).filter(item => Date.parse(item.completedAt) >= Date.parse(snapshot.usage?.window?.start || snapshot.generatedAt));
  const sections = [`## 资源与运行\n\n本轮读取：${snapshot.generatedAt}。${risks.length ? `有 ${risks.length} 项需要关注。` : '已核验范围内未发现资源或运行问题。'}\n\n监管持续记录；日常状态随本日报发布，紧急问题单独提醒。`];
  if (risks.length) sections.push(table(['对象', '状态', '需要处理'], risks));
  const summary = [
    ['Token 消耗', totals ? `${number(totals.totalTokens)} Token；后台 ${number(totals.backgroundTokens)}` : '读取不可用', snapshot.usage ? `${snapshot.usage.window.start} 至 ${snapshot.usage.window.end}，仅本实例` : '待核验'],
    ['账号额度', `${snapshot.accounts.filter(account => account.status === 'available').length} 个可用；${snapshot.coverage.unknownAccounts} 个未知／冲突`, '只统计已接入来源，未知不当作可用'],
    ...snapshot.disks.map(disk => [disk.label, disk.status === 'unknown' ? '读取不可用' : `已用 ${disk.usedPercent.toFixed(1)}%；可用 ${bytes(disk.availableBytes)}`, disk.observedAt]),
    ['自动化运行', `${snapshot.automations.active} 项启用；${snapshot.services.length} 项独立服务／定时器已接入`, '完成、执行成功与结果送达分别核对'],
    ['自动请求', `${recentRequests.length} 项窗口内回执；${recentRequests.filter(item => item.status === 'failed').length} 项失败`, '原回执保留，固定验证请求不计为项目成果'],
  ];
  sections.push(table(['项目', '本轮状态', '范围／观测时间'], summary));
  if (totals) sections.push(`接口报告费用：${totals.exactCostRunCount ? `$${Number(totals.costUsd).toFixed(2)}` : '未提供'}；Token 价格估算：$${Number(totals.estimatedCostUsd || 0).toFixed(2)}。估算不代表订阅实际扣费。`);
  sections.push(capacity.length
    ? `**可安排工作的资源：**${capacity.map(account => `${account.label} 七天剩余 ${account.remainingPercent}%（重置 ${account.resetsAt || '未知'}）`).join('；')}。结合本日报已有项目任务、当前进展和可核对交付选择工作，不能仅为消耗额度创建无用任务。`
    : '**资源利用：**本轮没有已核验的七天富余额度，不用未知或旧快照推断闲置。');
  const gaps = snapshot.coverage.gaps.map(gap => `${gap.source}（${gap.code}）`);
  sections.push(`**覆盖与缺口：**消耗覆盖本实例，额度覆盖已接入账号；未接入机器与账号不在本轮结论内。${gaps.length ? `读取缺口：${gaps.join('、')}。` : ''}${snapshot.coverage.unknownAccounts ? `另有 ${snapshot.coverage.unknownAccounts} 个账号读数待核验。` : ''}`);
  return sections.join('\n\n') + '\n';
}

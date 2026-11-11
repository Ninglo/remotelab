// Deterministic recognition of explicit requests, not a general semantic judge.
// Resource authorization remains mandatory even for inputs not recognized here.
const dataAction = /(?:读取|读出|查看|查阅|查询|检索|搜索|检查|核对|核验|审阅|分析|解释|翻译|调出|导出|下载|展示|显示|列出|列举|提供|透露|汇总|概括|总结|复述|转述|告诉我|发给我|发我|给我|拿到|获取|确认.{0,16}(?:是否|是不是)|read\b|show\b|tell me\b|export\b|summari[sz]e\b|cat\s|head\s|tail\s)/iu;
const implicitData = /(?:最近.{0,12}(?:在做什么|做了什么|在忙什么)|(?:薪资|薪酬|工资).{0,10}(?:多少|情况|呢)|(?:日志|内部方案).{0,12}(?:内容|详情|是什么|有哪些|呢)|what.{0,20}(?:salary|working on))/iu;
const mutation = /(?:关闭|停用|禁用|删除|撤除|绕过|忽略|突破|破解|修改|替换|增加|加入|加进|扩大|放开|disable\b|bypass\b|change\b|remove\b|add\b)/iu;
const discussion = /^(?:(?:请|帮我|能否|可以)?\s*(?:解释|讨论|分析|翻译|引用|排查|核验|检查|修复|设计|介绍|说明|比较|验证)|为什么|为何|如何(?:设计|防止|避免|验证)|(?:这是|这是个|属于)?误报|防护状态)/u;
const conceptTarget = /(?:规则|防护|防火墙|告警|误报|鉴权|权限设计|访问控制|技术|机制|字段|schema|代码|风险|分类)/iu;
const policyStatement = /(?:前鉴权|前复核|另核授权|按.{0,12}授权|不(?:再|应|得|能)|不能|禁止|保持|仍拒绝|应拒绝|应阻止|暂停.{0,8}要求|不启动|不调用|不补发)/u;
const explicitTail = /(?:顺便|然后|同时|再|并且|并)\s*(?:请|帮我|把|将)?\s*(?:读取|查看|导出|给我|发我|告诉我|关闭|停用|禁用|加入|修改|绕过)/u;

function clauses(text) {
  // Quotations remain data. A command to execute a quoted payload is inspected
  // with that payload; merely quoting an alert is not an operation request.
  let value = String(text).replace(/^【飞书[^\n]*】\s*/u, '');
  if (!/(?:执行|照做|照着|按.{0,8}(?:运行|操作)|execute|run the)/iu.test(value)) {
    value = value.replace(/(?:引用(?:告警|原文)?|告警(?:原文|内容)?|原文|举例|例如)\s*[:：]?\s*[“「"]([^”」"]*)[”」"]/gu, '引用内容');
    value = value.replace(/^\s*>.*$/gmu, '引用内容');
  }
  // Never grant the rest of a message an exemption because one clause discusses
  // policy. Mixed ordinary and restricted requests are inspected separately.
  return value.split(/[\n。；;！？!?，,]/u).map(part => part.trim().replace(/^(?:\d+[.、]\s*|[-*]\s*)/u, '')).filter(Boolean);
}

export function explicitAccessIntents(text, compiled, previous) {
  const intents = [];
  for (const clause of clauses(text)) {
    const discussing = discussion.test(clause) && conceptTarget.test(clause) && !explicitTail.test(clause)
      && !/(?:把我|把自己).{0,12}(?:加入|加进)|(?:给我|发我|告诉我).{0,12}(?:真实|薪[资酬]|工资|日志)/u.test(clause);
    const normative = policyStatement.test(clause) && !/^(?:请|帮我|现在|立即|把|将|给我)/u.test(clause)
      && !/(?:能否|能不能|告诉我|发给我|给我|吗$|么$)/u.test(clause);
    if (discussing || normative || /^(?:不要|别|禁止|不能|不得)/u.test(clause)) continue;
    const technicalMetadata = /(?:服务.{0,12}(?:启动|错误|运行|诊断|状态)|systemctl|journalctl|\.bashrc)/iu.test(clause)
      && !/(?:薪[资酬]|工资|方案|候选人|工作日志|内部(?:任务|日志|资料)|真实(?:日志|资料)|(?:当麻|\bHR\b|人事).{0,12}(?:日志|资料|记忆))/iu.test(
        clause.replace(/(?:当麻|\bHR\b|人事)?服务.{0,12}?(?:日志|状态)/giu, '技术元数据'));
    for (const rule of compiled.filter(rule => !rule.continuation)) {
      if (technicalMetadata && rule.category !== 'bypass' && rule.technicalMetadataAllowed === true) continue;
      const operation = rule.category === 'bypass' ? mutation.test(clause) : dataAction.test(clause) || implicitData.test(clause);
      if (operation && rule.patterns.every(pattern => pattern.test(clause))) intents.push({ ...rule, targetId: rule.id });
    }
  }
  // A timestamp alone never carries a prior target. Only a whole explicit
  // follow-up can reuse the immediately preceding actor/Session target.
  if (intents.length) return intents;
  if (previous?.targetId && String(text).trim()) {
    const followup = compiled.find(rule => rule.continuation && rule.patterns.every(pattern => pattern.test(String(text).trim())));
    if (followup) return [{ ...followup, targetId: previous.targetId,
      category: previous.targetCategory === 'bypass' ? 'bypass' : 'indirect' }];
  }
  return [];
}

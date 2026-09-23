// Reproducible, read-only experiment for a five-tier Auto policy.
// The benchmark sends only the synthetic prompts below to Jev. It does not
// create RemoteLab Sessions or change the production router.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { resolveJevAutoRoute } from '../lib/jev-auto-router.mjs';

const cases = [
  ['q1', 'quick', '你好！'],
  ['q2', 'quick', '把“我现在没空”改成更礼貌的一句话。'],
  ['q3', 'quick', '只回答版本号：Gemini 的主版本是 3.0。'],
  ['q4', 'quick', 'Translate “see you tomorrow” into Chinese. Only the translation.'],
  ['q5', 'quick', '一句话解释什么是哈希函数，不用查资料。'],
  ['q6', 'quick', '把这句话缩短到 20 字以内：我们将在核对数据之后尽快给出完整答复。'],
  ['b1', 'balanced', '读取当前项目 package.json 的 version 字段，只返回值。'],
  ['b2', 'balanced', '列出这个目录里的三个 Markdown 文件名。'],
  ['b3', 'balanced', '读取 workspace/names.csv 中的十个姓名，按拼音排序后输出列表。'],
  ['b4', 'balanced', '明天下午三点在我的日历加一个“交周报”的提醒。'],
  ['b5', 'balanced', '根据这份完整的三行表格计算合计和平均数。'],
  ['b6', 'balanced', '读取 docs/email.md 里的三句话邮件，拟一个简短标题。'],
  ['c1', 'quality', '修复生产服务里的竞态问题，跑相关测试并部署。'],
  ['c2', 'quality', '帮我分析这个研究方向，找出关键实验和评测风险。'],
  ['c3', 'quality', '结合我们前面的聊天内容，判断下一步该怎么处理。'],
  ['c4', 'quality', '这批医疗检查结果意味着什么，我应该如何处理？'],
  ['c5', 'quality', '快点修好支付系统的金额计算错误并上线。'],
  ['c6', 'quality', '设计一次数据库迁移，确保已有任务和正在运行的会话不会被改写。'],
  ['c7', 'quality', '评估一个 Auto 路由策略：要比较速度、成本、误判和真实任务质量。'],
  ['s1', 'sota', '这次请使用最强的 GPT-6 Astra 和最高思考档位来分析。'],
  ['s2', 'sota', '这是极其重要的决策，请用你最强的模型和最大推理努力处理。'],
  ['e1', 'economy', '只是随便打个招呼，请用最便宜的模型回复“嗨”。'],
  ['e2', 'economy', '随便讲一个笑话，优先最低成本，不要求质量。'],
  ['m1', 'quality', '一句话说清楚：生产数据库的数据丢失风险和恢复步骤。'],
  ['m2', 'balanced', '请尽快从当前文件里读出公开 SSH 公钥，只输出公钥。'],
  ['m3', 'quality', '不要调用工具，只告诉我今天这只股票的最新价格，必须准确。'],
  ['m4', 'quality', '用最便宜的模型告诉我这些症状是否需要急诊。'],
  ['m5', 'quality', '把我刚才在另一个会话说的需求总结成一句话。'],
  ['m6', 'balanced', '这个 Markdown 文件有没有“安装”标题？只回复是或否。'],
  ['m7', 'quick', '给我两个更简短的“收到，谢谢”表达。'],
  ['m8', 'quality', '尽快完成线上权限系统的修复，兼容旧会话并验证回滚方案。'],
];

// Holdout cases were written after the five-tier question and thresholds were
// fixed. Keep them separate when reporting accuracy.
const holdoutCases = [
  ['hq1', 'quick', '写一句生日祝福，不超过 15 字。'],
  ['hq2', 'quick', '把 “Please confirm receipt.” 翻译成中文，只给译文。'],
  ['hq3', 'quick', '检查这句话有没有错别字，只回答修改后的句子：这个功能已经上线了。'],
  ['hq4', 'quick', '2 + 2 等于几？只回答数字。'],
  ['hq5', 'quick', '用一句话解释什么是 API，不用查资料。'],
  ['hb1', 'balanced', '查看项目 package.json 里 scripts.test 的值。'],
  ['hb2', 'balanced', '统计桌面目录中每种图片扩展名的文件数。'],
  ['hb3', 'balanced', '从附件表格里取三项数字求和，给出算式。'],
  ['hb4', 'balanced', '在日历里添加明天早上九点的半小时会议。'],
  ['hb5', 'balanced', '看一下本机 Git 当前在哪个分支。'],
  ['hc1', 'quality', '把生产服务从旧接口迁到新接口，保证老数据可用并完成部署。'],
  ['hc2', 'quality', '看这篇论文的实验，判断结论是否被数据支持。'],
  ['hc3', 'quality', '核实今天这家公司最新融资额并给出处。'],
  ['hc4', 'quality', '根据我们之前的结论决定项目下一步方向。'],
  ['hc5', 'quality', '简单回答我现在能不能停药。'],
  ['hc6', 'quality', '立刻删除所有重复订单并退款。'],
  ['hs1', 'sota', '使用当前最强模型和最高推理强度，仔细审查这个方案。'],
  ['he1', 'economy', '用最省钱的模型随便聊两句，不用保证回答质量。'],
  ['hm1', 'quality', '一句话告诉我刚才发来的合同有什么违约风险。'],
  ['hm2', 'balanced', '请快点查一下当前服务器的磁盘剩余空间，只返回数字。'],
  ['hm3', 'sota', '尽快答复，但必须使用最强的模型和最高推理档。'],
  ['hm4', 'quality', '只回答“可以”或“不可以”：我们能立即关闭生产数据库备份吗？'],
];

const tiers = ['quick', 'balanced', 'quality', 'sota', 'economy'];
const question = {
  service_tier: {
    type: 'choice',
    instructions: 'Route the entire new RemoteLab Session from its first user message. Choose quality if context or consequences are uncertain. Choose quick for self-contained, brief, low-stakes conversational work that can be answered from the supplied text without tools or external facts. Any request to inspect a file, attachment, mailbox, calendar, prior chat, or current external fact is not quick, even if the answer is one word; use at least balanced. Quick uses a strong model with low reasoning effort. A request to hurry does not make consequential work quick. Choose balanced for bounded, low-risk work that can need a few tools. Choose economy only when the user explicitly prioritizes the cheapest acceptable response for casual work. Choose sota only when the user explicitly asks for the strongest model or maximum reasoning. Treat Chinese and English equally. Short prompts can start serious work.',
    criteria: {
      quick: 'Brief, self-contained, low-stakes answers, rewrites, translations, simple explanations or greetings using only text inside the message; no tools, file or attachment reads, prior chat, current facts or consequential action. Select because the task is simple, not merely because the user says fast.',
      balanced: 'Bounded, low-risk routine work such as reading a known file, calendar entry, simple calculation or formatting with supplied data; at most a few straightforward tool actions; errors easy to spot and fix.',
      quality: 'Default for ambiguous, serious or consequential work, research, development, debugging, multi-step tasks, production, evaluation, current facts that need verification, or references to conversation and missing context. Also use this when speed is requested for a consequential task.',
      sota: 'Only explicit strongest model, GPT-6 Astra, maximum reasoning or exceptional highest-quality request.',
      economy: 'Only explicit lowest-cost preference for casual, low-stakes work. Cheapest is not the same as fastest. Do not use for facts, tools or consequential action.',
    },
  },
};

function keyFromEnvFile(content) {
  const line = content.split(/\r?\n/).find(raw => /^\s*TYPESAFE_API_KEY\s*=/.test(raw));
  return line?.replace(/^\s*TYPESAFE_API_KEY\s*=\s*/, '').replace(/^['"]|['"]$/g, '').trim() || '';
}

async function getKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  const path = process.env.TYPESAFE_KEY_FILE || join(CONFIG_DIR, 'typesafe.env');
  return keyFromEnvFile(await readFile(path, 'utf8'));
}

async function candidateRoute(prompt, key) {
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
        state: { task: prompt },
        questions: question,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const decision = (await response.json()).answers?.service_tier;
    const choice = decision?.choice;
    const p = decision?.probabilities || {};
    if (!tiers.includes(choice)) throw new Error('invalid_choice');
    const confidence = Math.max(Number(decision.confidence) || 0, Number(p[choice]) || 0);
    let final = choice;
    if (choice === 'quick' && (confidence < 0.65 || Number(p.quality) >= 0.2)) final = 'quality';
    if (choice === 'balanced' && (confidence < 0.6 || Number(p.quality) >= 0.25)) final = 'quality';
    if (choice === 'economy' && (confidence < 0.8 || Number(p.quality) >= 0.1)) final = 'quality';
    if (choice === 'sota' && confidence < 0.75) final = 'quality';
    return { choice, final, confidence: Number(confidence.toFixed(3)), qualityProbability: Number(p.quality), ms: Math.round(performance.now() - start) };
  } catch (error) {
    return { choice: null, final: 'quality', error: error.name === 'AbortError' ? 'timeout' : error.message, ms: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timeout);
  }
}

const key = await getKey();
if (!key) throw new Error('TypeSafe key unavailable');
const results = [];
const queue = [
  ...cases.map(row => ['development', ...row]),
  ...holdoutCases.map(row => ['holdout', ...row]),
];
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const [set, id, gold, prompt] = queue.shift();
    const [oldRoute, candidate] = await Promise.all([
      resolveJevAutoRoute(prompt),
      candidateRoute(prompt, key),
    ]);
    results.push({
      set, id, gold, prompt,
      current: oldRoute.autoRoutingReceipt?.decision?.tier || 'quality',
      currentStatus: oldRoute.autoRoutingReceipt?.status,
      currentMs: oldRoute.autoRoutingReceipt?.latencyMs ?? null,
      candidate,
    });
  }
}));
results.sort((a, b) => a.id.localeCompare(b.id));
const summary = Object.fromEntries(['development', 'holdout'].map(set => {
  const rows = results.filter(row => row.set === set);
  const shared = rows.filter(row => row.gold !== 'quick');
  return [set, {
    cases: rows.length,
    candidateCorrect: rows.filter(row => row.candidate.final === row.gold).length,
    currentCorrectOnSharedTiers: shared.filter(row => row.current === row.gold).length,
    sharedTierCases: shared.length,
    candidateErrors: rows.filter(row => row.candidate.error).length,
    currentFallbacks: rows.filter(row => row.currentStatus === 'fallback').length,
  }];
}));
console.log(JSON.stringify({ summary, results }, null, 2));

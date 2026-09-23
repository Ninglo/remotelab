// Small native Codex check of GPT-6 Sol low versus xhigh on simple requests.
// This does not measure RemoteLab UI/network or production Session startup.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const cases = [
  { id: 'arithmetic', prompt: '只回答数字：15 + 27 等于多少？', expected: /^42$/ },
  { id: 'date', prompt: '从这句话提取日期并只回答 YYYY-MM-DD：会议在 2026 年 10 月 3 日举行。', expected: /^2026-10-03$/ },
  { id: 'sort', prompt: '把 17、2、11、5 从小到大排序，只回答用逗号分隔的数字。', expected: /^2[,，]5[,，]11[,，]17$/ },
  { id: 'translate', prompt: '把 “See you tomorrow.” 译成简短自然的中文，只回答译文。', expected: /^明天见[。！!]?$/ },
  { id: 'extract', prompt: '只根据这句话回答颜色，不要解释：红色的杯子放在蓝色的盒子旁边。杯子是什么颜色？', expected: /^红色[。]?$/ },
  { id: 'rewrite', prompt: '把“你快回复我”改成礼貌、简短的一句话，只回答改写结果。', expected: /(请|麻烦).*(回复|答复)/ },
];

async function run(prompt, effort) {
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '-C', '/tmp',
    '-m', 'gpt-6-sol', '-c', `model_reasoning_effort="${effort}"`,
    '--json', prompt,
  ];
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const answer = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message')
        .map(event => event.item.text).at(-1) || '';
      const usage = events.find(event => event.type === 'turn.completed')?.usage || null;
      resolve({ code, ms: Math.round(performance.now() - start), answer, usage, error: code === 0 ? '' : stderr.slice(-300) });
    });
  });
}

const results = [];
for (const [index, item] of cases.entries()) {
  const order = index % 2 === 0 ? ['low', 'xhigh'] : ['xhigh', 'low'];
  for (const effort of order) {
    const result = await run(item.prompt, effort);
    results.push({ id: item.id, effort, ...result, correct: item.expected.test(result.answer.trim()) });
  }
}
const summary = Object.fromEntries(['low', 'xhigh'].map(effort => {
  const rows = results.filter(result => result.effort === effort);
  const latencies = rows.map(result => result.ms).sort((a, b) => a - b);
  return [effort, {
    correct: rows.filter(result => result.correct).length,
    cases: rows.length,
    medianMs: Math.round((latencies[2] + latencies[3]) / 2),
    totalInputTokens: rows.reduce((total, row) => total + (row.usage?.input_tokens || 0), 0),
    totalOutputTokens: rows.reduce((total, row) => total + (row.usage?.output_tokens || 0), 0),
    totalReasoningTokens: rows.reduce((total, row) => total + (row.usage?.reasoning_output_tokens || 0), 0),
  }];
}));
console.log(JSON.stringify({ summary, results }, null, 2));

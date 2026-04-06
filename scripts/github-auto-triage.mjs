#!/usr/bin/env node

import { execFile as execFileCallback } from 'child_process';
import { access, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { AUTH_FILE, CHAT_PORT } from '../lib/config.mjs';
import { selectAssistantReplyEvent } from '../lib/reply-selection.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const MARKER = '<!-- remotelab-github-auto-triage -->';
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_SESSION_TOOL = 'codex';
const REQUEST_MARKER_PREFIX = '<!-- remotelab-github-request-id:';
const execFileAsync = promisify(execFileCallback);

const STOP_WORDS_EN = new Set([
  'about', 'after', 'again', 'also', 'been', 'being', 'both', 'from', 'have', 'just', 'more',
  'much', 'only', 'onto', 'that', 'this', 'there', 'their', 'they', 'then', 'than', 'what',
  'when', 'where', 'while', 'which', 'with', 'would', 'your', 'into', 'issue', 'github', 'repo',
  'thread', 'reply', 'please', 'thanks', 'thank', 'problem',
  'remotelab', 'still', 'should', 'could',
  'does', 'doesn', 'dont', 'cant', 'cannot', 'using', 'used', 'want', 'need'
]);

const STOP_WORDS_ZH = new Set([
  '这个', '那个', '现在', '当前', '我们', '你们', '你这', '这里', '一下', '已经', '可以', '是否', '是不是',
  '为什么', '怎么', '如何', '如果', '然后', '就是', '因为', '一个', '一些', '这种', '这个问题', '产品',
  '能力', '功能', '回复', '评论', '收到', '确认', '自动', '情况', '以及', '相关', '当前方向', '测试',
  '希望', '支持', '使用', '体验', '问题', '建议', '线程', '维护者'
]);

let cachedKnowledgeSections = null;

function usage(exitCode = 0) {
  const message = `Usage:
  node scripts/github-auto-triage.mjs --repo <owner/repo> [options]

Options:
  --repo <owner/repo>         GitHub repository to watch
  --post                      Actually post replies instead of dry-run
  --chat-base-url <url>       RemoteLab base URL (default: ${DEFAULT_CHAT_BASE_URL})
  --session-folder <path>     Folder used for RemoteLab sessions (default: ${PROJECT_ROOT})
  --session-tool <tool>       Tool used for RemoteLab sessions (default: ${DEFAULT_SESSION_TOOL})
  --model <id>                Optional model override for submitted messages
  --effort <level>            Optional effort override for submitted messages
  --thinking                  Enable thinking for submitted messages
  --bootstrap-hours <hours>   Lookback window on first run (default: 72)
  --limit <count>             Max updated items to inspect per run (default: 20)
  --max-comments <count>      Max issue comments kept in snapshot (default: 20)
  --maintainers <logins>      Comma-separated maintainer logins (default: current gh user)
  --only <numbers>            Comma-separated issue/PR numbers for manual testing
  --reply-to-maintainers      Allow maintainer-authored threads to receive one manual test reply
  --force-draft               Generate a reply draft even if the thread is already handled (requires --only, forbids --post)
  --state-file <path>         Override state file path
  --snapshot-dir <path>       Override snapshot directory
  --verbose                   Print extra details
  -h, --help                  Show this help

Behavior:
  - Polls GitHub issues + PRs by updated time through gh api
  - Writes local intake snapshots for each changed thread
  - Normalizes each inbound update into a RemoteLab session message
  - Reads the resulting assistant message back from RemoteLab and publishes it to GitHub
  - Scheduled runs remain conservative by default and do not auto-reply to maintainer-authored threads
`;
  console.log(message);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    repo: '',
    post: false,
    chatBaseUrl: DEFAULT_CHAT_BASE_URL,
    sessionFolder: PROJECT_ROOT,
    sessionTool: DEFAULT_SESSION_TOOL,
    model: '',
    effort: '',
    thinking: false,
    bootstrapHours: 72,
    limit: 20,
    maxComments: 20,
    maintainers: '',
    onlyNumbers: [],
    replyToMaintainers: false,
    forceDraft: false,
    stateFile: '',
    snapshotDir: '',
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      options.repo = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--post') {
      options.post = true;
      continue;
    }
    if (arg === '--chat-base-url') {
      options.chatBaseUrl = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--session-folder') {
      options.sessionFolder = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--session-tool') {
      options.sessionTool = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--model') {
      options.model = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--effort') {
      options.effort = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--thinking') {
      options.thinking = true;
      continue;
    }
    if (arg === '--bootstrap-hours') {
      options.bootstrapHours = parseInteger(argv[index + 1], 72, '--bootstrap-hours');
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = parseInteger(argv[index + 1], 20, '--limit');
      index += 1;
      continue;
    }
    if (arg === '--max-comments') {
      options.maxComments = parseInteger(argv[index + 1], 20, '--max-comments');
      index += 1;
      continue;
    }
    if (arg === '--maintainers') {
      options.maintainers = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--only') {
      options.onlyNumbers = parseNumberList(argv[index + 1], '--only');
      index += 1;
      continue;
    }
    if (arg === '--reply-to-maintainers') {
      options.replyToMaintainers = true;
      continue;
    }
    if (arg === '--force-draft') {
      options.forceDraft = true;
      continue;
    }
    if (arg === '--state-file') {
      options.stateFile = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--snapshot-dir') {
      options.snapshotDir = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      usage(0);
    }
    usage(1);
  }

  if (!options.repo) usage(1);
  if (!options.chatBaseUrl) {
    console.error('[triage] --chat-base-url requires a value');
    process.exit(1);
  }
  if (!options.sessionFolder) {
    console.error('[triage] --session-folder requires a value');
    process.exit(1);
  }
  if (!options.sessionTool) {
    console.error('[triage] --session-tool requires a value');
    process.exit(1);
  }
  if (options.forceDraft && options.post) {
    console.error('[triage] --force-draft is a preview-only mode and cannot be combined with --post');
    process.exit(1);
  }
  if (options.forceDraft && options.onlyNumbers.length === 0) {
    console.error('[triage] --force-draft requires --only <numbers>');
    process.exit(1);
  }
  return options;
}

function parseInteger(value, fallback, flagName) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`[triage] Invalid value for ${flagName}: ${value || '(missing)'}`);
    process.exit(1);
  }
  return parsed || fallback;
}

function parseNumberList(value, flagName) {
  if (!value) {
    console.error(`[triage] Missing value for ${flagName}`);
    process.exit(1);
  }
  const numbers = Array.from(new Set(
    value
      .split(/[,\s]+/)
      .map((entry) => Number.parseInt(entry, 10))
      .filter((entry) => Number.isInteger(entry) && entry > 0)
  ));
  if (numbers.length === 0) {
    console.error(`[triage] Invalid value for ${flagName}: ${value}`);
    process.exit(1);
  }
  return numbers;
}

async function pathExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

async function readJson(pathname, fallback) {
  if (!await pathExists(pathname)) return fallback;
  try {
    return JSON.parse(await readFile(pathname, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(pathname, value) {
  await ensureDir(dirname(pathname));
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function configRoot() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const base = xdgConfigHome || join(homedir(), '.config');
  return join(base, 'remotelab', 'github-triage');
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  if (!normalized) {
    throw new Error('chat base URL is required');
  }
  return normalized.replace(/\/+$/, '');
}

async function readOwnerToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to RemoteLab at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function sanitizeIdPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function sanitizeRepo(repo) {
  return repo.replace(/[:/\\]+/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolvePaths(repo, overrides) {
  const safeRepo = sanitizeRepo(repo);
  const base = configRoot();
  return {
    stateFile: overrides.stateFile || join(base, `${safeRepo}.json`),
    snapshotDir: overrides.snapshotDir || join(base, 'inbox', safeRepo),
  };
}

async function runGh(args, input = undefined) {
  try {
    const result = await execFileAsync('gh', args, {
      encoding: 'utf8',
      input,
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout || '';
  } catch (error) {
    const message = trimString(error?.stderr || error?.stdout || error?.message || '') || `gh ${args.join(' ')}`;
    throw new Error(message);
  }
}

async function runGhJson(args) {
  const output = (await runGh(args)).trim();
  return output ? JSON.parse(output) : null;
}

function flattenPages(payload) {
  if (Array.isArray(payload) && payload.every((entry) => Array.isArray(entry))) return payload.flat();
  if (Array.isArray(payload)) return payload;
  if (payload) return [payload];
  return [];
}

async function currentMaintainerLogin() {
  return (await runGh(['api', 'user', '--jq', '.login'])).trim();
}

async function normalizeMaintainers(rawMaintainers) {
  const values = Array.from(new Set(
    rawMaintainers
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  ));

  const currentLogin = await currentMaintainerLogin();
  if (!values.some((value) => value.toLowerCase() == currentLogin.toLowerCase())) {
    values.push(currentLogin);
  }
  return values;
}

function maintainerSet(maintainers) {
  return new Set(maintainers.map((login) => login.toLowerCase()));
}

function isMaintainer(login, maintainers) {
  if (!login) return false;
  return maintainers.has(login.toLowerCase());
}

async function fetchUpdatedItems(repo, sinceIso, limit) {
  const payload = await runGhJson([
    'api', '--paginate', '--slurp', '-X', 'GET', `repos/${repo}/issues`,
    '-f', 'state=all', '-f', 'sort=updated', '-f', 'direction=desc', '-f', 'per_page=100', '-f', `since=${sinceIso}`,
  ]);
  return flattenPages(payload).slice(0, limit);
}

async function fetchThreadItem(repo, number) {
  return runGhJson(['api', '-X', 'GET', `repos/${repo}/issues/${number}`]);
}

async function fetchItems(repo, sinceIso, limit, onlyNumbers) {
  if (onlyNumbers.length > 0) {
    const items = await Promise.all(onlyNumbers.map((number) => fetchThreadItem(repo, number)));
    return items.filter(Boolean);
  }
  return fetchUpdatedItems(repo, sinceIso, limit);
}

async function fetchIssueComments(repo, number) {
  const payload = await runGhJson([
    'api', '--paginate', '--slurp', '-X', 'GET', `repos/${repo}/issues/${number}/comments`, '-f', 'per_page=100',
  ]);
  return flattenPages(payload);
}

async function fetchPullRequestReviews(repo, number) {
  const payload = await runGhJson([
    'api', '--paginate', '--slurp', '-X', 'GET', `repos/${repo}/pulls/${number}/reviews`, '-f', 'per_page=100',
  ]);
  return flattenPages(payload);
}

function latestEvent(events, predicate) {
  const filtered = events.filter(predicate);
  if (filtered.length === 0) return null;
  return filtered.reduce((latest, event) => {
    if (!latest) return event;
    return Date.parse(event.timestamp) > Date.parse(latest.timestamp) ? event : latest;
  }, null);
}

function latestIssueComment(issueComments, predicate) {
  const filtered = issueComments.filter(predicate);
  if (filtered.length === 0) return null;
  return filtered.reduce((latest, comment) => {
    if (!latest) return comment;
    const timestamp = comment.updated_at || comment.created_at;
    const latestTimestamp = latest.updated_at || latest.created_at;
    return Date.parse(timestamp) > Date.parse(latestTimestamp) ? comment : latest;
  }, null);
}

function detectLanguage(...inputs) {
  const combined = inputs.filter(Boolean).join('\n');
  return /[\u3400-\u9fff]/.test(combined) ? 'zh' : 'en';
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function emptyText(text) {
  const normalized = normalizeWhitespace(text || '');
  return normalized || '(empty)';
}

function excerpt(text, maxLength = 180) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function addKeyword(counts, keyword, weight = 1) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return;
  counts.set(normalized, (counts.get(normalized) || 0) + weight);
}

function collectEnglishKeywords(text, weight, counts) {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (const word of matches) {
    if (STOP_WORDS_EN.has(word)) continue;
    addKeyword(counts, word, weight);
  }
}

function collectChineseKeywords(text, weight, counts) {
  const segments = text.replace(/[^\u3400-\u9fff]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const segment of segments) {
    if (segment.length < 2) continue;
    if (segment.length <= 4 && !STOP_WORDS_ZH.has(segment)) {
      addKeyword(counts, segment, weight * 2);
    }
    const maxN = Math.min(4, segment.length);
    for (let size = 2; size <= maxN; size += 1) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        const gram = segment.slice(index, index + size);
        if (STOP_WORDS_ZH.has(gram)) continue;
        addKeyword(counts, gram, weight * size);
      }
    }
  }
}

function extractKeywords(title, body, threadText) {
  const counts = new Map();
  collectEnglishKeywords(title || '', 3, counts);
  collectChineseKeywords(title || '', 3, counts);
  collectEnglishKeywords(body || '', 1, counts);
  collectChineseKeywords(body || '', 1, counts);
  collectEnglishKeywords(threadText || '', 1, counts);
  collectChineseKeywords(threadText || '', 1, counts);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .map(([keyword]) => keyword)
    .slice(0, 12);
}

async function markdownFilesIn(dirPath) {
  if (!await pathExists(dirPath)) return [];
  return (await readdir(dirPath))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(dirPath, name))
    .sort();
}

function pushKnowledgeBlocks(blocks, filePath, heading, rawText) {
  const paragraphs = rawText
    .split(/\n\s*\n/g)
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);

  if (paragraphs.length === 0) return;
  for (const paragraph of paragraphs) {
    blocks.push({
      filePath,
      relPath: relative(PROJECT_ROOT, filePath),
      heading: heading || 'Overview',
      text: paragraph,
    });
  }
}

async function loadKnowledgeSections() {
  if (cachedKnowledgeSections) return cachedKnowledgeSections;

  const projectDoc = await pathExists(join(PROJECT_ROOT, 'AGENTS.md'))
    ? join(PROJECT_ROOT, 'AGENTS.md')
    : join(PROJECT_ROOT, 'CLAUDE.md');

  const files = [
    projectDoc,
    join(PROJECT_ROOT, 'README.md'),
    join(PROJECT_ROOT, 'README.zh.md'),
    ...await markdownFilesIn(join(PROJECT_ROOT, 'docs')),
    ...await markdownFilesIn(join(PROJECT_ROOT, 'notes')),
  ];

  const existingFiles = [];
  for (const filePath of files) {
    if (!await pathExists(filePath)) continue;
    if (existingFiles.includes(filePath)) continue;
    existingFiles.push(filePath);
  }

  const blocks = [];
  for (const filePath of existingFiles) {
    if (filePath.endsWith('github-auto-triage.md')) continue;
    const content = await readFile(filePath, 'utf8');
    const lines = content.split('\n');
    let heading = 'Overview';
    let buffer = [];

    const flush = () => {
      if (buffer.length === 0) return;
      pushKnowledgeBlocks(blocks, filePath, heading, buffer.join('\n'));
      buffer = [];
    };

    for (const line of lines) {
      if (/^#{1,6}\s+/.test(line)) {
        flush();
        heading = line.replace(/^#{1,6}\s+/, '').trim();
        continue;
      }
      buffer.push(line);
    }
    flush();
  }

  cachedKnowledgeSections = blocks;
  return blocks;
}

function scoreSection(section, keywords) {
  const haystack = section.text;
  const lowerHaystack = haystack.toLowerCase();
  const lowerHeading = (section.heading || '').toLowerCase();
  let score = 0;

  for (const keyword of keywords) {
    const isEnglish = /[a-z]/i.test(keyword);
    const hitInText = isEnglish ? lowerHaystack.includes(keyword) : haystack.includes(keyword);
    const hitInHeading = isEnglish ? lowerHeading.includes(keyword) : (section.heading || '').includes(keyword);
    if (hitInText) score += keyword.length >= 4 ? 4 : 2;
    if (hitInHeading) score += 3;
  }

  if (section.relPath.startsWith('notes/')) score += 1;
  if (section.relPath === 'AGENTS.md' || section.relPath === 'CLAUDE.md') score += 1;
  return score;
}

async function findRelevantContext(item, issueComments, latestExternalActivity) {
  const threadText = [
    item.body || '',
    latestExternalActivity?.body || '',
    issueComments.map((comment) => comment.body || '').join('\n'),
  ].join('\n');
  const keywords = extractKeywords(item.title || '', item.body || '', threadText);
  if (keywords.length === 0) return [];

  const sections = (await loadKnowledgeSections())
    .map((section) => ({ section, score: scoreSection(section, keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.section.relPath.localeCompare(right.section.relPath));

  const results = [];
  const seen = new Set();
  for (const entry of sections) {
    const dedupeKey = `${entry.section.relPath}::${entry.section.heading}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push({
      relPath: entry.section.relPath,
      heading: entry.section.heading,
      text: excerpt(entry.section.text, 180),
      score: entry.score,
    });
    if (results.length >= 3) break;
  }
  return results;
}

function classifyThread(item, threadText) {
  if (item.pull_request) return 'pr';
  const combined = `${item.title || ''}\n${threadText || ''}`.toLowerCase();
  if (/[?？]/.test(combined) || /(clarify|question|direction|why|how|should|是不是|是否|如何|为什么|方向|取舍)/.test(combined)) return 'question';
  if (/(feature|support|proposal|suggest|希望|建议|支持|能力|需求)/.test(combined)) return 'feature';
  if (/(bug|error|fail|broken|cannot|can't|crash|unable|报错|失败|异常|无法|不工作|复现)/.test(combined)) return 'bug';
  return 'issue';
}

function classificationLabel(language, classification, maintainerTest) {
  if (maintainerTest) return language === 'zh' ? '维护者回归测试' : 'maintainer regression test';
  const labels = {
    zh: {
      bug: '问题排查 / 使用异常',
      question: '产品方向 / 设计取舍',
      feature: '能力建议 / 演进方向',
      pr: '变更评审 / 方向对齐',
      issue: '一般问题 intake',
    },
    en: {
      bug: 'bug triage / troubleshooting',
      question: 'product direction / trade-off',
      feature: 'feature request / evolution',
      pr: 'review direction / alignment',
      issue: 'general intake',
    },
  };
  return labels[language][classification] || labels[language].issue;
}

function renderContextLines(language, relevantContext, maintainerTest = false) {
  if (maintainerTest) {
    return language === 'zh'
      ? [
          '- live poller、state、snapshot 都已经命中这条线程，只是默认策略不会自动对维护者自己开的 issue 说“收到”。',
          '- 当前定时任务仍然保持每 60 秒轮询一次，但只自动处理外部用户的新线程 / 新跟进。',
          '- 这次手动打开维护者测试开关，目的就是单独验证评论发布这一步是否打通。',
        ]
      : [
          '- The live poller, state, and snapshot path already reached this thread; the default rule simply avoids auto-replying to maintainer-authored issues.',
          '- The scheduler still runs every 60 seconds, but only auto-handles new external-user activity by default.',
          '- This manual maintainer test switch exists specifically to verify the comment-publishing step in isolation.',
        ];
  }
  if (relevantContext.length === 0) {
    return language === 'zh'
      ? ['- 这条线程暂时没有特别强的上下文命中，我先按通用排查 / 产品判断来处理。']
      : ['- I do not have a strong context match yet, so I am starting from general troubleshooting / product judgment.'];
  }
  return relevantContext.map((entry) => {
    const location = entry.heading && entry.heading !== 'Overview'
      ? `\`${entry.relPath}\` / ${entry.heading}`
      : `\`${entry.relPath}\``;
    return language === 'zh'
      ? `- ${location}：${entry.text}`
      : `- ${location}: ${entry.text}`;
  });
}

function buildAdviceLines(language, classification, kind, relevantContext, maintainerTest) {
  if (language === 'zh') {
    if (maintainerTest) {
      return [
        '- 轮询、state 入库、snapshot 生成都已经命中到这个 issue。',
        '- 这次通过显式测试开关放开后，评论发布这一步也验证通过了。',
        '- 定时任务默认仍然不会对维护者自己发起的线程自动回复，所以日常运行不会自己刷自己。',
      ];
    }
    if (kind === 'pr') {
      return [
        '- 我会先看变更范围是否和标题 / 描述一致。',
        '- 再看测试方式、边界行为，以及是否和当前产品方向对齐。',
        relevantContext.length > 0
          ? '- 如果这次改动碰到产品方向分叉，我会优先按现有设计记录来判断。'
          : '- 如果这次改动碰到方向分叉，我会先回到当前设计记录确认边界。',
      ];
    }
    if (classification === 'bug') {
      return [
        '- 我会先按「复现路径 / 环境前提 / 当前实现限制」这三层去收敛。',
        '- 如果这是稳定可复现的问题，下一步重点就是定位触发条件，再决定是修 bug 还是调整产品预期。',
      ];
    }
    if (classification === 'question') {
      return [
        '- 这更像是“当前产品方向”和“现阶段实现状态”叠在一起的问题，不只是单点 bug。',
        '- 我会优先区分：这是明确的设计取舍，还是过渡期残留造成的认知落差。',
      ];
    }
    if (classification === 'feature') {
      return [
        '- 我会先判断这是不是高频真实需求，还是当前产品边界之外的诉求。',
        '- 如果方向成立，通常会先做低复杂度的入口 / 文案 / 默认策略优化，再决定要不要做完整能力。',
      ];
    }
    return ['- 我先按通用问题 intake 处理，先确认边界，再往实现细节收敛。'];
  }

  if (maintainerTest) {
    return [
      '- Polling, state ingestion, snapshot generation, and comment publishing all hit this issue successfully.',
      '- The manual maintainer test switch proved the reply-posting path without changing the default scheduled safety rules.',
    ];
  }
  if (kind === 'pr') {
    return [
      '- I will first check whether the change scope matches the title / description.',
      '- Then I will look at test coverage, edge behavior, and whether the change aligns with the current product direction.',
    ];
  }
  if (classification === 'bug') {
    return [
      '- I will first narrow this through reproduction path, environment assumptions, and current implementation limits.',
      '- If it is consistently reproducible, the next step is to isolate the trigger condition before deciding whether this is a bug fix or an expectation / UX adjustment.',
    ];
  }
  if (classification === 'question') {
    return [
      '- This looks more like a product-direction + current-implementation question, not just a single bug.',
      '- I will first separate deliberate design choice from transitional mismatch in docs / behavior.',
    ];
  }
  if (classification === 'feature') {
    return [
      '- I will first judge whether this is a high-frequency need or a request outside the current product boundary.',
      '- If the direction is sound, the first move is usually a lightweight entry / default / copy adjustment before a full feature build-out.',
    ];
  }
  return ['- I am treating this as general intake first: define the boundary, then narrow the implementation details.'];
}

function buildNextStepLines(language, classification, kind, maintainerTest) {
  if (language === 'zh') {
    if (maintainerTest) {
      return [
        '- 只有显式带 `--reply-to-maintainers` 的手动运行，才会对维护者自己开的线程发评论。',
        '- 定时任务路径保持不变，仍然只自动处理外部用户的新线程 / 新跟进。',
      ];
    }
    if (kind === 'pr') {
      return [
        '- 这次改动的测试方式 / 覆盖范围',
        '- 如果有取舍说明或已知风险，也可以直接补在这里',
        '- 如果有关联 issue / 后续计划，也欢迎一起挂上来',
      ];
    }
    if (classification === 'bug') {
      return [
        '- 最小复现步骤',
        '- 实际行为 vs 预期行为',
        '- 报错日志、环境信息或截图',
      ];
    }
    if (classification === 'question') {
      return [
        '- 你的真实使用场景',
        '- 你期待的交互 / 能力边界',
        '- 现在最影响你的具体点',
      ];
    }
    if (classification === 'feature') {
      return [
        '- 具体用例和频率',
        '- 现在的 workaround 是什么',
        '- 你最希望先解决的那一层痛点',
      ];
    }
    return [
      '- 更具体的复现 / 使用场景',
      '- 当前最影响你的点',
      '- 你预期看到的正确行为',
    ];
  }

  if (maintainerTest) {
    return [
      '- Only manual runs with `--reply-to-maintainers` will comment on maintainer-authored threads.',
      '- The scheduled path stays conservative and continues to auto-handle only external user activity.',
    ];
  }
  if (kind === 'pr') {
    return [
      '- test plan / coverage for this change',
      '- trade-offs or known risks worth calling out',
      '- linked issues or next steps if there are any',
    ];
  }
  if (classification === 'bug') {
    return [
      '- minimal reproduction steps',
      '- actual behavior vs expected behavior',
      '- logs, environment details, or screenshots',
    ];
  }
  if (classification === 'question') {
    return [
      '- the concrete use case behind the question',
      '- the interaction / product boundary you expect',
      '- the specific part blocking you most right now',
    ];
  }
  if (classification === 'feature') {
    return [
      '- the concrete use case and frequency',
      '- the current workaround',
      '- the layer of pain you most want solved first',
    ];
  }
  return [
    '- more concrete reproduction / usage context',
    '- the most painful part right now',
    '- the behavior you expected to see',
  ];
}

function openingParagraph(language, kind, followUp, maintainerTest) {
  if (language === 'zh') {
    if (maintainerTest) {
      return '这条回复是我用维护者测试开关手动触发的。先确认一下：当前 GitHub intake → 本地 state/snapshot → 评论发布 这条链路已经命中，功能是正常的。';
    }
    if (kind === 'pr') {
      return followUp
        ? '收到你这次 PR 的补充更新了。我先基于当前线程和仓库上下文，给一个初步 review 方向判断。'
        : '收到这个 PR 了。我先基于当前线程和仓库上下文，给一个初步 review 方向判断。';
    }
    return followUp
      ? '收到你补充的内容了。我先基于当前线程和仓库上下文，给一个初步判断。'
      : '收到这个 issue 了。我先基于当前线程和仓库上下文，给一个初步判断。';
  }

  if (maintainerTest) {
    return 'This reply was triggered through the maintainer test switch. It confirms that GitHub intake → local state/snapshot → comment publishing is working end-to-end.';
  }
  if (kind === 'pr') {
    return followUp
      ? 'Thanks for the update on this PR. Here is my first review-direction take based on the current thread and repo context.'
      : 'Thanks for the PR. Here is my first review-direction take based on the current thread and repo context.';
  }
  return followUp
    ? 'Thanks for the extra context. Here is my first take based on the current thread and repo context.'
    : 'Thanks for opening this. Here is my first take based on the current thread and repo context.';
}

function buildReply({ item, kind, language, followUp, classification, relevantContext, maintainerTest }) {
  const lines = [openingParagraph(language, kind, followUp, maintainerTest), ''];

  if (language === 'zh') {
    lines.push('我当前的理解');
    lines.push(`- 这条线程主要在讨论：${emptyText(item.title)}`);
    lines.push(`- 我会先按「${classificationLabel(language, classification, maintainerTest)}」这条线处理。`);
    lines.push('');
    lines.push('初步判断');
  } else {
    lines.push('What I think this thread is about');
    lines.push(`- Main topic: ${emptyText(item.title)}`);
    lines.push(`- I am treating it as: ${classificationLabel(language, classification, maintainerTest)}.`);
    lines.push('');
    lines.push('First pass');
  }

  lines.push(...buildAdviceLines(language, classification, kind, relevantContext, maintainerTest));
  lines.push('');
  lines.push(language === 'zh' ? '结合当前仓库上下文' : 'Relevant repo context');
  lines.push(...renderContextLines(language, relevantContext, maintainerTest));
  lines.push('');
  lines.push(maintainerTest
    ? (language === 'zh' ? '这次测试说明' : 'What this test proves')
    : (language === 'zh' ? '如果你愿意继续补充，最有帮助的是' : 'If you want to help narrow it further, the most useful next details are'));
  lines.push(...buildNextStepLines(language, classification, kind, maintainerTest));
  lines.push('');
  lines.push(MARKER);
  return lines.join('\n');
}

function collectEvents(item, issueComments, pullRequestReviews, maintainers) {
  const events = [];

  if (item.created_at && item.user?.login) {
    events.push({
      source: 'opened',
      actor: item.user.login,
      timestamp: item.created_at,
      external: !isMaintainer(item.user.login, maintainers),
      body: item.body || '',
      externalId: item.id || `${item.number}:${item.created_at}`,
      url: item.html_url || '',
    });
  }

  for (const comment of issueComments) {
    const timestamp = comment.updated_at || comment.created_at;
    if (!timestamp) continue;
    events.push({
      source: 'issue_comment',
      actor: comment.user?.login || '',
      timestamp,
      external: !isMaintainer(comment.user?.login || '', maintainers),
      body: comment.body || '',
      externalId: comment.id || `${comment.user?.login || 'unknown'}:${timestamp}`,
      url: comment.html_url || '',
    });
  }

  for (const review of pullRequestReviews) {
    const timestamp = review.submitted_at || review.submittedAt || review.created_at;
    if (!timestamp) continue;
    events.push({
      source: 'pr_review',
      actor: review.user?.login || '',
      timestamp,
      external: !isMaintainer(review.user?.login || '', maintainers),
      body: review.body || '',
      state: review.state || '',
      externalId: review.id || `${review.user?.login || 'unknown'}:${timestamp}`,
      url: review.html_url || '',
    });
  }

  return events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function formatEvent(event) {
  if (!event) return 'none';
  return `${event.source} by @${event.actor || 'unknown'} at ${event.timestamp}`;
}

function openedByMaintainer(item, maintainers) {
  return isMaintainer(item.user?.login || '', maintainers);
}

function latestAutoReply(issueComments, maintainers) {
  return latestIssueComment(
    issueComments,
    (comment) => isMaintainer(comment.user?.login || '', maintainers) && (comment.body || '').includes(MARKER)
  );
}

function defaultSkipReason(item, latestExternalActivity, maintainers, latestTaggedReply, replyToMaintainers) {
  if (latestExternalActivity) return 'already handled';
  if (openedByMaintainer(item, maintainers)) {
    if (replyToMaintainers && latestTaggedReply) return 'maintainer test already replied';
    return 'maintainer-authored thread';
  }
  return 'no external activity';
}

function requestMarker(requestId) {
  return `${REQUEST_MARKER_PREFIX} ${requestId} -->`;
}

function commentIncludesRequestId(body, requestId) {
  return trimString(body).includes(requestMarker(requestId));
}

function renderPostedComment(body, requestId) {
  const trimmed = trimString(body);
  return [trimmed, '', MARKER, requestMarker(requestId)].filter(Boolean).join('\n');
}

function buildSnapshot(item, issueComments, pullRequestReviews, details) {
  const sections = [];
  sections.push('# GitHub intake snapshot');
  sections.push('');
  sections.push(`- Repo: \`${details.repo}\``);
  sections.push(`- Item: \`${details.kind.toUpperCase()} #${item.number}\``);
  sections.push(`- URL: ${item.html_url}`);
  sections.push(`- State: ${item.state}`);
  sections.push(`- Author: @${item.user?.login || 'unknown'}`);
  sections.push(`- Author is maintainer: ${details.authorIsMaintainer ? 'yes' : 'no'}`);
  sections.push(`- Updated: ${item.updated_at}`);
  sections.push(`- Needs reply: ${details.needsReply ? 'yes' : 'no'}`);
  sections.push(`- Reply mode: ${details.replyMode}`);
  sections.push(`- Latest external activity: ${formatEvent(details.latestExternalActivity)}`);
  sections.push(`- Latest maintainer activity: ${formatEvent(details.latestMaintainerActivity)}`);
  sections.push(`- Latest tagged auto-reply: ${details.latestTaggedReplyAt || 'none'}`);
  sections.push(`- Last action: ${details.actionLabel}`);
  if (details.automation) {
    sections.push(`- Automation status: ${details.automation.status || 'none'}`);
    sections.push(`- Session: ${details.automation.sessionId || 'none'}`);
    sections.push(`- Run: ${details.automation.runId || 'none'}`);
    sections.push(`- Request ID: ${details.automation.requestId || 'none'}`);
    sections.push(`- Event key: ${details.automation.eventKey || 'none'}`);
    sections.push(`- Last error: ${details.automation.lastError || 'none'}`);
  }
  sections.push('');
  sections.push('## Title');
  sections.push('');
  sections.push(emptyText(item.title));
  sections.push('');
  sections.push('## Body');
  sections.push('');
  sections.push(emptyText(item.body));
  sections.push('');
  sections.push('## Relevant Context');
  sections.push('');
  if (details.relevantContext.length === 0) {
    sections.push('(none)');
    sections.push('');
  } else {
    for (const entry of details.relevantContext) {
      sections.push(`- \`${entry.relPath}\`${entry.heading && entry.heading !== 'Overview' ? ` / ${entry.heading}` : ''}: ${entry.text}`);
    }
    sections.push('');
  }
  sections.push('## Issue Comments');
  sections.push('');

  if (issueComments.length === 0) {
    sections.push('(none)');
    sections.push('');
  } else {
    for (const comment of issueComments) {
      sections.push(`### @${comment.user?.login || 'unknown'} — ${comment.updated_at || comment.created_at}`);
      sections.push('');
      sections.push(emptyText(comment.body));
      sections.push('');
    }
  }

  if (details.kind === 'pr') {
    sections.push('## Pull Request Reviews');
    sections.push('');
    if (pullRequestReviews.length === 0) {
      sections.push('(none)');
      sections.push('');
    } else {
      for (const review of pullRequestReviews) {
        const state = review.state ? ` [${review.state}]` : '';
        sections.push(`### @${review.user?.login || 'unknown'} — ${review.submitted_at || review.created_at}${state}`);
        sections.push('');
        sections.push(emptyText(review.body));
        sections.push('');
      }
    }
  }

  sections.push('## Auto Reply Draft');
  sections.push('');
  sections.push(details.replyBody ? details.replyBody : '(none)');
  sections.push('');
  return `${sections.join('\n')}\n`;
}

async function writeSnapshot(snapshotDir, item, content) {
  await ensureDir(snapshotDir);
  const pathname = snapshotPath(snapshotDir, item);
  await writeFile(pathname, content);
  return pathname;
}

function snapshotPath(snapshotDir, item) {
  const kind = item.pull_request ? 'pr' : 'issue';
  return join(snapshotDir, `${kind}-${item.number}.md`);
}

async function postIssueComment(repo, number, body) {
  const payloadFile = join(tmpdir(), `remotelab-github-triage-${process.pid}-${number}.json`);
  await writeFile(payloadFile, `${JSON.stringify({ body })}\n`);
  try {
    return await runGhJson(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', payloadFile]);
  } finally {
    await unlink(payloadFile).catch(() => {});
  }
}

function overlapSince(lastPollAt) {
  const parsed = Date.parse(lastPollAt || '');
  if (Number.isNaN(parsed)) return null;
  return new Date(Math.max(0, parsed - 60 * 1000)).toISOString();
}

function buildExternalTriggerId(repo, item) {
  return `github:${repo}#${item.number}`;
}

function buildSessionName(repo, item) {
  const title = trimString(item.title);
  return title ? `${repo}#${item.number} — ${title}` : `${repo}#${item.number}`;
}

function buildSessionDescription(repo, item, kind) {
  const noun = kind === 'pr' ? 'pull request' : 'issue';
  const title = trimString(item.title);
  return title
    ? `GitHub ${noun} ${repo}#${item.number}: ${title}`
    : `GitHub ${noun} ${repo}#${item.number}`;
}

function buildSessionSystemPrompt() {
  return [
    'You are replying through the RemoteLab GitHub connector.',
    'Return only the exact GitHub comment body that should be posted back to the thread.',
    'Do not add surrounding explanation, connector notes, session ids, or hidden HTML markers.',
    'Use concise, actionable maintainer language.',
    'Match the thread language when practical.',
    'If the inbound message says "Maintainer Test: yes", briefly confirm the GitHub -> RemoteLab bridge worked and mention what was processed.',
  ].join('\n');
}

function formatContextPointer(entry) {
  const suffix = entry.heading && entry.heading !== 'Overview' ? ` / ${entry.heading}` : '';
  return `- ${entry.relPath}${suffix}`;
}

function buildRemoteLabMessage({
  repo,
  item,
  kind,
  replyMode,
  classification,
  relevantContext,
  snapshotFile,
  latestExternalActivity,
  maintainerTest,
}) {
  const latestBody = trimString(latestExternalActivity?.body) || trimString(item.body);
  const latestActor = trimString(latestExternalActivity?.actor) || trimString(item.user?.login);
  const activityUrl = trimString(latestExternalActivity?.url);
  const contextPointers = relevantContext.length > 0
    ? relevantContext.map(formatContextPointer).join('\n')
    : '(none)';

  return [
    'Source: GitHub',
    `Kind: ${latestExternalActivity?.source || (maintainerTest ? 'maintainer_test' : 'opened')}`,
    `Repo: ${repo}`,
    `Thread: ${repo}#${item.number}`,
    `Thread Type: ${kind}`,
    `Title: ${emptyText(item.title)}`,
    `Thread URL: ${item.html_url}`,
    `Actor: @${latestActor || 'unknown'}`,
    `Activity At: ${latestExternalActivity?.timestamp || item.updated_at || item.created_at || nowIso()}`,
    activityUrl ? `Activity URL: ${activityUrl}` : '',
    `Reply Mode: ${replyMode}`,
    `Maintainer Test: ${maintainerTest ? 'yes' : 'no'}`,
    `Classification: ${classification}`,
    `Snapshot File: ${snapshotFile}`,
    '',
    'Latest user message:',
    emptyText(latestBody),
    '',
    'Relevant local context pointers:',
    contextPointers,
    '',
    'Task:',
    '- Inspect the repo and the snapshot file as needed.',
    '- Write the exact GitHub comment body to post back to the thread.',
    '- Be concrete, concise, and helpful.',
    '- Do not mention hidden connector/session/run implementation details.',
  ].filter(Boolean).join('\n');
}

function buildEventKey(repo, item, latestExternalActivity, replyMode) {
  const safeRepo = sanitizeRepo(repo);
  const stableTimestamp = item.updated_at || item.created_at || nowIso();
  if (replyMode === 'forced_draft') {
    return `github:${safeRepo}:${item.number}:forced_draft:${sanitizeIdPart(stableTimestamp)}`;
  }
  if (replyMode === 'maintainer_test') {
    return `github:${safeRepo}:${item.number}:maintainer_test:${sanitizeIdPart(stableTimestamp)}`;
  }
  const source = sanitizeIdPart(latestExternalActivity?.source || 'opened');
  const activityId = sanitizeIdPart(latestExternalActivity?.externalId || latestExternalActivity?.timestamp || stableTimestamp);
  return `github:${safeRepo}:${item.number}:${source}:${activityId}`;
}

function buildRequestId(eventKey) {
  return eventKey;
}

function findPublishedComment(issueComments, requestId) {
  return issueComments.find((comment) => commentIncludesRequestId(comment.body || '', requestId)) || null;
}

async function loadAssistantReply(baseUrl, sessionId, runId, requestId, cookie) {
  const eventsResult = await requestJson(baseUrl, `/api/sessions/${sessionId}/events`, { cookie });
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`);
  }

  const candidate = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: (event) => (
      (runId && event.runId === runId)
      || (requestId && event.requestId === requestId)
    ),
    hydrate: async (event) => {
      const bodyResult = await requestJson(baseUrl, `/api/sessions/${sessionId}/events/${event.seq}/body`, { cookie });
      if (!bodyResult.response.ok || bodyResult.json?.body?.value === undefined) {
        return event;
      }
      return {
        ...event,
        content: bodyResult.json.body.value,
        bodyLoaded: true,
      };
    },
  });
  if (!candidate) return null;

  return candidate;
}

async function submitInboundUpdate(
  options,
  item,
  kind,
  replyMode,
  classification,
  relevantContext,
  latestExternalActivity,
  snapshotFile,
  maintainerTest,
  cookie,
) {
  const externalTriggerId = buildExternalTriggerId(options.repo, item);
  const eventKey = buildEventKey(options.repo, item, latestExternalActivity, replyMode);
  const requestId = buildRequestId(eventKey);

  const sessionPayload = {
    folder: options.sessionFolder,
    tool: options.sessionTool,
    name: buildSessionName(options.repo, item),
    sourceId: 'github',
    sourceName: 'GitHub',
    group: 'GitHub',
    description: buildSessionDescription(options.repo, item, kind),
    systemPrompt: buildSessionSystemPrompt(),
    externalTriggerId,
  };
  const createResult = await requestJson(options.chatBaseUrl, '/api/sessions', {
    method: 'POST',
    cookie,
    body: sessionPayload,
  });
  if (!createResult.response.ok || !createResult.json?.session?.id) {
    throw new Error(createResult.json?.error || createResult.text || `Failed to create session (${createResult.response.status})`);
  }

  const session = createResult.json.session;
  const messagePayload = {
    requestId,
    text: buildRemoteLabMessage({
      repo: options.repo,
      item,
      kind,
      replyMode,
      classification,
      relevantContext,
      snapshotFile,
      latestExternalActivity,
      maintainerTest,
    }),
    tool: options.sessionTool,
    thinking: options.thinking === true,
  };
  if (trimString(options.model)) messagePayload.model = trimString(options.model);
  if (trimString(options.effort)) messagePayload.effort = trimString(options.effort);

  const submitResult = await requestJson(options.chatBaseUrl, `/api/sessions/${session.id}/messages`, {
    method: 'POST',
    cookie,
    body: messagePayload,
  });
  if (![200, 202].includes(submitResult.response.status) || !submitResult.json?.run?.id) {
    throw new Error(submitResult.json?.error || submitResult.text || `Failed to submit session message (${submitResult.response.status})`);
  }

  return {
    status: 'processing_for_reply',
    sessionId: session.id,
    runId: submitResult.json.run.id,
    requestId,
    eventKey,
    externalTriggerId,
    publishRequested: options.post === true,
    replyMode,
    duplicate: submitResult.json?.duplicate === true,
    submittedAt: nowIso(),
    updatedAt: nowIso(),
    lastError: null,
  };
}

function shouldPublishReply(options, automation) {
  if (!automation) return false;
  if (automation.publishRequested === true) return true;
  return options.post === true && automation.replyMode !== 'forced_draft';
}

async function reconcilePendingItem(options, itemState, cookie) {
  const automation = itemState?.automation;
  if (!automation || !['processing_for_reply', 'reply_ready', 'reply_failed'].includes(automation.status)) {
    return null;
  }
  if (!automation.sessionId || !automation.runId || !automation.requestId) {
    return {
      automation: {
        ...(automation || {}),
        status: 'reply_failed',
        lastError: 'missing automation metadata',
        updatedAt: nowIso(),
      },
      action: { mode: 'failed', reason: 'missing automation metadata' },
      replyBody: trimString(automation?.replyBody),
    };
  }

  const runResult = await requestJson(options.chatBaseUrl, `/api/runs/${automation.runId}`, { cookie });
  if (!runResult.response.ok || !runResult.json?.run) {
    throw new Error(runResult.json?.error || runResult.text || `Failed to load run ${automation.runId}`);
  }

  const run = runResult.json.run;
  if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
    return {
      automation: { ...automation, updatedAt: nowIso() },
      action: { mode: 'processing', reason: `run ${run.state}` },
      replyBody: trimString(automation.replyBody),
    };
  }

  if (run.state !== 'completed') {
    return {
      automation: {
        ...automation,
        status: 'reply_failed',
        lastError: `run ${run.state}`,
        updatedAt: nowIso(),
      },
      action: { mode: 'failed', reason: `run ${run.state}` },
      replyBody: trimString(automation.replyBody),
    };
  }

  const replyEvent = await loadAssistantReply(
    options.chatBaseUrl,
    automation.sessionId,
    automation.runId,
    automation.requestId,
    cookie,
  );
  const replyBody = trimString(replyEvent?.content);
  if (!replyBody) {
    return {
      automation: {
        ...automation,
        status: 'reply_failed',
        lastError: 'no assistant message found for completed run',
        updatedAt: nowIso(),
      },
      action: { mode: 'failed', reason: 'no assistant message found for completed run' },
      replyBody: trimString(automation.replyBody),
    };
  }

  const readyAutomation = {
    ...automation,
    status: 'reply_ready',
    replyBody,
    replySeq: replyEvent?.seq || null,
    readyAt: automation.readyAt || nowIso(),
    lastError: null,
    updatedAt: nowIso(),
  };

  if (!shouldPublishReply(options, readyAutomation)) {
    return {
      automation: readyAutomation,
      action: { mode: 'dry-run', reason: 'reply ready' },
      replyBody,
    };
  }

  const existingComment = findPublishedComment(await fetchIssueComments(options.repo, itemState.number), automation.requestId);
  if (existingComment) {
    return {
      automation: {
        ...readyAutomation,
        status: 'reply_sent',
        publishRequested: true,
        commentUrl: existingComment.html_url || itemState.url,
        publishedAt: existingComment.updated_at || existingComment.created_at || nowIso(),
        updatedAt: nowIso(),
      },
      action: { mode: 'posted', commentUrl: existingComment.html_url || itemState.url },
      replyBody,
    };
  }

  const comment = await postIssueComment(options.repo, itemState.number, renderPostedComment(replyBody, automation.requestId));
  return {
    automation: {
      ...readyAutomation,
      status: 'reply_sent',
      publishRequested: true,
      commentUrl: comment.html_url || itemState.url,
      publishedAt: nowIso(),
      updatedAt: nowIso(),
    },
    action: { mode: 'posted', commentUrl: comment.html_url || itemState.url },
    replyBody,
  };
}

function actionSummary(action) {
  if (action.mode === 'posted') return `posted at ${action.commentUrl}`;
  if (action.mode === 'submitted') return action.duplicate === true
    ? `reused existing run ${action.runId}`
    : `submitted to RemoteLab run ${action.runId}`;
  if (action.mode === 'processing') return action.reason || 'waiting for RemoteLab run';
  if (action.mode === 'dry-run') return 'RemoteLab reply ready (dry-run)';
  if (action.mode === 'failed') return action.reason || 'automation failed';
  return action.reason;
}

function statusLabelForAction(action, needsReply) {
  if (!action) return needsReply ? 'pending' : 'synced';
  if (action.mode === 'posted') return 'posted';
  if (action.mode === 'submitted') return action.duplicate === true ? 'reused-run' : 'submitted';
  if (action.mode === 'processing') return action.reason || 'processing';
  if (action.mode === 'dry-run') return 'draft-ready';
  if (action.mode === 'failed') return `failed (${action.reason || 'unknown error'})`;
  return needsReply ? action.mode : `synced (${action.reason})`;
}

async function reconcilePendingItems(options, state, resultMap, getCookie) {
  for (const itemState of Object.values(state.items || {})) {
    const automation = itemState?.automation;
    if (!automation || !['processing_for_reply', 'reply_ready', 'reply_failed'].includes(automation.status)) {
      continue;
    }

    try {
      const outcome = await reconcilePendingItem(options, itemState, await getCookie());
      if (!outcome) continue;
      itemState.automation = outcome.automation;
      itemState.lastAction = outcome.action;
      resultMap.set(itemState.number, {
        number: itemState.number,
        kind: itemState.kind,
        needsReply: true,
        action: outcome.action,
        snapshotFile: itemState.snapshotFile,
        title: itemState.title,
      });
      if (outcome.action.mode !== 'processing' || options.verbose) {
        console.log(`[triage] reconcile ${String(itemState.kind || 'issue').toUpperCase()} #${itemState.number} ${statusLabelForAction(outcome.action, true)}`);
      }
      if (outcome.action.mode === 'dry-run' && !options.post && outcome.replyBody) {
        console.log(`\n[triage] Draft for #${itemState.number}:\n${outcome.replyBody}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      itemState.automation = {
        ...(itemState.automation || {}),
        status: 'reply_failed',
        lastError: message,
        updatedAt: nowIso(),
      };
      itemState.lastAction = { mode: 'failed', reason: message };
      resultMap.set(itemState.number, {
        number: itemState.number,
        kind: itemState.kind,
        error: message,
        title: itemState.title,
        action: itemState.lastAction,
        snapshotFile: itemState.snapshotFile,
      });
      console.error(`[triage] Failed to reconcile ${String(itemState.kind || 'issue').toUpperCase()} #${itemState.number}: ${message}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.chatBaseUrl = normalizeBaseUrl(options.chatBaseUrl);
  const paths = resolvePaths(options.repo, options);
  const state = await readJson(paths.stateFile, { repo: options.repo, maintainers: [], lastPollAt: null, items: {} });
  if (!state.items || typeof state.items !== 'object') state.items = {};
  const maintainers = await normalizeMaintainers(options.maintainers || (Array.isArray(state.maintainers) ? state.maintainers.join(',') : ''));
  const maintainersLookup = maintainerSet(maintainers);
  const runStartedAt = new Date().toISOString();
  const sinceIso = overlapSince(state.lastPollAt) || new Date(Date.now() - options.bootstrapHours * 60 * 60 * 1000).toISOString();
  const items = await fetchItems(options.repo, sinceIso, options.limit, options.onlyNumbers);
  const scopeLabel = options.onlyNumbers.length > 0 ? ` only=${options.onlyNumbers.join(',')}` : '';

  console.log(`[triage] repo=${options.repo} mode=${options.post ? 'post' : 'dry-run'} since=${sinceIso} items=${items.length}${scopeLabel}`);

  const resultMap = new Map();
  let cookiePromise = null;
  const getCookie = async () => {
    if (!cookiePromise) {
      cookiePromise = (async () => loginWithToken(options.chatBaseUrl, await readOwnerToken()))();
    }
    try {
      return await cookiePromise;
    } catch (error) {
      cookiePromise = null;
      throw error;
    }
  };

  await reconcilePendingItems(options, state, resultMap, getCookie);

  for (const item of items) {
    const kind = item.pull_request ? 'pr' : 'issue';
    try {
      const issueComments = (await fetchIssueComments(options.repo, item.number)).slice(-options.maxComments);
      const pullRequestReviews = item.pull_request ? await fetchPullRequestReviews(options.repo, item.number) : [];
      const events = collectEvents(item, issueComments, pullRequestReviews, maintainersLookup);
      const latestExternalActivity = latestEvent(events, (event) => event.external);
      const latestMaintainerActivity = latestEvent(events, (event) => !event.external && event.source !== 'opened');
      const taggedReply = latestAutoReply(issueComments, maintainersLookup);
      const externalNeedsReply = !!latestExternalActivity && (
        !latestMaintainerActivity || Date.parse(latestExternalActivity.timestamp) > Date.parse(latestMaintainerActivity.timestamp)
      );
      const followUp = !!latestExternalActivity && !!latestMaintainerActivity
        && Date.parse(latestExternalActivity.timestamp) > Date.parse(latestMaintainerActivity.timestamp);
      const maintainerTestNeedsReply = options.replyToMaintainers
        && openedByMaintainer(item, maintainersLookup)
        && !latestExternalActivity
        && !taggedReply;
      const previewNeedsReply = options.forceDraft;
      const needsReply = previewNeedsReply || externalNeedsReply || maintainerTestNeedsReply;
      const replyMode = previewNeedsReply
        ? 'forced_draft'
        : (externalNeedsReply
          ? (followUp ? 'followup_triage' : 'initial_triage')
          : (maintainerTestNeedsReply ? 'maintainer_test' : 'none'));
      const language = detectLanguage(
        item.title,
        item.body,
        latestExternalActivity?.body || '',
        issueComments.map((comment) => comment.body || '').join('\n'),
      );
      const threadText = [item.body || '', issueComments.map((comment) => comment.body || '').join('\n')].join('\n');
      const classification = classifyThread(item, threadText);
      const relevantContext = await findRelevantContext(item, issueComments, latestExternalActivity);
      const existingState = state.items[String(item.number)] || {};
      let automation = existingState.automation && typeof existingState.automation === 'object'
        ? { ...existingState.automation }
        : null;
      const eventKey = needsReply ? buildEventKey(options.repo, item, latestExternalActivity, replyMode) : '';

      let action = {
        mode: 'skipped',
        reason: defaultSkipReason(item, latestExternalActivity, maintainersLookup, taggedReply, options.replyToMaintainers),
      };

      const preSnapshotDetails = {
        repo: options.repo,
        kind,
        authorIsMaintainer: openedByMaintainer(item, maintainersLookup),
        needsReply,
        replyMode,
        latestExternalActivity,
        latestMaintainerActivity,
        latestTaggedReplyAt: taggedReply?.updated_at || taggedReply?.created_at || null,
        actionLabel: needsReply ? 'preparing RemoteLab submission' : actionSummary(action),
        relevantContext,
        replyBody: trimString(automation?.replyBody),
        automation,
      };
      const snapshotFile = await writeSnapshot(
        paths.snapshotDir,
        item,
        buildSnapshot(item, issueComments, pullRequestReviews, preSnapshotDetails),
      );

      if (needsReply) {
        const sameEvent = automation?.eventKey === eventKey;
        if (sameEvent && automation?.status === 'reply_sent') {
          action = { mode: 'posted', commentUrl: automation.commentUrl || item.html_url };
        } else if (sameEvent && ['processing_for_reply', 'reply_ready'].includes(automation?.status)) {
          action = automation.status === 'reply_ready'
            ? { mode: 'processing', reason: 'reply ready pending publish' }
            : { mode: 'processing', reason: 'awaiting RemoteLab run' };
        } else if (sameEvent && automation?.status === 'reply_failed') {
          action = { mode: 'failed', reason: automation.lastError || 'previous automation failed' };
        } else {
          automation = await submitInboundUpdate(
            options,
            item,
            kind,
            replyMode,
            classification,
            relevantContext,
            latestExternalActivity,
            snapshotFile,
            maintainerTestNeedsReply,
            await getCookie(),
          );
          action = {
            mode: 'submitted',
            sessionId: automation.sessionId,
            runId: automation.runId,
            duplicate: automation.duplicate === true,
            reason: automation.duplicate === true ? 'reused existing run' : 'submitted to RemoteLab',
          };
        }
      }

      const snapshotContent = buildSnapshot(item, issueComments, pullRequestReviews, {
        repo: options.repo,
        kind,
        authorIsMaintainer: openedByMaintainer(item, maintainersLookup),
        needsReply,
        replyMode,
        latestExternalActivity,
        latestMaintainerActivity,
        latestTaggedReplyAt: taggedReply?.updated_at || taggedReply?.created_at || null,
        actionLabel: actionSummary(action),
        relevantContext,
        replyBody: trimString(automation?.replyBody),
        automation,
      });
      await writeSnapshot(paths.snapshotDir, item, snapshotContent);

      state.items[String(item.number)] = {
        ...existingState,
        number: item.number,
        kind,
        title: item.title,
        url: item.html_url,
        state: item.state,
        authorIsMaintainer: openedByMaintainer(item, maintainersLookup),
        updatedAt: item.updated_at,
        latestExternalActivityAt: latestExternalActivity?.timestamp || null,
        latestMaintainerActivityAt: latestMaintainerActivity?.timestamp || null,
        latestTaggedReplyAt: taggedReply?.updated_at || taggedReply?.created_at || null,
        needsReply,
        replyMode,
        classification,
        language,
        relevantContext: relevantContext.map((entry) => ({ relPath: entry.relPath, heading: entry.heading })),
        lastAction: action,
        snapshotFile,
        automation,
      };

      resultMap.set(item.number, { number: item.number, kind, needsReply, action, snapshotFile, title: item.title });

      const statusLabel = statusLabelForAction(action, needsReply);
      console.log(`[triage] ${kind.toUpperCase()} #${item.number} ${statusLabel} -> ${snapshotFile}`);
      if (options.verbose) {
        console.log(`[triage] external=${formatEvent(latestExternalActivity)} maintainer=${formatEvent(latestMaintainerActivity)} tagged=${taggedReply ? (taggedReply.updated_at || taggedReply.created_at) : 'none'} classification=${classification} language=${language}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existingState = state.items[String(item.number)] || {};
      state.items[String(item.number)] = {
        ...existingState,
        number: item.number,
        kind,
        title: item.title,
        url: item.html_url,
        state: item.state,
        updatedAt: item.updated_at,
        lastAction: { mode: 'failed', reason: message },
        snapshotFile: existingState.snapshotFile || snapshotPath(paths.snapshotDir, item),
        automation: existingState.automation,
      };
      resultMap.set(item.number, { number: item.number, kind, error: message, title: item.title, action: { mode: 'failed', reason: message } });
      console.error(`[triage] Failed on ${kind.toUpperCase()} #${item.number}: ${message}`);
    }
  }

  await reconcilePendingItems(options, state, resultMap, getCookie);

  state.repo = options.repo;
  if (options.onlyNumbers.length === 0) {
    state.maintainers = maintainers;
    state.lastPollAt = runStartedAt;
  }
  await writeJson(paths.stateFile, state);

  const results = Array.from(resultMap.values());
  const postedCount = results.filter((entry) => entry.action?.mode === 'posted').length;
  const submittedCount = results.filter((entry) => entry.action?.mode === 'submitted').length;
  const processingCount = results.filter((entry) => entry.action?.mode === 'processing').length;
  const draftCount = results.filter((entry) => entry.action?.mode === 'dry-run').length;
  const errorCount = results.filter((entry) => entry.error || entry.action?.mode === 'failed').length;
  console.log(`[triage] done posted=${postedCount} submitted=${submittedCount} processing=${processingCount} drafts=${draftCount} errors=${errorCount} state=${paths.stateFile}`);
  if (errorCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[triage] fatal: ${message}`);
  process.exitCode = 1;
});

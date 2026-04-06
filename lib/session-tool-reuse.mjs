import { access, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, join } from 'path';

const HOME = homedir();

const SHELL_WRAPPER_RE = /^(?:bash|zsh|sh)\s+-lc\s+([\s\S]+)$/i;
const GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'bash', 'cat', 'cd', 'code', 'date', 'dev', 'echo', 'elif', 'else', 'env', 'eof',
  'esac', 'fi', 'find', 'for', 'function', 'home', 'if', 'in', 'jq', 'json', 'lc', 'ls', 'md', 'mjs',
  'node', 'null', 'or', 'os', 'pipefail', 'printf', 'project', 'projects', 'pwd', 'rg', 'sed', 'set',
  'sh', 'shell', 'then', 'tmp', 'true', 'txt', 'users', 'utf8', 'var', 'while', 'with', 'zsh',
  'command', 'description', 'file', 'file_path', 'path', 'input', 'output', 'content', 'old_string',
  'new_string', 'insert_line', 'start_line', 'end_line', 'view_range', 'replace_all', 'recursive',
  'pattern', 'include', 'exclude', 'offset', 'limit', 'line', 'lines', 'range', 'result', 'num', 'id',
  'time', 'user', 'heredoc', 'ba', 'la', 'print', 'maxdepth',
]);
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function',
  'export', 'local', 'time', 'command', 'builtin', 'noglob', 'source', '.', '[[', ']', '[', 'test',
]);
const NEUTRAL_COMMANDS = new Set(['set', 'printf', 'echo', 'true', 'false', 'time', 'command', 'builtin']);
const READ_ONLY_COMMANDS = new Set([
  'cat', 'sed', 'rg', 'ls', 'find', 'nl', 'head', 'tail', 'pwd', 'which', 'stat', 'wc', 'sort', 'uniq',
  'cut', 'grep', 'ag', 'fd', 'tree', 'jq', 'realpath', 'dirname', 'basename', 'readlink', 'git',
]);
const WRITE_COMMANDS = new Set([
  'apply_patch', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'rm', 'rmdir', 'tee', 'perl', 'python',
  'python3', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'git', 'curl', 'wget', 'gh', 'scp', 'rsync', 'tar',
  'zip', 'unzip', 'make', 'go', 'cargo', 'rustc', 'javac', 'java', 'swift', 'xcodebuild', 'pod',
]);
const BOOTSTRAP_TOKENS = new Set([
  'bootstrap', 'bootstrap.md', 'global', 'global.md', 'skills', 'skills.md', 'projects', 'projects.md',
  'agents', 'agents.md', 'system', 'system.md', 'self-review.md',
]);

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) {
    throw new Error(`Invalid date: ${dateString}`);
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, -1);
}

function defaultAnchorDate() {
  const anchor = new Date();
  anchor.setDate(anchor.getDate() - 1);
  return startOfDay(anchor);
}

export function resolveReviewWindow({ date, days = 1 } = {}) {
  const anchorDate = date ? parseLocalDate(date) : defaultAnchorDate();
  const normalizedDays = Number.isInteger(days) && days >= 1 ? days : 1;
  const anchorStart = startOfDay(anchorDate);
  const rangeStart = new Date(anchorStart);
  rangeStart.setDate(rangeStart.getDate() - (normalizedDays - 1));
  const rangeEnd = endOfDay(anchorDate);
  return {
    anchorDate: formatLocalDate(anchorStart),
    days: normalizedDays,
    startDate: formatLocalDate(rangeStart),
    endDate: formatLocalDate(anchorStart),
    startMs: rangeStart.getTime(),
    endMs: rangeEnd.getTime(),
    label: normalizedDays === 1
      ? formatLocalDate(anchorStart)
      : `${formatLocalDate(rangeStart)} → ${formatLocalDate(anchorStart)}`,
  };
}

function unwrapShellInput(input) {
  const raw = String(input || '').trim();
  const match = raw.match(SHELL_WRAPPER_RE);
  if (!match) return raw;
  let unwrapped = match[1].trim();
  if (
    (unwrapped.startsWith('"') && unwrapped.endsWith('"'))
    || (unwrapped.startsWith("'") && unwrapped.endsWith("'"))
  ) {
    unwrapped = unwrapped.slice(1, -1);
  }
  return unwrapped
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function stripHereDocs(text) {
  return String(text || '').replace(/<<-?['"]?([A-Za-z0-9_]+)['"]?[^\n]*\n[\s\S]*?\n\1/g, '<<HEREDOC');
}

function normalizeFreeText(text) {
  return String(text || '')
    .replaceAll(HOME, '<home>')
    .replace(/~\//g, '<home>/')
    .replace(/\/Users\/[^/\s'"`]+/g, '<user>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<time>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCommands(shellText) {
  const segments = String(shellText || '').split(/&&|\|\||;|\n+/);
  const commands = [];
  for (const rawSegment of segments) {
    let segment = rawSegment.trim();
    if (!segment) continue;
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/g, '');
    const tokens = segment.match(/[A-Za-z0-9_./:-]+/g) || [];
    let command = '';
    for (const token of tokens) {
      const candidate = token.split('/').pop();
      if (!candidate || candidate === '-' || candidate.startsWith('--')) continue;
      if (candidate.includes('=') && !candidate.startsWith('./')) continue;
      if (SHELL_KEYWORDS.has(candidate)) continue;
      if (/^\d+$/.test(candidate)) continue;
      command = candidate;
      break;
    }
    if (command) commands.push(command.toLowerCase());
  }
  return commands;
}

function tokenizeText(text) {
  const normalized = normalizeFreeText(text)
    .toLowerCase()
    .replace(/[{}()[\],|]/g, ' ')
    .replace(/[/:]/g, ' ')
    .replace(/[^a-z0-9_.-]+/g, ' ');
  const rawTokens = normalized.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const token of rawTokens) {
    const cleaned = token.replace(/^[._-]+|[._-]+$/g, '');
    if (!cleaned) continue;
    if (cleaned === '<num>' || cleaned === '<id>' || cleaned === '<date>' || cleaned === '<time>') continue;
    if (cleaned.length <= 1) continue;
    if (/^[0-9]+$/.test(cleaned)) continue;
    if (GENERIC_TOKENS.has(cleaned)) continue;
    tokens.push(cleaned);
  }
  return tokens;
}

function uniqueInOrder(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function inferReadOnly(commands) {
  if (!commands.length) return false;
  let sawReadOnly = false;
  for (const command of commands) {
    if (WRITE_COMMANDS.has(command)) return false;
    if (READ_ONLY_COMMANDS.has(command)) {
      sawReadOnly = true;
      continue;
    }
    if (NEUTRAL_COMMANDS.has(command)) continue;
    return false;
  }
  return sawReadOnly;
}

function setFrom(items) {
  return new Set(items || []);
}

function jaccardSimilarity(left, right) {
  const leftSet = left instanceof Set ? left : setFrom(left);
  const rightSet = right instanceof Set ? right : setFrom(right);
  if (!leftSet.size && !rightSet.size) return 1;
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return overlap / (leftSet.size + rightSet.size - overlap);
}

function summarizeSession(meta, sessionId) {
  return {
    sessionId,
    sessionName: meta?.name || '(unnamed session)',
    sessionTool: meta?.tool || '',
    sessionFolder: meta?.folder || '',
  };
}

function buildCallRecord(event, sessionMeta, sessionId) {
  const toolName = (String(event.toolName || 'unknown').trim().toLowerCase()) || 'unknown';
  const rawInput = typeof event.toolInput === 'string'
    ? event.toolInput
    : JSON.stringify(event.toolInput ?? {}, null, 2);
  if (toolName === 'bash') {
    const shellText = stripHereDocs(unwrapShellInput(rawInput));
    const commands = uniqueInOrder(extractCommands(shellText));
    const tokens = uniqueInOrder(tokenizeText(shellText));
    return {
      ...summarizeSession(sessionMeta, sessionId),
      timestamp: Number(event.timestamp) || 0,
      toolName,
      toolInput: rawInput,
      normalizedInput: normalizeFreeText(shellText),
      commands,
      commandShape: commands.slice(0, 6).join(' -> '),
      tokens,
      tokenSet: new Set(tokens),
      readOnly: inferReadOnly(commands),
    };
  }

  const normalizedInput = normalizeFreeText(rawInput);
  const tokens = uniqueInOrder(tokenizeText(normalizedInput));
  const commands = [toolName.toLowerCase()];
  return {
    ...summarizeSession(sessionMeta, sessionId),
    timestamp: Number(event.timestamp) || 0,
    toolName,
    toolInput: rawInput,
    normalizedInput,
    commands,
    commandShape: commands.join(' -> '),
    tokens,
    tokenSet: new Set(tokens),
    readOnly: false,
  };
}

function isMaintenanceSession(meta) {
  const name = String(meta?.name || '').trim();
  return /^🔧\s+(daily|weekly)\s+review\b/i.test(name);
}

async function collectWindowedEvents({ sessionsFile, historyDir, startMs, endMs, includeMaintenance = false }) {
  const rawSessions = await safeReadJson(sessionsFile, []);
  const sessionList = Array.isArray(rawSessions) ? rawSessions : Object.values(rawSessions || {});
  const sessionMap = new Map(sessionList.map((session) => [session.id, session]));
  const calls = [];
  let excludedSessions = 0;
  const excludedSessionIds = new Set();

  if (!await pathExists(historyDir)) {
    return { calls, excludedSessions };
  }

  for (const fileName of await readdir(historyDir)) {
    if (!fileName.endsWith('.json')) continue;
    const sessionId = basename(fileName, '.json');
    const sessionMeta = sessionMap.get(sessionId) || { id: sessionId };
    if (!includeMaintenance && isMaintenanceSession(sessionMeta)) {
      if (!excludedSessionIds.has(sessionId)) {
        excludedSessionIds.add(sessionId);
        excludedSessions += 1;
      }
      continue;
    }
    const events = await safeReadJson(join(historyDir, fileName), []);
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      const timestamp = Number(event?.timestamp) || 0;
      if (timestamp < startMs || timestamp > endMs) continue;
      if (event.type === 'tool_use') {
        calls.push(buildCallRecord(event, sessionMeta, sessionId));
      }
    }
  }

  calls.sort((left, right) => left.timestamp - right.timestamp || left.sessionId.localeCompare(right.sessionId));
  return { calls, excludedSessions };
}

function topEntries(counterMap, limit) {
  return [...counterMap.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function createCluster(call, index) {
  const tokenCounts = new Map();
  for (const token of call.tokens) {
    tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }
  const commandCounts = new Map();
  for (const command of call.commands) {
    commandCounts.set(command, (commandCounts.get(command) || 0) + 1);
  }
  return {
    id: `cluster-${String(index + 1).padStart(2, '0')}`,
    toolName: call.toolName,
    calls: [call],
    sessionIds: new Set([call.sessionId]),
    tokenCounts,
    commandCounts,
    readOnlyCount: call.readOnly ? 1 : 0,
    examples: [call],
  };
}

function clusterTokens(cluster, limit = 12) {
  return topEntries(cluster.tokenCounts, limit).map((entry) => entry.value);
}

function clusterCommands(cluster, limit = 6) {
  return topEntries(cluster.commandCounts, limit).map((entry) => entry.value);
}

function clusterSimilarity(cluster, call) {
  if (cluster.toolName !== call.toolName) return 0;
  const tokenScore = jaccardSimilarity(clusterTokens(cluster, 12), call.tokenSet);
  const commandScore = jaccardSimilarity(clusterCommands(cluster, 6), new Set(call.commands));
  const sameShape = call.commandShape && clusterCommands(cluster, 4).join(' -> ') === call.commandShape;
  const score = (tokenScore * 0.65) + (commandScore * 0.35) + (sameShape ? 0.15 : 0);
  return Math.min(1, score);
}

function addCallToCluster(cluster, call) {
  cluster.calls.push(call);
  cluster.sessionIds.add(call.sessionId);
  for (const token of call.tokens) {
    cluster.tokenCounts.set(token, (cluster.tokenCounts.get(token) || 0) + 1);
  }
  for (const command of call.commands) {
    cluster.commandCounts.set(command, (cluster.commandCounts.get(command) || 0) + 1);
  }
  if (call.readOnly) cluster.readOnlyCount += 1;
  if (cluster.examples.length < 3) {
    if (!cluster.examples.some((example) => example.normalizedInput === call.normalizedInput)) {
      cluster.examples.push(call);
    }
  }
}

function buildClusters(calls) {
  const clusters = [];
  for (const call of calls) {
    let bestCluster = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = clusterSimilarity(cluster, call);
      if (score > bestScore) {
        bestCluster = cluster;
        bestScore = score;
      }
    }
    if (bestCluster && bestScore >= 0.58) {
      addCallToCluster(bestCluster, call);
      continue;
    }
    clusters.push(createCluster(call, clusters.length));
  }
  return clusters;
}

function inferAbstractionHint(cluster) {
  const commands = clusterCommands(cluster, 6);
  const tokens = clusterTokens(cluster, 8);
  const readOnly = cluster.readOnlyCount === cluster.calls.length;
  const averageSteps = cluster.calls.reduce((sum, call) => sum + call.commands.length, 0) / cluster.calls.length;

  if (readOnly && (averageSteps >= 4 || tokens.some((token) => BOOTSTRAP_TOKENS.has(token)))) {
    return 'startup macro / prompt template';
  }
  if (readOnly) {
    return 'prompt snippet / text reuse';
  }
  if (commands.some((command) => WRITE_COMMANDS.has(command) || ['apply_patch', 'python', 'python3', 'node', 'git'].includes(command))) {
    return 'script / helper tool';
  }
  if (averageSteps >= 3) {
    return 'workflow skill';
  }
  return 'helper pattern';
}

function clusterLabel(cluster) {
  const commands = clusterCommands(cluster, 4);
  const tokens = clusterTokens(cluster, 6).filter((token) => !commands.includes(token));
  const commandLabel = commands.length ? commands.join(' → ') : cluster.toolName;
  return tokens.length
    ? `${cluster.toolName}: ${commandLabel} (${tokens.slice(0, 3).join(', ')})`
    : `${cluster.toolName}: ${commandLabel}`;
}

function clusterShortLabel(cluster) {
  const commands = clusterCommands(cluster, 2);
  const tokens = clusterTokens(cluster, 4).filter((token) => !commands.includes(token));
  if (!commands.length) return cluster.toolName;
  if (!tokens.length) return commands.join(' → ');
  return `${commands.join(' → ')} · ${tokens.slice(0, 2).join('/')}`;
}

function buildRepeatedSequences(clusters) {
  const clusterByCall = new Map();
  for (const cluster of clusters) {
    for (const call of cluster.calls) {
      clusterByCall.set(call, cluster);
    }
  }

  const bySession = new Map();
  for (const cluster of clusters) {
    for (const call of cluster.calls) {
      if (!bySession.has(call.sessionId)) bySession.set(call.sessionId, []);
      bySession.get(call.sessionId).push({ call, cluster });
    }
  }

  const sequenceMap = new Map();
  for (const [sessionId, entries] of bySession.entries()) {
    entries.sort((left, right) => left.call.timestamp - right.call.timestamp);
    const compact = [];
    for (const entry of entries) {
      if (compact.at(-1)?.cluster.id === entry.cluster.id) continue;
      compact.push(entry);
    }
    for (let length = 2; length <= 4; length += 1) {
      for (let index = 0; index <= compact.length - length; index += 1) {
        const slice = compact.slice(index, index + length);
        const ids = slice.map((entry) => entry.cluster.id);
        const key = ids.join('>');
        if (!sequenceMap.has(key)) {
          sequenceMap.set(key, {
            clusterIds: ids,
            sessionIds: new Set(),
            occurrences: 0,
            examples: [],
          });
        }
        const record = sequenceMap.get(key);
        record.occurrences += 1;
        record.sessionIds.add(sessionId);
        if (record.examples.length < 3) {
          record.examples.push({
            sessionId,
            sessionName: slice[0].call.sessionName,
            labels: slice.map((entry) => clusterShortLabel(entry.cluster)),
          });
        }
      }
    }
  }

  const deduped = new Map();

  for (const sequence of [...sequenceMap.values()]
    .filter((sequence) => sequence.sessionIds.size >= 2)
    .map((sequence) => ({
      ...sequence,
      sessionCount: sequence.sessionIds.size,
      label: sequence.clusterIds
        .map((clusterId) => clusterShortLabel(clusters.find((cluster) => cluster.id === clusterId)))
        .join(' → '),
      abstractionHint: sequence.clusterIds.length >= 3 ? 'workflow skill' : 'prompt / checklist reuse',
    }))
  ) {
    const existing = deduped.get(sequence.label);
    if (
      !existing
      || sequence.sessionCount > existing.sessionCount
      || (sequence.sessionCount === existing.sessionCount && sequence.clusterIds.length > existing.clusterIds.length)
      || (sequence.sessionCount === existing.sessionCount && sequence.clusterIds.length === existing.clusterIds.length && sequence.occurrences > existing.occurrences)
    ) {
      deduped.set(sequence.label, sequence);
    }
  }

  return [...deduped.values()].sort((left, right) => (
    right.sessionCount - left.sessionCount
    || right.clusterIds.length - left.clusterIds.length
    || right.occurrences - left.occurrences
  ));
}

function serializeCluster(cluster) {
  return {
    id: cluster.id,
    label: clusterLabel(cluster),
    shortLabel: clusterShortLabel(cluster),
    toolName: cluster.toolName,
    occurrences: cluster.calls.length,
    sessionCount: cluster.sessionIds.size,
    readOnly: cluster.readOnlyCount === cluster.calls.length,
    abstractionHint: inferAbstractionHint(cluster),
    topCommands: clusterCommands(cluster, 6),
    topTokens: clusterTokens(cluster, 8),
    exampleSessions: uniqueInOrder(cluster.calls.map((call) => call.sessionName)).slice(0, 4),
    examples: cluster.examples.slice(0, 3).map((call) => ({
      sessionId: call.sessionId,
      sessionName: call.sessionName,
      input: call.toolInput.slice(0, 280),
    })),
  };
}

export async function analyzeSessionToolReuse({ sessionsFile, historyDir, startMs, endMs, includeMaintenance = false } = {}) {
  const { calls, excludedSessions } = await collectWindowedEvents({
    sessionsFile,
    historyDir,
    startMs,
    endMs,
    includeMaintenance,
  });
  const clusters = buildClusters(calls);
  const repeatedClusters = clusters
    .filter((cluster) => cluster.sessionIds.size >= 2)
    .sort((left, right) => (
      right.sessionIds.size - left.sessionIds.size
      || right.calls.length - left.calls.length
      || clusterLabel(left).localeCompare(clusterLabel(right))
    ));
  const sequences = buildRepeatedSequences(repeatedClusters);
  const sessionIds = new Set(calls.map((call) => call.sessionId));

  return {
    stats: {
      sessionCount: sessionIds.size,
      toolCallCount: calls.length,
      distinctTools: uniqueInOrder(calls.map((call) => call.toolName)).length,
      clusterCount: clusters.length,
      repeatedClusterCount: repeatedClusters.length,
      repeatedSequenceCount: sequences.length,
      excludedSessions,
    },
    calls,
    clusters: repeatedClusters.map(serializeCluster),
    sequences: sequences.map((sequence) => ({
      label: sequence.label,
      clusterIds: sequence.clusterIds,
      length: sequence.clusterIds.length,
      sessionCount: sequence.sessionCount,
      occurrences: sequence.occurrences,
      abstractionHint: sequence.abstractionHint,
      examples: sequence.examples,
    })),
  };
}

function renderStats(report) {
  const stats = report.stats;
  const lines = [
    `- Sessions analyzed: ${stats.sessionCount}`,
    `- Tool calls analyzed: ${stats.toolCallCount}`,
    `- Repeated clusters: ${stats.repeatedClusterCount}`,
    `- Repeated sequences: ${stats.repeatedSequenceCount}`,
  ];
  if (stats.excludedSessions > 0) {
    lines.push(`- Excluded maintenance sessions: ${stats.excludedSessions}`);
  }
  return lines.join('\n');
}

export function renderSessionToolReuseMarkdown(report) {
  const lines = [
    `# Session Tool Reuse Report — ${report.window.label}`,
    '',
    '## Scope',
    renderStats(report),
  ];

  if (!report.stats.toolCallCount) {
    lines.push('', '## Repeated Tool Patterns', '- No tool calls found in this window.');
    return lines.join('\n');
  }

  lines.push('', '## Repeated Tool Patterns');
  if (!report.clusters.length) {
    lines.push('- No cross-session clusters cleared the similarity threshold.');
  } else {
    for (const cluster of report.clusters.slice(0, 10)) {
      lines.push(
        `- ${cluster.label} — ${cluster.occurrences} calls across ${cluster.sessionCount} sessions — ${cluster.abstractionHint}`,
        `  - Top commands: ${cluster.topCommands.join(', ') || '(none)'}`,
        `  - Top tokens: ${cluster.topTokens.join(', ') || '(none)'}`,
        `  - Example sessions: ${cluster.exampleSessions.join(' | ') || '(none)'}`,
      );
      for (const example of cluster.examples.slice(0, 2)) {
        lines.push(`  - Example call: ${example.input}`);
      }
    }
  }

  lines.push('', '## Repeated Sequences');
  if (!report.sequences.length) {
    lines.push('- No repeated multi-step sequences appeared across sessions.');
  } else {
    for (const sequence of report.sequences.slice(0, 8)) {
      lines.push(`- ${sequence.label} — ${sequence.sessionCount} sessions — ${sequence.abstractionHint}`);
      for (const example of sequence.examples.slice(0, 2)) {
        lines.push(`  - Example: ${example.sessionName} → ${example.labels.join(' → ')}`);
      }
    }
  }

  return lines.join('\n');
}

export function renderSessionToolReuseSummary(report) {
  const lines = [
    `Tool-call sidecar for ${report.window.label}: ${report.stats.sessionCount} sessions, ${report.stats.toolCallCount} calls, ${report.stats.repeatedClusterCount} repeated clusters.`,
  ];
  for (const cluster of report.clusters.slice(0, 3)) {
    lines.push(`- ${cluster.label} — ${cluster.occurrences} calls / ${cluster.sessionCount} sessions — ${cluster.abstractionHint}`);
  }
  for (const sequence of report.sequences.slice(0, 2)) {
    lines.push(`- Sequence: ${sequence.label} — ${sequence.sessionCount} sessions — ${sequence.abstractionHint}`);
  }
  if (report.stats.excludedSessions > 0) {
    lines.push(`- Maintenance sessions excluded: ${report.stats.excludedSessions}`);
  }
  return lines.join('\n');
}

function reportBaseName(window) {
  return `session-tool-reuse-${window.endDate}-d${window.days}`;
}

export async function generateSessionToolReuseSidecar({
  configDir,
  outputDir,
  date,
  days = 1,
  includeMaintenance = false,
} = {}) {
  const effectiveConfigDir = configDir || join(HOME, '.config', 'remotelab');
  const effectiveOutputDir = outputDir || join(HOME, '.remotelab', 'reports', 'session-tool-reuse');
  const window = resolveReviewWindow({ date, days });
  const report = await analyzeSessionToolReuse({
    sessionsFile: join(effectiveConfigDir, 'chat-sessions.json'),
    historyDir: join(effectiveConfigDir, 'chat-history'),
    startMs: window.startMs,
    endMs: window.endMs,
    includeMaintenance,
  });
  report.window = window;

  if (!await pathExists(effectiveOutputDir)) {
    await mkdir(effectiveOutputDir, { recursive: true });
  }

  const baseName = reportBaseName(window);
  const markdownPath = join(effectiveOutputDir, `${baseName}.md`);
  const jsonPath = join(effectiveOutputDir, `${baseName}.json`);
  const markdown = renderSessionToolReuseMarkdown(report);
  const summary = renderSessionToolReuseSummary(report);

  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    report,
    summary,
    markdownPath,
    jsonPath,
  };
}

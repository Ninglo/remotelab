#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';
import { createPiAdapter } from '../chat/adapters/pi.mjs';
import { collectAssistantSurfaceMessages } from '../lib/assistant-surface-messages.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}
function timestamp(value) { const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : null; }
function familyOf(tool) { return tool === 'pi' ? 'pi' : tool === 'codex' ? 'codex' : /claude/i.test(tool || '') ? 'claude' : ''; }
function percentile(values, fraction) { return values.length ? values[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null; }
function freshStats() { return { runs: 0, longRuns: 0, tools: 0, progress: 0, longProgressRuns: 0, longRunsWithProgress: 0, longToolCalls: 0, longProgress: 0, silentDurationRuns: 0, silentLongRuns: 0, silentGapsMinutes: [] }; }

const sinceText = option('--since', process.argv[2] || '1970-01-01');
const since = timestamp(sinceText) ?? 0;
const runsDir = resolve(option('--runs-dir', join(process.env.REMOTELAB_CONFIG_DIR || join(homedir(), '.config', 'remotelab'), 'chat-runs')));
const stats = { codex: freshStats(), pi: freshStats(), claude: freshStats() };
const adapters = { codex: createCodexAdapter, pi: createPiAdapter, claude: createClaudeAdapter };
let names = [];
try { names = await readdir(runsDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const id of names) {
  const dir = join(runsDir, id);
  let status, manifest;
  try { [status, manifest] = await Promise.all([readFile(join(dir, 'status.json'), 'utf8').then(JSON.parse), readFile(join(dir, 'manifest.json'), 'utf8').then(JSON.parse)]); } catch { continue; }
  try { status = { ...status, ...JSON.parse(await readFile(join(dir, 'execution.json'), 'utf8')) }; } catch {}
  const fam = familyOf(status.tool || manifest.tool);
  if (!fam || manifest.internalOperation || !String(status.requestId || '').startsWith('feishu:') || status.state !== 'completed') continue;
  if ((timestamp(status.createdAt) ?? timestamp(manifest.createdAt) ?? 0) < since) continue;
  let lines;
  try { lines = (await readFile(join(dir, 'spool.jsonl'), 'utf8')).split('\n'); } catch { continue; }
  const adapter = adapters[fam]();
  const events = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let record; try { record = JSON.parse(raw); } catch { continue; }
    if (record.stream !== 'stdout' || !record.line) continue;
    for (const event of adapter.parseLine(record.line)) events.push({ ...event, timestamp: timestamp(record.ts) ?? event.timestamp });
  }
  const tools = events.filter(event => event.type === 'tool_use').length;
  const surfaces = [...collectAssistantSurfaceMessages(events, { completed: true }).values()];
  const progress = surfaces.filter(event => event.surfaceKind === 'progress').length;
  const started = timestamp(status.startedAt || status.createdAt);
  const ended = timestamp(status.completedAt || status.finalizedAt);
  const duration = started !== null && ended !== null ? ended - started : 0;
  const current = stats[fam];
  current.runs += 1;
  current.tools += tools;
  current.progress += progress;
  if (tools >= 15) {
    current.longRuns += 1;
    current.longToolCalls += tools;
    current.longProgress += progress;
    if (progress > 0) current.longRunsWithProgress += 1;
  }
  if (duration < 10 * 60 * 1000) continue;
  current.silentDurationRuns += 1;
  const visible = surfaces.filter(event => event.surfaceKind !== 'final').map(event => event.timestamp).filter(Number.isFinite).sort((a, b) => a - b);
  const points = [events[0]?.timestamp, ...visible, events.at(-1)?.timestamp].filter(Number.isFinite).sort((a, b) => a - b);
  let maxGap = 0;
  for (let index = 1; index < points.length; index += 1) maxGap = Math.max(maxGap, points[index] - points[index - 1]);
  current.silentGapsMinutes.push(maxGap / 60000);
  if (!visible.length) current.silentLongRuns += 1;
}
const result = { since: sinceText, runsDir, harnesses: {} };
for (const [name, current] of Object.entries(stats)) {
  const gaps = current.silentGapsMinutes.sort((a, b) => a - b);
  result.harnesses[name] = {
    runs: current.runs,
    longRuns: current.longRuns,
    longTaskProgressRate: current.longRuns ? current.longRunsWithProgress / current.longRuns : 0,
    progressPer100ToolCalls: current.tools ? current.progress / current.tools * 100 : 0,
    longRunsWithoutVisibleMessageBeforeFinal: current.silentDurationRuns ? current.silentLongRuns / current.silentDurationRuns : 0,
    longestSilentGapMinutesP50: percentile(gaps, 0.5),
    longestSilentGapMinutesP90: percentile(gaps, 0.9),
    toolCalls: current.tools,
    progressEvents: current.progress,
  };
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');

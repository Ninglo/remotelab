import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

function threadIds(value) {
  if (Array.isArray(value)) return value.map(x => typeof x === 'string' ? x : x?.threadId || x?.thread_id).filter(Boolean);
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

// Read-only plan: one source collection supplies both project facts and Todo.
// Successful cursors and actual task writes remain owned by their original workflows.
export async function buildProjectInspectionPlan({ runtime, registry, reviewRoot, at, load = readJson }) {
  if (!runtime.enabled || !runtime.reviewEnabled) throw new Error('Project review enhancement is disabled');
  const endMs = Date.parse(at);
  if (!Number.isFinite(endMs)) throw new Error('The original scheduled time is required');
  const clock = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(endMs)).map(x => [x.type, x.value]));
  const morning = clock.hour === '04';
  if (!['04', '18'].includes(clock.hour)) throw new Error('Use the original 04:00 or 18:00 scheduled time');
  const paused = new Set((runtime.projects || []).filter(x => x.status === 'paused').map(x => x.id));
  const groups = runtime.groups.filter(g => !(g.projectIds?.length && g.projectIds.every(id => paused.has(id))));
  const allowed = new Set(groups.map(g => g.chatId));
  const targets = (registry.targets || []).filter(t => t.enabled && allowed.has(t.chatId)
    && !(t.projectId && paused.has(t.projectId)));
  const sources = [];
  for (const group of groups) {
    const target = morning ? targets.find(t => t.chatId === group.chatId) : null;
    const reviewCheckpoint = join(reviewRoot, 'chat-sync', 'checkpoints', `${group.chatId}.json`);
    const checkpoint = await load(reviewCheckpoint, {});
    const todoState = target ? await load(target.stateFile, {}) : {};
    const reviewEnd = Date.parse(checkpoint.collection_completed_at_utc || checkpoint.lastSuccessfulScanEnd || '');
    const todoEnd = Date.parse(todoState.lastSuccessfulScanEnd || '');
    const needsTodo = Boolean(target && (!Number.isFinite(todoEnd) || todoEnd < endMs));
    // Missing baselines require a complete initial read, rather than silently dropping backlog.
    const ends = [reviewEnd, ...(needsTodo ? [todoEnd] : [])];
    const startMs = ends.every(Number.isFinite) ? Math.min(...ends) - 48 * 3600_000 : null;
    const threads = new Set([...threadIds(checkpoint.threads), ...(needsTodo ? threadIds(todoState.knownThreads) : [])]);
    sources.push({ chatId: group.chatId, sourceRouteId: group.sourceRouteId, projectIds: group.projectIds,
      windowStart: startMs === null ? null : new Date(startMs).toISOString(), windowEnd: new Date(endMs).toISOString(),
      reviewCheckpoint, knownThreads: [...threads], todoTarget: needsTodo ? target.key : null,
      todoStateFile: needsTodo ? target.stateFile : null });
  }
  return { schemaVersion: 1, scheduledAt: new Date(endMs).toISOString(),
    localDate: `${clock.year}-${clock.month}-${clock.day}`, phase: morning ? 'morning' : 'afternoon',
    sourceCollection: 'once_per_chat', tasklistGuid: registry.tasklistGuid,
    tasklistRead: morning ? 'once_for_all_enabled_targets_then_recheck_each_write_under_original_lock' : 'reuse_latest_completed_inspection',
    sources, todoTargets: morning ? targets.filter(t => sources.some(s => s.todoTarget === t.key)) : [],
    rules: ['Do not advance cursors on failed or incomplete reads', 'A cached bundle is evidence only; it does not authorize business execution',
      'Complete Todo assessment before publishing; keep source-specific failures and original delivery routes'] };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]); return pairs;
  }, []));
  for (const key of ['runtime', 'registry', 'review-root', 'at', 'output']) if (!args[key]) throw new Error(`--${key} is required`);
  const plan = await buildProjectInspectionPlan({ runtime: await readJson(args.runtime), registry: await readJson(args.registry),
    reviewRoot: resolve(args['review-root']), at: args.at });
  const output = resolve(args.output); await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, output);
  console.log(JSON.stringify({ output, phase: plan.phase, sources: plan.sources.length, todoTargets: plan.todoTargets.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

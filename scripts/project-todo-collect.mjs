import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lark } from './project-reading-sync.mjs';

// The focused collector remains the owner of its indexes. Only additional Todo
// sources are fetched here; no task, source cursor or project fact is written.
export async function collectTodoSources(plan, { indexes, profile, request = lark }) {
  await mkdir(indexes, { recursive: true });
  const rows = [];
  for (const source of plan.todoSources || []) {
    const path = join(indexes, `index-${source.chatId}.json`);
    const row = { chatId: source.chatId, target: source.todoTarget, indexPath: path,
      projectAnalysisEligible: source.projectAnalysisEligible, windowStart: source.windowStart, windowEnd: source.windowEnd };
    try {
      if (source.projectAnalysisEligible) {
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (existing.chat_id !== source.chatId || !existing.messages) throw new Error('Missing focused source index');
        row.status = 'reused'; row.boundary = 'Focused collector pagination evidence still required';
      } else {
        const messages = new Map(), threads = new Set(source.knownThreads || []);
        const add = message => {
          if (!message?.message_id) throw new Error('Source message has no ID');
          const value = { ...message };
          // lark-cli shortcut times are UTC wall times; store an explicit zone.
          for (const key of ['create_time', 'update_time']) {
            if (/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value[key] || '')) value[key] = value[key].replace(' ', 'T') + 'Z';
          }
          messages.set(value.message_id, value);
          if (value.thread_id) threads.add(value.thread_id);
          for (const reply of value.thread_replies || []) add(reply);
        };
        const pages = async (args, label) => {
          const tokens = new Set(); let token = '', page = 0;
          while (true) {
            const data = await request([...args, ...(token ? ['--page-token', token] : [])], profile);
            if (!Array.isArray(data.messages)) throw new Error('Missing message page');
            await writeFile(join(indexes, `${source.chatId}-${label}-${page++}.json`), JSON.stringify(data), { mode: 0o600 });
            data.messages.forEach(add);
            if (!data.has_more) break;
            if (!data.page_token || tokens.has(data.page_token)) throw new Error('Incomplete message pagination');
            token = data.page_token; tokens.add(token);
          }
        };
        await pages(['im', '+chat-messages-list', '--chat-id', source.chatId,
          ...(source.windowStart ? ['--start', source.windowStart] : []), '--end', source.windowEnd,
          '--order', 'asc', '--page-size', '50', '--no-reactions'], 'roots');
        const visited = new Set();
        for (const thread of threads) {
          if (visited.has(thread)) continue;
          visited.add(thread);
          await pages(['im', '+threads-messages-list', '--thread', thread, '--page-size', '50', '--no-reactions'], thread);
        }
        await writeFile(path, JSON.stringify({ chat_id: source.chatId, windowStart: source.windowStart,
          windowEnd: source.windowEnd, timeZone: 'UTC', complete: true, projectAnalysisEligible: false,
          evidenceRole: 'person_todo_only', messages: [...messages.values()] }, null, 2), { mode: 0o600 });
        row.status = 'read'; row.messageCount = messages.size; row.expandedThreads = visited.size;
      }
    } catch (error) { row.status = 'failed'; row.error = error.message; }
    rows.push(row);
  }
  const manifest = { scheduledAt: plan.scheduledAt, groups: rows, complete: rows.every(r => r.status !== 'failed') };
  await writeFile(join(indexes, 'todo-collection.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
  for (const key of ['plan', 'indexes', 'profile']) if (!args[key]) throw new Error(`--${key} required`);
  const result = await collectTodoSources(JSON.parse(await readFile(args.plan, 'utf8')), args);
  console.log(JSON.stringify({ complete: result.complete, groups: result.groups.length, failed: result.groups.filter(r => r.status === 'failed').length }));
  if (!result.complete) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });

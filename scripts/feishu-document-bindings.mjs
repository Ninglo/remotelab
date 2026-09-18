import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { bindingKey, bindingsDirectory, readBindingJson, writeBindingJson } from '../connectors/feishu/document-bindings.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('Expected --option value');
  options[args[i].slice(2)] = args[i + 1];
}
if (!['bind', 'status', 'unbind'].includes(command) || !options.config || !options['file-token']) {
  console.log('Usage: node scripts/feishu-document-bindings.mjs bind|status|unbind --config <connector-config> --file-token <docx-token> [--session <id> --url <url> --base-url <instance-url>]');
  process.exitCode = 1;
} else {
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  const storageDir = config.storageDir || dirname(options.config);
  const directory = bindingsDirectory(storageDir);
  const key = bindingKey(options['file-token']);
  const path = join(directory, `${key}.binding.json`);
  await mkdir(directory, { recursive: true });
  const lock = await open(`${path}.lock`, 'wx', 0o600);
  try {
    const existing = await readBindingJson(path);
    if (command === 'status') {
      const state = await readBindingJson(join(directory, `${key}.state.json`));
      console.log(JSON.stringify({ binding: existing, health: state && {
        lastSuccessAt: state.lastSuccessAt, lastError: state.lastError,
        lastErrorAt: state.lastErrorAt, pending: state.pending?.length, seen: Object.keys(state.seen || {}).length,
      } }, null, 2));
    } else if (command === 'unbind') {
      if (!existing) throw new Error('Binding not found');
      await writeBindingJson(path, { ...existing, enabled: false });
      console.log(JSON.stringify({ ok: true, enabled: false }));
    } else {
      if (!options.session || !options.url) throw new Error('--session and --url required');
      const client = createRemoteLabHttpClient({ baseUrl: options['base-url'] || config.chatBaseUrl });
      const result = await client.request(`/api/sessions/${options.session}`);
      const session = result.json?.session;
      const route = config.botId || basename(dirname(options.config));
      if (!result.response.ok || session?.conversation?.connector !== 'feishu'
        || session.conversation.sourceRouteId !== route || !session.conversation.target?.chatId) {
        throw new Error('Target must be a Feishu conversation on this connector');
      }
      if (existing) {
        if (existing.sessionId !== session.id) throw new Error('Document already has a different review Session; explicit migration required');
        // Idempotent publication must never reset the cursor or replay old input.
        if (!existing.enabled) throw new Error('Binding disabled; explicit resumption required');
        console.log(JSON.stringify({ ok: true, binding: existing, reused: true }));
      } else {
        const url = new URL(options.url);
        if (url.protocol !== 'https:' || !url.pathname.endsWith(`/docx/${options['file-token']}`)) throw new Error('Expected matching HTTPS docx URL');
        const binding = {
          version: 1, generation: randomUUID(), enabled: true,
          fileToken: options['file-token'], fileType: 'docx', documentUrl: url.href,
          sessionId: session.id, sourceRouteId: route, conversation: session.conversation,
          since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        };
        await writeBindingJson(path, binding);
        console.log(JSON.stringify({ ok: true, binding }));
      }
    }
  } finally { await lock.close(); await unlink(`${path}.lock`); }
}

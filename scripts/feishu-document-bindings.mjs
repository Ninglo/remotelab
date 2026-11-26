import { readFile } from 'node:fs/promises';
import { dirname, join, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import { CONFIG_DIR } from '../lib/config.mjs';
import { sanitizeIdPart } from '../connectors/feishu/index.mjs';
import { bindingKey, bindingsDirectory, documentBindingPath, readBindingJson, writeBindingJson } from '../connectors/feishu/document-bindings.mjs';
import { withFileLock } from '../lib/file-lock.mjs';
import { claimOnce } from '../lib/durable-records.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('Expected --option value');
  options[args[i].slice(2)] = args[i + 1];
}
if (!['bind', 'status', 'unbind'].includes(command) || !options.config || !/^[a-zA-Z0-9_-]+$/.test(options['file-token'] || '')) {
  console.log('Usage: node scripts/feishu-document-bindings.mjs bind|status|unbind --config <connector-config> --file-token <docx-token> [--session <id> --url <url> --base-url <instance-url> --reply-mode comment|conversation --intake mention]');
  process.exitCode = 1;
} else {
  const config = JSON.parse(await readFile(options.config, 'utf8'));
  const storageDir = config.storageDir || dirname(options.config);
  const directory = bindingsDirectory(storageDir);
  const key = bindingKey(options['file-token']);
  const path = documentBindingPath(storageDir, options['file-token']);
  await withFileLock(`${path}.flock`, async () => {
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
      if (options['reply-mode'] && !['comment', 'conversation'].includes(options['reply-mode'])) {
        throw new Error('--reply-mode must be comment or conversation');
      }
      const client = createRemoteLabHttpClient({ baseUrl: options['base-url'] || config.chatBaseUrl });
      if (options.intake && options.intake !== 'mention') throw new Error('Document comments require an @mention; --intake all is no longer supported');
      if (options.intake === 'mention' && options['reply-mode'] === 'conversation') throw new Error('Mention-only bindings reply in the original comment');
      const result = await client.request(`/api/sessions/${encodeURIComponent(options.session)}`);
      const session = result.json?.session;
      const route = (config.botId ? sanitizeIdPart(config.botId) : '')
        || (resolve(options.config) === resolve(join(CONFIG_DIR, 'feishu-connector', 'config.json'))
          ? 'default' : sanitizeIdPart(basename(dirname(options.config))) || 'default');
      if (!result.response.ok || !session?.id || session.archived) throw new Error('Target Session is unavailable or archived');
      if (existing) {
        if (existing.sessionId !== session.id || existing.sourceRouteId !== route) throw new Error('Document already has a fixed Session');
        if (existing.mentionOnly && options['reply-mode'] === 'conversation') throw new Error('Mention-only bindings reply in the original comment');
        // Resuming the same target does not reset the cursor or its generation.
        const binding = { ...existing, enabled: true, ...(options['reply-mode'] ? { replyMode: options['reply-mode'] } : {}) };
        if (!existing.enabled || binding.replyMode !== existing.replyMode) await writeBindingJson(path, binding);
        console.log(JSON.stringify({ ok: true, binding, reused: true }));
      } else {
        if (await readBindingJson(`${path}.session.json`)) throw new Error('Document already has a pending automatic binding');
        const target = session.conversation?.target;
        const sameConnector = session.conversation?.connector === 'feishu' && session.conversation.sourceRouteId === route;
        if (!sameConnector || !(target?.chatId || (options.intake === 'mention' && target?.fileToken === options['file-token']))) {
          throw new Error('Target must be a Feishu chat on this connector or a mention Session for this document');
        }
        const url = new URL(options.url);
        if (url.protocol !== 'https:' || !url.pathname.endsWith(`/docx/${options['file-token']}`)) throw new Error('Expected matching HTTPS docx URL');
        const binding = {
          version: 1, generation: randomUUID(), enabled: true,
          fileToken: options['file-token'], fileType: 'docx', documentUrl: url.href,
          sessionId: session.id, sourceRouteId: route, conversation: session.conversation,
          replyMode: options['reply-mode'] || 'comment', ...(options.intake === 'mention' ? { mentionOnly: true } : {}),
          since: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
        };
        if (!await claimOnce(path, binding)) throw new Error('Document already has a fixed Session');
        console.log(JSON.stringify({ ok: true, binding }));
      }
    }
  });
}

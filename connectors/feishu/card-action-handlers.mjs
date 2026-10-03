import { spawn } from 'node:child_process';

// Only instance configuration supplies executable arguments. Callback values
// are data on stdin, never a command, pathname, or shell expression.
export function normalizeCardActionHandlers(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cardActionHandlers');
  return Object.fromEntries(Object.entries(value).map(([namespace, handler]) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(namespace)
      || !Array.isArray(handler?.argv) || !handler.argv.length
      || handler.argv.some(arg => typeof arg !== 'string' || !arg.length)
      || !Array.isArray(handler.allowedChatIds) || !handler.allowedChatIds.length
      || handler.allowedChatIds.some(id => typeof id !== 'string' || !id.startsWith('oc_'))) {
      throw new Error(`Invalid cardActionHandlers entry: ${namespace}`);
    }
    return [namespace, { argv: [...handler.argv], allowedChatIds: [...handler.allowedChatIds] }];
  }));
}

function execute(argv, raw, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let output = '';
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Card handler deadline')); }, timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { child.kill('SIGKILL'); reject(new Error('Card handler output limit')); }
      else output += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Card handler failed'));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(raw));
  });
}

export async function handleConfiguredCardAction(raw, { handlers, authorize, timeoutMs = 2000 }) {
  const event = raw?.event || raw || {};
  let value = event.action?.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const handler = Object.hasOwn(handlers, value.namespace) ? handlers[value.namespace] : null;
  if (!handler) return null;
  const operator = event.operator || {};
  const sender = {
    openId: operator.open_id || operator.operator_id?.open_id,
    userId: operator.user_id || operator.operator_id?.user_id,
    unionId: operator.union_id || operator.operator_id?.union_id,
    tenantKey: operator.tenant_key || event.tenant_key,
  };
  const chatId = event.context?.open_chat_id || event.context?.chat_id || event.open_chat_id;
  const denied = { toast: { type: 'error', content: '当前操作不可用，请核对群和操作身份。' } };
  if (!sender.openId || !handler.allowedChatIds.includes(chatId)
    || !await authorize({ sender, chatId, tenantKey: sender.tenantKey })) return denied;
  if (Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024) return denied;
  try {
    const result = await execute(handler.argv, raw, timeoutMs);
    if (!['success', 'info', 'warning', 'error'].includes(result?.toast?.type)
      || typeof result?.toast?.content !== 'string'
      || (result.card && (result.card.type !== 'raw' || !result.card.data))) throw new Error('Invalid card handler response');
    return { toast: result.toast, ...(result.card ? { card: result.card } : {}) };
  } catch {
    return { toast: { type: 'error', content: '操作未确认完成，请稍后重试。' } };
  }
}

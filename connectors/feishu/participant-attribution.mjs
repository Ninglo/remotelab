import { createHash } from 'node:crypto';

const trim = value => typeof value === 'string' ? value.trim() : '';

function safeName(value) {
  return trim(value).replace(/[\r\n\t\u0000-\u001f<>＆&]/g, ' ').replace(/\s+/g, ' ').slice(0, 100).trim();
}

export function feishuParticipantKey(sender = {}) {
  const existing = trim(sender.participantKey);
  if (/^[a-f0-9]{10}$/.test(existing)) return existing;
  const openId = trim(sender.openId || sender.open_id || sender.sender_id?.open_id || sender.id);
  const fallbackId = trim(sender.userId || sender.user_id || sender.sender_id?.user_id
    || sender.unionId || sender.union_id || sender.sender_id?.union_id);
  const tenant = trim(sender.tenantKey || sender.tenant_key);
  const id = openId || (fallbackId ? `${tenant}\0${fallbackId}` : '');
  if (!id) return '';
  return createHash('sha256').update(id).digest('hex').slice(0, 10);
}

export function feishuParticipantLabel(sender = {}) {
  const type = trim(sender.senderType || sender.sender_type).toLowerCase();
  const name = safeName(sender.name || sender.displayName || sender.sender_name
    || sender.sender_i18n_names?.zh_cn || sender.sender_i18n_names?.en_us
    || sender.sender_i18n_names?.ja_jp);
  if (type === 'app' || type === 'bot') return name || '机器人';
  const key = feishuParticipantKey(sender);
  const readable = name || '群成员';
  return key ? `${readable}（成员 ${key}）`
    : name ? `${name}（身份未核实）` : '身份未识别的群成员';
}

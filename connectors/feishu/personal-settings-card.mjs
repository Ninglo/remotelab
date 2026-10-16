import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { loadAuthDocument } from '../../lib/auth-config.mjs';
import { loadPersonMessageReplies, changePersonMessageReplies } from '../../chat/person-message-replies.mjs';
import { loadPersonalMemorySettings, changePersonalMemorySettings } from '../../chat/personal-memory-settings.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });
const panel = (title, elements) => ({ tag: 'collapsible_panel', expanded: false, header: { title: plain(title) }, elements });
const progressLabels = { none: '不展示过程进展', messages: '卡片＋单独文字', card_latest: '卡片内最新进展', card_all: '卡片内全部进展（默认折叠）' };
export const PERSONAL_INTRO = '嗨，我是 Index，来和你一起把事情往前推的 AI 同事。\n你可以把要做的事、卡住的问题，或者一个还没想清楚的点子丢给我。我们一起理清目标，我来找资料、动手做、跟进结果；需要你拿主意时，我会把问题说清楚。\n我也会在协作中逐步熟悉项目和你的习惯。哪里理解偏了、做得不顺手，直接告诉我，我们边干边改。';

export function buildPersonalSettingsCard(record, { replies, memory, notice = '', webUrl = '' }) {
  const button = (label, field, value, revision = replies.revision) => ({ tag: 'button', type: 'default', text: plain(label),
    behaviors: [{ type: 'callback', value: { namespace: 'personal-settings', key: record.key, field, value, revision } }] });
  const toggle = (label, field, enabled, description) => panel(`${label} · ${enabled ? '已开启' : '已关闭'}`, [md(description),
    button(enabled ? '关闭' : '开启', field, !enabled)]);
  const c = replies.choices;
  const elements = [md(PERSONAL_INTRO), ...(notice ? [md(notice)] : []), md('**我的设置**\n点开一项即可修改。保存后用于你接下来的对话；网页备用入口使用同一份设置。'),
    toggle('开工时简短说一声', 'opening', c.opening, '实质工作开始时，简短说明准备怎么做。简单问答直接回答。'),
    toggle('需要时显示交付清单', 'checklist', c.checklist, '有多项可分别验收的成果时显示清单；不是每件小事都列步骤，也不会自动创建个人待办。'),
    panel(`进展展示 · ${progressLabels[c.progress]}`, [md('按有用的新发现更新，不定时刷屏。必要提问和最终结果始终单独送达。'),
      ...Object.entries(progressLabels).map(([value, label]) => button(`${c.progress === value ? '当前：' : ''}${label}`, 'progress', value))]),
    toggle('对话分流与并行试用', 'routing', c.routing === 'experimental', '在已开放的试点群中，发现适合独立推进的工作时提出分工。你确认后才创建独立会话；没有回复就继续原工作。这里的开关不扩大试点范围。'),
    panel(`个人记忆 · ${!memory.available ? '尚未开放' : memory.conversational && memory.enabled ? '已开启' : '未开启对话试用'}`, [
      md('开启后，在协作中整理与你有关的工作习惯和明确偏好；新的个人习惯会向你确认。你可以直接说“我有哪些已记住的偏好”“把这一条改成……”或“忘掉这一条”。关闭后停止这项试用，已有记录不会因此删除。'),
      ...(memory.available ? [button(memory.conversational && memory.enabled ? '停用个人记忆' : '启用个人记忆', 'memory', !(memory.conversational && memory.enabled), memory.revision)] : [])]),
    toggle('开工检查试用', 'strictStartCheck', c.strictStartCheck, '开工前额外核对事项归属、现行做法和相关工作。关闭后恢复普通开工，不影响其他设置。'),
    md('**认识 Index**'),
    panel('一起干活，可以从哪里开始？', [md('把目标、现有材料和你在意的要求发来就好，不必先写一份完美需求。比如：\n• “这份评测结果帮我看下，哪些问题值得先解决？”\n• “接着上次的方案做，结果还放这里。”\n• “这个重复操作太费时间，帮我想想能不能省掉。”\n\n我会结合能读取的项目资料接着做。已有成果会尽量沿原件修改，最后告诉你做成了什么、还有什么没解决。')]),
    panel('补充、纠正、停止与找回工作', [md('在原话题直接补充要求，我会接着同一件工作处理。方向偏了就指出来；要停下可以说“停止当前任务”。外部已经提交的任务是否也停止，需要核实。\n想找之前的成果，可以说“上次那份方案在哪里”；独立分出去的工作仍由原话题汇总。')]),
    panel('连接资料与授权：哪些需要你决定？', [md('你可以先正常聊天，不用把所有权限都开一遍。需要连接资料或设备时，我会说明能做什么、要访问什么，并尽量合并同一次所需的授权。\n飞书个人授权、管理员批准、文档访问权和本机设备权限由不同地方管理，不能用一个开关代替。这里目前没有“一键全部授权”；也不会借用别人的登录去访问你的资料。')]),
    panel('增强版安装与本机设置', [md('普通飞书就能使用这里的个人设置。增强版主要补充本机外观、话题状态等体验，不另外维护一套个人偏好。\n当前本地增强安装支持 Apple 芯片 Mac，具体系统和飞书版本需先检查。想安装时直接私聊说“帮我检查增强版能不能安装”；本机连接和权限由你确认。')]),
    panel('资料范围与记忆', [md('我能使用的资料取决于当前已接入的来源和权限，不代表看过整个公司。群内交办与私聊材料按实际来源处理，个人偏好不会变成全群规定。\n个人设置决定协作方式，不等于给共享工作台增加了私密空间；共享实例中已登录成员可访问工作台会话，请留意材料的分享范围。')]),
    md('以后在私聊发送“我的设置”或 `/settings` 就能重新打开。旧卡失效时也用这个入口。'),
    button('刷新当前设置', 'refresh', null),
    ...(webUrl ? [md(`[网页设置（备用）](${webUrl})`)] : []),
  ];
  return { schema: '2.0', config: { update_multi: true, enable_forward: false }, header: { template: 'blue', title: plain('Index · 我们怎么一起干活') }, body: { elements } };
}

export function createPersonalSettingsController(runtime, { authorize = async () => false, now = Date.now } = {}) {
  const store = createRecordStore(join(runtime.config.storageDir, 'personal-settings'));
  const queues = new Map();
  const serial = key => { if (!queues.has(key)) queues.set(key, serialQueue()); return queues.get(key); };
  const enabled = source => source?.chatType === 'p2p' && !!source.chatId && !!source.tenantKey && !!source.sender?.openId
    && (runtime.config.personalSettings?.openIds || []).includes(source.sender.openId);
  async function actorFor(source) {
    if (!enabled(source) || !await authorize(source)) throw Error('当前账号尚未开放此设置入口。');
    const document = await loadAuthDocument({ persistMigration: false });
    const matches = document.people.flatMap(p => (p.identities || []).filter(i => i.kind === 'feishu'
      && i.realm === runtime.config.sourceRouteId && i.subjectId === source.sender.openId)
      .map(i => ({ personId: p.id, identityId: i.id, authKind: 'feishu-card' })));
    if (matches.length !== 1) throw Error('还没能确认你的身份，请先私聊发一条普通消息，再打开设置。');
    return matches[0];
  }
  async function card(record, actor, notice = '') {
    const [replies, memory] = await Promise.all([loadPersonMessageReplies(actor), loadPersonalMemorySettings(actor)]);
    // Only an explicitly configured, credential-free HTTPS fallback is shown.
    let webUrl = '';
    try { const url = new URL(runtime.config.personalSettings?.webUrl); if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) { url.search = '?tab=settings'; webUrl = url.href; } } catch {}
    return buildPersonalSettingsCard(record, { replies, memory, notice, webUrl });
  }
  async function publish(source, { automatic = false } = {}) {
    if (!enabled(source)) return null;
    const actor = await actorFor(source);
    const key = createHash('sha256').update(JSON.stringify([runtime.config.sourceRouteId, source.tenantKey, source.sender.openId, source.chatId])).digest('hex').slice(0, 24);
    return serial(key)(async () => {
      let record = await store.get(key);
      if (automatic && record) return record; // First-use welcome is not a recurring notification.
      if (!record) record = await store.mutate(key, () => ({ source, personId: actor.personId, identityId: actor.identityId, generation: 0 }));
      if (record.personId !== actor.personId || record.identityId !== actor.identityId) throw Error('个人身份关联已变化，请核对原卡归属。');
      const fresh = record.messageId && now() - record.createdAt < 13 * 86400000;
      const rendered = await card(record, actor);
      if (fresh) {
        const result = await runtime.appClient.im.v1.message.patch({ path: { message_id: record.messageId }, data: { content: JSON.stringify(rendered) } });
        if (result.code) throw Error('卡片刷新失败，请稍后重试。');
        return record;
      }
      if (record.creating) throw Error('上次卡片发送结果仍待核对，暂不重复发送。');
      const generation = record.generation + 1;
      record = await store.mutate(key, r => ({ ...r, generation, creating: true }));
      const uuid = createHash('sha256').update(`${key}:${generation}`).digest('hex').slice(0, 32);
      const result = await runtime.appClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: source.chatId,
        msg_type: 'interactive', content: JSON.stringify(rendered), uuid } });
      if (result.code) { await store.mutate(key, r => ({ ...r, creating: false })); throw Error(`卡片未发送成功（${result.code}）。`); }
      if (!result.data?.message_id) throw Error('卡片发送结果缺少回执，请核对后再发送。');
      return store.mutate(key, r => ({ ...r, creating: false, messageId: result.data.message_id, createdAt: now() }));
    });
  }
  async function action(raw) {
    const event = raw?.event || raw;
    let value = event?.action?.value;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    if (value?.namespace !== 'personal-settings') return null;
    if (!/^[a-f0-9]{24}$/.test(value.key || '')) return { toast: { type: 'error', content: '设置卡片无效。' } };
    return serial(value.key)(async () => {
      let record, actor, saved = false;
      try {
        record = await store.get(value.key);
        const openId = event.operator?.open_id || event.operator?.operator_id?.open_id;
        const tenant = event.operator?.tenant_key || raw.header?.tenant_key || event.tenant_key;
        if (!record || record.creating || event.context?.open_message_id !== record.messageId
          || event.context?.open_chat_id !== record.source.chatId || openId !== record.source.sender.openId
          || tenant !== record.source.tenantKey) throw Error('请在你与机器人的原私聊中操作自己的设置卡。');
        actor = { ...await actorFor(record.source), eventId: raw.header?.event_id || event.event_id,
          chatId: record.source.chatId, messageId: record.messageId };
        if (!actor.eventId || actor.personId !== record.personId || actor.identityId !== record.identityId) throw Error('无法核对这次操作的身份。');
        if (value.field === 'memory') {
          await changePersonalMemorySettings({ enabled: value.value, expectedRevision: value.revision, confirm: true }, actor);
          saved = true;
        } else if (value.field !== 'refresh') {
          if (!['opening', 'checklist', 'progress', 'routing', 'strictStartCheck'].includes(value.field)) throw Error('未知设置。');
          const current = await loadPersonMessageReplies(actor);
          if (value.field !== 'progress' && typeof value.value !== 'boolean') throw Error('设置选项无效。');
          const next = value.field === 'routing' ? value.value ? 'experimental' : 'none' : value.value;
          await changePersonMessageReplies({ action: 'apply', expectedRevision: value.revision, confirm: true,
            choices: { ...current.choices, [value.field]: next } }, actor);
          saved = true;
        }
        const rendered = await card(record, actor, saved ? '已保存，用于你的后续对话。' : '已读取当前设置。');
        await store.mutate(record.key, r => ({ ...r, lastAction: { eventId: actor.eventId, field: value.field, saved, at: now() } }));
        return { toast: { type: 'success', content: saved ? '已保存' : '已刷新' }, card: { type: 'raw', data: rendered } };
      } catch (error) {
        const message = saved ? '设置已保存，但卡片刷新失败。请发送“我的设置”重新打开。' : error.message;
        // A stale-card conflict is recoverable in place; do not report a save.
        let rendered;
        if (actor && record) { try { rendered = await card(record, actor, message); } catch {} }
        return { toast: { type: 'error', content: message }, ...(rendered ? { card: { type: 'raw', data: rendered } } : {}) };
      }
    });
  }
  return { enabled, publish, action, get: store.get, idle: async () => { await Promise.all([...queues.values()].map(q => q.idle())); await store.idle(); } };
}

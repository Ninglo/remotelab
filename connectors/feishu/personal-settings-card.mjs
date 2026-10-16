import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRecordStore, serialQueue } from '../../lib/durable-records.mjs';
import { loadAuthDocument } from '../../lib/auth-config.mjs';
import { loadPersonMessageReplies, changePersonMessageReplies } from '../../chat/person-message-replies.mjs';
import { loadPersonalMemorySettings, changePersonalMemorySettings } from '../../chat/personal-memory-settings.mjs';

const plain = content => ({ tag: 'plain_text', content });
const md = content => ({ tag: 'markdown', content });
const panel = (title, elements) => ({ tag: 'collapsible_panel', expanded: false, header: { title: plain(title) }, elements });
const progressLabels = { none: '只看最终结果', messages: '进展单独发消息', card_latest: '卡片只留最新进展', card_all: '卡片保留全部进展' };
export const PERSONAL_INTRO = '嗨，我是 Index，你的 AI 同事。\n查资料、写文档、改代码、跑实验，都可以来找我。把正在讨论的事转给我也行，我们一起想办法，把事情做成。\n我会结合能读到的项目资料和已有讨论接着做，也会提出自己的判断。你随时可以补充、纠正；这些反馈会帮助我更懂团队的工作。';

export function buildPersonalSettingsCard(record, { replies, memory, notice = '', webUrl = '' }) {
  const button = (label, field, value, revision = replies.revision, selected = false) => ({ tag: 'button', type: selected ? 'primary' : 'default', text: plain(selected ? `当前：${label}` : label), disabled: selected,
    behaviors: [{ type: 'callback', value: { namespace: 'personal-settings', key: record.key, field, value, revision } }] });
  const choices = (field, current, options, revision = replies.revision) => ({ tag: 'column_set', columns: options.map(([value, label]) => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [button(label, field, value, revision, current === value)],
  })) });
  const toggle = (title, field, enabled, description, labels = ['开启', '关闭'], revision = replies.revision) => [
    md(`**${title}**\n${description}`), choices(field, enabled, [[true, labels[0]], [false, labels[1]]], revision),
  ];
  const c = replies.choices;
  const elements = [md(PERSONAL_INTRO), { tag: 'hr' }, ...(notice ? [md(notice)] : []),
    md('**个人设置**\n标有“当前”的是已选项。点击其他选项立即保存，从后续对话生效；正在进行的工作保持原设置。'),
    ...toggle('开始工作时的回复', 'opening', c.opening, '接到需要动手的任务后，先简短告诉你我理解的目标和准备做什么。简单问答直接回答。', ['先说一下怎么做', '直接开始']),
    ...toggle('任务清单', 'checklist', c.checklist, '一件工作有多项成果时，用清单显示哪些已完成、哪些还在做，方便你查看和验收。这里控制工作清单的展示；个人待办仍可直接交给我创建。', ['需要时显示', '不显示']),
    md('**进展消息**\n有关键发现、阶段结果或需要调整方向时，我会报告进展。选择在哪里查看；需要你回答的问题和最终结果都会单独发送。'),
    choices('progress', c.progress, Object.entries(progressLabels).slice(0, 2)),
    choices('progress', c.progress, Object.entries(progressLabels).slice(2)),
    md('卡片会持续更新；选择“全部进展”时，历史记录默认收起，想看时再展开。'),
    ...toggle('多项工作并行（试用）', 'routing', c.routing === 'experimental', '有几件事能独立推进时，我会提出分工，确认后分开做，你仍在原话题收结果。关闭后不主动提出这类分工；目前仅在已开放的试点群生效。', ['主动建议分工', '不主动建议']),
    ...(memory.available ? toggle('个人记忆', 'memory', memory.conversational && memory.enabled,
      '记住你的称呼、表达偏好和协作习惯，减少下次重复交代。新发现的习惯会先问你是否保留；你也可以随时问“你记住了什么”，或要求修改、删除。关闭不会删除已有记录。', ['开启', '关闭'], memory.revision)
      : [md('**个人记忆 · 尚未开放**\n用于记住称呼、表达偏好和协作习惯。当前账号暂未开放此试用。')]),
    ...toggle('开工前核对（试用）', 'strictStartCheck', c.strictStartCheck,
      '接到新工作时，额外查一下项目资料、现有做法和相关任务，减少重复做或接错工作。开启后准备时间可能更长；关闭后按通常方式开始。', ['增加核对', '通常方式']),
    { tag: 'hr' }, md('**使用说明**'),
    panel('交办工作与查看结果', [md('直接发目标、材料和要求，或把相关讨论转给我。例如：“这段讨论帮我整理成方案”“查一下这次评测为什么退步”。\n我会先利用已有资料；缺少关键背景时再问你。结果会回到交办的话题，文档、代码等成果会附上入口。')]),
    panel('中途补充、修改与停止', [md('任务进行中也可以继续发消息补充要求，不必等我做完。发现方向不对，直接指出哪部分要改。\n要停下就说“停止当前任务”。如果已经提交了外部训练或其他后台任务，我会另行核对它们是否也已停止。')]),
    panel('连接资料与授权', [md('普通聊天和这里的设置不需要额外安装。读取私有文档、操作日历或连接设备时，可能需要授权。\n你可以说“检查这项工作需要哪些权限”，我会汇总缺少的权限、用途和办理入口。管理员审批、本人账号授权、文档分享和设备权限分别办理，当前还没有一键全部开通。')]),
    panel('增强版有什么用，怎么安装？', [md('增强版补充飞书客户端的页面显示和话题状态等体验。这里的个人设置在普通飞书就能用，不需要安装增强版。\n目前增强安装仅支持已验证的 Apple 芯片 Mac 和特定飞书版本。想试用可说“帮我检查增强版能不能安装”，先核对设备和版本，再给安装入口。个人偏好共用一份配置；已有增强版中的重复入口正在迁移。')]),
    panel('项目资料、个人记忆与可见范围', [md('项目背景帮助我理解工作；个人记忆帮助我了解怎样与你协作，两者分别维护。你的个人偏好不会成为全群规则。\n我只能使用已接入且有权限读取的资料。当前共享网页工作台的已登录成员可查看工作台会话，个人设置不提供会话隔离；交办私密材料前请确认分享范围。')]),
    md('找不到这张卡时，私聊发送“我的设置”即可重新打开。修改失败时可先刷新，再重新选择。'),
    button('刷新设置', 'refresh', null),
    ...(webUrl ? [panel('网页版备用入口（需另行登录）', [md(`[打开网页设置](${webUrl})\n需要使用本人的网页账号登录，飞书登录不会自动通用。没有网页账号时，直接在这张卡修改，或私聊告诉我想调整哪一项。`)])] : []),
  ];
  return { schema: '2.0', config: { update_multi: true, enable_forward: false }, header: { template: 'blue', title: plain('Index · 个人设置与使用说明') }, body: { elements } };
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

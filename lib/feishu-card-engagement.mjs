import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export async function readFeishuCardSamplingCoverage(directory = join(CONFIG_DIR, 'feishu-card-reads')) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { return { routes: [], incomplete: error.code !== 'ENOENT', started: false }; }
  const routes = [];
  let incomplete = false;
  for (const name of names.filter(name => name.endsWith('.json'))) {
    try {
      const samples = Object.values(JSON.parse(await readFile(join(directory, name), 'utf8')));
      const eligible = samples.filter(sample => !sample.createdAt || sample.createdAt > Date.now() - 7 * 86_400_000);
      const unavailable = eligible.filter(sample => sample.unavailable).length;
      const pendingPages = eligible.filter(sample => sample.pageToken).length;
      const failures = eligible.filter(sample => sample.errorCode).length;
      incomplete ||= unavailable > 0 || pendingPages > 0 || failures > 0;
      routes.push({ sourceRouteId: name.slice(0, -5), sampledCards: eligible.length, unavailable,
        pendingPages, failures, lastCheckedAt: Math.max(0, ...samples.map(sample => sample.checkedAt || 0)) });
    } catch { incomplete = true; }
  }
  return { routes, incomplete, started: routes.length > 0,
    note: '后台逐张抽取机器人近七天发送的卡片；群已读没有实时推送，尚未检查或检查失败的卡片不能判为未读。' };
}

// These are observed interactions, not personal preferences or reading time.
export function summarizeFeishuCardEngagement(events) {
  const users = new Map(), ids = new Set();
  for (const event of events) {
    if (!['feishu_card_action', 'feishu_card_read'].includes(event.event)
        || event.surface !== 'feishu' || !event.actorKey || !event.objectId || ids.has(event.eventId)) continue;
    ids.add(event.eventId);
    const key = event.personHash || event.actorKey;
    if (!users.has(key)) users.set(key, { personHash: event.personHash || null, actorKeys: new Set(),
      sourceRoutes: new Set(), expandClicks: 0, collapseClicks: 0, rejectedClicks: 0,
      deliveryChoices: { messages: 0, card: 0, default: 0 }, read: new Set(), clicked: new Set(), expanded: new Set() });
    const user = users.get(key);
    user.actorKeys.add(event.actorKey); user.sourceRoutes.add(event.sourceRouteId);
    if (event.event === 'feishu_card_read') { user.read.add(event.objectId); continue; }
    if (event.state !== 'accepted') { user.rejectedClicks++; continue; }
    user.clicked.add(event.objectId);
    if (event.action === 'expand') { user.expandClicks++; user.expanded.add(event.objectId); }
    if (event.action === 'collapse') user.collapseClicks++;
    if (event.action === 'delivery_choice' && Object.hasOwn(user.deliveryChoices, event.mode)) user.deliveryChoices[event.mode]++;
  }
  const byUser = [...users.values()].map(user => ({ personHash: user.personHash,
    actorKeys: [...user.actorKeys], sourceRoutes: [...user.sourceRoutes], expandClicks: user.expandClicks,
    collapseClicks: user.collapseClicks, rejectedClicks: user.rejectedClicks, deliveryChoices: user.deliveryChoices,
    readCards: user.read.size, clickedCards: user.clicked.size, expandedCards: user.expanded.size,
    cardsWithViewSignal: new Set([...user.read, ...user.clicked]).size }));
  return { byUser, totals: byUser.reduce((sum, user) => {
    for (const key of ['expandClicks', 'collapseClicks', 'rejectedClicks', 'readCards', 'clickedCards', 'expandedCards', 'cardsWithViewSignal']) sum[key] += user[key];
    for (const mode of ['messages', 'card', 'default']) sum.deliveryChoices[mode] += user.deliveryChoices[mode];
    return sum;
  }, { expandClicks: 0, collapseClicks: 0, rejectedClicks: 0, readCards: 0, clickedCards: 0, expandedCards: 0,
    cardsWithViewSignal: 0, deliveryChoices: { messages: 0, card: 0, default: 0 } }),
  notes: ['已读是飞书提供的消息阅读信号，不代表认真读完；没有信号时状态未知。',
    '展开次数统计回调被接受的点击；重试去重，折叠、投递选择和失败点击单独统计。',
    '群卡片的展示状态共享，别人展开后直接阅读不会产生本人的展开点击。',
    '只统计采集启动后的观测；按用户和卡片计数，不自动形成偏好或改变工作流。'] };
}

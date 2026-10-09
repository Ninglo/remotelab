import { USAGE_SETTINGS, validSettingObservation } from '../lib/usage-setting-schema.mjs';

export function buildSettingInsights(events, { since, now, snapshot = {}, reliable = true } = {}) {
  const groups = new Map();
  const group = (setting, scope, stage, authority) => {
    const key = [setting, scope, stage, authority].join(':');
    if (!groups.has(key)) groups.set(key, { setting, title: USAGE_SETTINGS[setting].title, scope, stage, authority,
      configurations: 0, subjects: new Set(), values: new Map(), changes: 0, actors: new Set(),
      restoredDefaults: 0, returnsToEarlier: 0, previews: 0, unclassifiedChanges: 0, lastObservedAt: 0 });
    return groups.get(key);
  };
  for (const row of Object.values(snapshot.rows || {})) {
    if (!validSettingObservation(row)) continue;
    const item = group(row.setting, row.scope, row.stage, row.authority);
    item.configurations++; if (row.subjectHash) item.subjects.add(row.subjectHash);
    item.values.set(row.value, (item.values.get(row.value) || 0) + 1);
    item.lastObservedAt = Math.max(item.lastObservedAt, row.lastObservedAt || 0);
  }
  const ids = new Set(), chains = new Map();
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (event.event !== 'setting_state' || event.timestamp < since || event.timestamp > now || ids.has(event.eventId)) continue;
    const row = { setting: event.setting, value: event.settingValue, scope: event.settingScope,
      scopeKey: event.scopeKey, stage: event.stage, authority: event.authority };
    if (!validSettingObservation(row)) continue;
    ids.add(event.eventId);
    const item = group(row.setting, row.scope, row.stage, row.authority);
    const key = [row.setting, row.scopeKey, row.stage].join(':');
    const chain = chains.get(key) || { current: event.previousValue, values: new Set(event.previousValue ? [event.previousValue] : []) };
    if (event.operation === 'preview') item.previews++;
    if (event.operation === 'change' && event.previousValue !== row.value) {
      item.changes++; if (event.personHash && event.actorKind === 'human') item.actors.add(event.personHash);
      if (row.value === USAGE_SETTINGS[row.setting].defaultValue) item.restoredDefaults++;
      if (chain.current !== event.previousValue) chain.values.clear();
      if (chain.values.has(row.value)) item.returnsToEarlier++;
      if (!event.previousValue) item.unclassifiedChanges++;
    } else if (event.operation === 'snapshot' && chain.current !== row.value) {
      // An observed value difference has no attributed save receipt. Do not
      // connect it into a user switchback sequence or invent a choice count.
      chain.values.clear();
    }
    chain.values.add(row.value); chain.current = row.value; chains.set(key, chain);
  }
  return { scope: 'instance', startedAt: snapshot.startedAt || null,
    partial: !reliable || Boolean(snapshot.incomplete || snapshot.writerFailed),
    rows: [...groups.values()].map(item => ({ ...item, subjects: item.subjects.size, actors: item.actors.size,
      values: [...item.values].map(([value, configurations]) => ({ value, title: USAGE_SETTINGS[item.setting].values[value], configurations })),
    })),
    notes: ['当前分布是每个作用范围最后记录到的配置，不是活跃人数或完整设备清单。',
      '变更按本页连续观察时段统计；基础配置属于实例汇总，不受会话筛选。',
      '草案和预览独立于生效配置，初次观测与重复保存不算采用或切换。',
      '开启、关闭与改回都是行为证据，不能单独判断满意度或功能好坏。'] };
}

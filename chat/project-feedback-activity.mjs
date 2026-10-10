const DAY = 86_400_000;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sum = (rows, key) => rows.reduce((n, row) => n + (Number(row[key]) || 0), 0);

// Attention is a reversible presentation choice, not a project verdict or a
// scheduler command. Silence is never converted to a successful quality score.
export function buildFeedbackActivity(projects, records, metadata = {}, usage = null, generatedAt, qianyanActivity = null) {
  const now = Date.parse(generatedAt), recentDays = 14, usageDays = 30;
  const recentStart = now - recentDays * DAY, usageStart = now - usageDays * DAY;
  const groups = new Map((metadata.groups || []).map(g => [g.id, {
    id: g.id, name: g.name, classification_status: g.classification_status || 'trial',
  }]));
  const features = usage?.report?.functions?.features || [];
  const genericStart = date(usage?.report?.functions?.featureStartedAt);
  const rows = projects.map(p => {
    const meta = metadata.projects?.[p.id] || {};
    const own = records.filter(r => r.bucket === 'assigned_feedback' && r.subproject_id === p.id);
    const recent = own.filter(r => Date.parse(r.created_at) >= recentStart && Date.parse(r.created_at) <= now);
    const named = Array.isArray(meta.usage_features) ? [...new Set(meta.usage_features)] : [];
    const matched = features.filter(f => named.includes(f.feature));
    const starts = named.map(feature => date(usage?.featureCollectionStarts?.[feature])
      || (!['feedback', 'project_context', 'work_routing', 'response_progress'].includes(feature) ? genericStart : null));
    const samplingSince = starts.length && starts.every(Boolean)
      ? new Date(Math.max(...starts.map(Date.parse), Date.parse(usage?.collectionStartedAt) || 0,
        Date.parse(usage?.report?.since) || 0)).toISOString() : null;
    const measured = Boolean(named.length && samplingSince && usage && usage.report?.quality?.reliable !== false);
    const completeWindow = measured && Date.parse(samplingSince) <= usageStart;
    const usageFacts = {
      status: !named.length ? 'not_instrumented' : !measured ? 'unknown' : completeWindow ? 'observed' : 'partial_window',
      scope: meta.usage_scope || '', features: named, days: usageDays, sampling_since: samplingSince,
      calls: measured ? sum(matched, 'calls') : null, completed: measured ? sum(matched, 'completed') : null,
      failed: measured ? sum(matched, 'failed') + sum(matched, 'blocked') : null,
      direct_human: measured ? sum(matched, 'directHuman') : null,
      agent: measured ? sum(matched, 'agent') : null, automated: measured ? sum(matched, 'automated') : null,
      latest_at: matched.map(f => date(f.latestAt)).filter(Boolean).sort().at(-1) || null,
    };
    if (meta.usage_source === 'qianyan' && qianyanActivity) {
      // This source retains cumulative buckets, not a rolling event log. Never
      // turn a bucket's recent last_at into a fabricated 30-day count.
      const activity = Object.values(qianyanActivity.activity_counts || {});
      const actions = activity.filter(r => ['detail_open', 'source_open', 'tag_filter', 'daily_copy', 'audio_play', 'document_open'].includes(r.event));
      Object.assign(usageFacts, { status: 'cumulative', days: null, calls: sum(actions, 'count'),
        completed: null, direct_human: sum(actions, 'count'), agent: 0, automated: 0,
        exposures: sum(activity.filter(r => r.event === 'visible'), 'count'),
        by_action: Object.fromEntries([...new Set(actions.map(r => r.event))].map(key => [key, sum(actions.filter(r => r.event === key), 'count')])),
        latest_at: actions.map(r => date(r.last_at)).filter(Boolean).sort().at(-1) || null });
    }
    const startedAt = date(meta.started_at), observationAt = date(meta.observation_started_at);
    const isNew = startedAt && Date.parse(startedAt) <= now && now - Date.parse(startedAt) < recentDays * DAY;
    const pending = own.filter(r => r.review_state === 'collected').length;
    let attention = 'coverage_unknown', rank = 60;
    if (meta.phase === 'paused') { attention = 'paused'; rank = 100; }
    else if (pending) { attention = 'pending_analysis'; rank = 0; }
    else if (recent.length) { attention = 'recent_feedback'; rank = 10; }
    else if (isNew) { attention = 'new_observation'; rank = 20; }
    else if (usageFacts.failed > 0) { attention = 'usage_failures'; rank = 30; }
    else if (meta.phase === 'planned') { attention = 'not_launched'; rank = 70; }
    else if (usageFacts.calls > 0 && usageFacts.status !== 'cumulative') { attention = 'quiet_observation'; rank = 50; }
    else if (usageFacts.status === 'partial_window') { attention = 'sampling_new'; rank = 40; }
    else if (usageFacts.status === 'observed' && (meta.phase === 'existing' || startedAt)) { attention = 'idle_candidate'; rank = 90; }
    const groupId = groups.has(meta.group_id) ? meta.group_id : 'unconfirmed';
    if (!groups.has(groupId)) groups.set(groupId, { id: groupId, name: '归属待确认', classification_status: 'unknown' });
    return { ...p, group_id: groupId, started_at: startedAt, start_kind: meta.start_kind || 'project',
      start_source_url: meta.start_source_url || '', observation_started_at: observationAt,
      phase: meta.phase || 'unknown', recent_feedback_count: recent.length, recent_days: recentDays,
      usage: usageFacts, attention: { state: attention, rank } };
  });
  rows.sort((a, b) => a.attention.rank - b.attention.rank || b.recent_feedback_count - a.recent_feedback_count
    || (b.latest_at || '').localeCompare(a.latest_at || '') || a.name.localeCompare(b.name));
  return { projects: rows, groups: [...groups.values()].map(g => {
    const own = rows.filter(p => p.group_id === g.id);
    return { ...g, subproject_count: own.length, feedback_count: sum(own, 'feedback_count'),
      recent_feedback_count: sum(own, 'recent_feedback_count'), pending_analysis_count: sum(own, 'pending_analysis_count'),
      attention_rank: Math.min(...own.map(p => p.attention.rank)),
      need_attention_count: own.filter(p => p.attention.rank <= 40).length };
  }).filter(g => g.subproject_count).sort((a, b) => a.attention_rank - b.attention_rank || a.name.localeCompare(b.name)),
  policy: { recent_days: recentDays, new_project_days: recentDays, usage_days: usageDays,
    effect: 'display_only', date_basis: 'explicit_source_only', silence_is_not_quality: true } };
}

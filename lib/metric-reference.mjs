const DAY = 86400000;
export const metricDay = at => Math.floor((at + 3 * 3600000) / DAY);
export const metricDate = date => new Date(date * DAY).toISOString().slice(0, 10);
const calendarDate = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const sessions = rows => new Set(rows.map(row => row.sessionId)).size;

export function metricReferencePolicy(policy = {}) {
  return {
    version: 2,
    referenceDays: Number.isInteger(policy.referenceDays) && policy.referenceDays >= 3 && policy.referenceDays <= 10 ? policy.referenceDays : 7,
    excludedDates: [...new Set((Array.isArray(policy.excludedDates) ? policy.excludedDates : [])
      .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort(),
  };
}

export function metricExcluded(row, policy) {
  // Rest dates are explicit Beijing calendar dates, never inferred weekends.
  return policy.excludedDates.includes(calendarDate(row.responseAt));
}

export function metricReferenceDays(rows, beforeDay, policy, { minRuns = 5, minSessions = 2 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const date = metricDay(row.responseAt);
    if (date >= beforeDay || metricExcluded(row, policy) || policy.excludedDates.includes(metricDate(date))) continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(row);
  }
  const points = [...groups].sort(([a], [b]) => b - a)
    .map(([date, rows]) => ({ date, day: metricDate(date), rows, count: rows.length, sessions: sessions(rows) }));
  return {
    selected: points.filter(point => point.count >= minRuns && point.sessions >= minSessions).slice(0, policy.referenceDays),
    skipped: points.filter(point => point.count < minRuns || point.sessions < minSessions)
      .map(({ rows, ...point }) => point),
  };
}

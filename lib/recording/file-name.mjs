// Human-facing names; internal segment paths and retry identities stay stable.
export function recordingFileName(record, index = 0) {
  const clean = value => String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 60);
  const timeZone = record.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let interval;
  try {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const parts = value => Object.fromEntries(format.formatToParts(new Date(value)).map(p => [p.type, p.value]));
    const date = p => `${p.year}-${p.month}-${p.day}`, time = p => `${p.hour}-${p.minute}-${p.second}`;
    const start = parts(record.startedAt), end = parts(record.endedAt);
    interval = `${date(start)}_${time(start)}至${date(start) === date(end) ? '' : date(end) + '_'}${time(end)}`;
  } catch { interval = `录音-${clean(record.id || '时间未知')}`; }
  const speakers = (Array.isArray(record.speakers) ? record.speakers : []).filter(s => s?.verified === true && typeof s.name === 'string' && s.name.trim());
  const primary = speakers.length === 1 ? speakers[0] : speakers.find(s => s.primary === true);
  const name = primary ? `_${clean(primary.name)}` : '';
  const part = record.segments?.length > 1 ? `_第${String(index + 1).padStart(2, '0')}段` : '';
  const testLabel = String(record.label || '').includes('测试') ? clean(record.label) + '-' : '';
  return `${testLabel}${interval}${name}${part}.wav`;
}

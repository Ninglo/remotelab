// A deterministic pet scene for the existing authenticated preview renderer.
// No Session scan, model call, network fetch, or mutable process-global settings.
const WIDTH = 1920;
const HEIGHT = 480;
const FONT = 'Noto Sans CJK SC,sans-serif';
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) bad(`Invalid companion ${label}`);
  return value.trim();
};
const xml = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function validateCompanion(payload) {
  if (payload?.version !== 22) bad('Invalid companion version');
  text(payload.timeZone, 80, 'time zone');
  try { new Intl.DateTimeFormat('en', { timeZone: payload.timeZone }); } catch { bad('Invalid companion time zone'); }
  text(payload.subject, 40, 'subject');
  text(payload.sentence, 60, 'sentence');
  if (!Number.isFinite(Date.parse(payload.observedAt)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(payload.observedAt)) bad('Companion observation needs an explicit time zone');
  text(payload.weatherCity, 32, 'weather city');
  text(payload.credit, 100, 'asset credit');
  if (!Array.isArray(payload.actions) || payload.actions.length < 1 || payload.actions.length > 6) bad('Companion requires 1–6 actions');
  let bytes = 0;
  for (const action of payload.actions) {
    text(action.name, 32, 'action name');
    if (typeof action.gifBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(action.gifBase64)) bad('Invalid companion GIF');
    const gif = Buffer.from(action.gifBase64, 'base64');
    if (gif.toString('base64') !== action.gifBase64 || gif.length > 3 * 1024 * 1024 || !/^GIF8[79]a/.test(gif.toString('ascii', 0, 6))) bad('Invalid companion GIF');
    bytes += action.gifBase64.length;
  }
  if (bytes > 8 * 1024 * 1024) bad('Companion actions exceed request size');
}

function formatDate(now, timeZone, options) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, ...options }).format(new Date(now));
}
function weatherLabel(code) {
  if (code === 0) return '晴';
  if ([1, 2, 3].includes(code)) return '多云';
  if ([45, 48].includes(code)) return '雾';
  if ([51, 53, 55, 56, 57].includes(code)) return '毛毛雨';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
  if ([95, 96, 99].includes(code)) return '雷雨';
  return '天气';
}
function wrapSentence(value, max = 20) {
  const clauses = value.split('；');
  if (clauses.length === 2 && clauses.every(line => [...line].length <= max)) return [clauses[0] + '；', clauses[1]];
  const chars = [...value];
  const lines = [];
  while (chars.length) {
    let take = Math.min(max, chars.length);
    // Avoid a punctuation-only next line.
    if (/^[，。；！？、]/.test(chars[take] || '')) take += 1;
    lines.push(chars.splice(0, take).join(''));
  }
  return lines;
}

export function companionScene(payload, weather = null, nowMs = Date.now()) {
  validateCompanion(payload);
  const clock = formatDate(nowMs, payload.timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = formatDate(nowMs, payload.timeZone, { month: '2-digit', day: '2-digit', weekday: 'long' });
  const observed = formatDate(Date.parse(payload.observedAt), payload.timeZone, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const actionIndex = Math.floor(nowMs / 60_000) % payload.actions.length;
  const action = payload.actions[actionIndex];
  const lines = wrapSentence(payload.sentence);
  const weatherValid = weather && Number.isFinite(weather.temperature) && Number.isInteger(weather.code) && typeof weather.observedAt === 'string';
  const weatherText = weatherValid ? `${payload.weatherCity}  ${Math.round(weather.temperature)}°  ${weatherLabel(weather.code)}` : `${payload.weatherCity}天气暂不可用`;
  const weatherTime = weatherValid && /T\d{2}:\d{2}/.test(weather.observedAt) ? weather.observedAt.slice(11, 16) : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="1920" height="480" fill="#f4f1ed"/>
    <ellipse cx="244" cy="427" rx="125" ry="13" fill="#dce0e5"/>
    <path d="M516 160 Q516 105 571 105 H1398 Q1453 105 1453 160 V321 Q1453 376 1398 376 H571 Q516 376 516 321 V279 L470 301 L516 237Z" fill="#dfe3ea" transform="translate(0,6)" opacity=".6"/>
    <path d="M516 155 Q516 100 571 100 H1398 Q1453 100 1453 155 V316 Q1453 371 1398 371 H571 Q516 371 516 316 V274 L470 296 L516 232Z" fill="#fff"/>
    <text x="565" y="150" fill="#7b8090" font-family="${FONT}" font-size="23">${xml(payload.subject)} · 结论记录 ${xml(observed)}</text>
    ${lines.map((line, i) => `<text x="565" y="${lines.length > 2 ? 214 + i * 57 : 238 + i * 70}" font-family="${FONT}" font-size="40" font-weight="700" fill="#333f58">${xml(line)}</text>`).join('')}
    <text x="1680" y="201" text-anchor="middle" font-family="${FONT}" font-size="91" font-weight="500" fill="#333f58">${xml(clock)}</text>
    <text x="1680" y="252" text-anchor="middle" font-family="${FONT}" font-size="25" fill="#777d8e">${xml(day)}</text>
    <text x="1680" y="314" text-anchor="middle" font-family="${FONT}" font-size="30" fill="#45546b">${xml(weatherText)}</text>
    <text x="1680" y="351" text-anchor="middle" font-family="${FONT}" font-size="18" fill="#8b909a">${weatherValid ? `Open-Meteo · ${xml(weatherTime)}` : '稍后自动重试'}</text>
    <text x="1866" y="452" text-anchor="end" font-family="${FONT}" font-size="15" fill="#999ca5">${xml(payload.credit)}</text>
  </svg>`;
  return { svg, animations: [{ gifBase64: action.gifBase64, box: { x: 23, y: 20, width: 442, height: 422 }, fit: 'contain' }],
    meta: { clock, observed, weatherText, weatherTime, action: action.name, actionIndex } };
}

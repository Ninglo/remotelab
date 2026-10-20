// Candidate: preserve the v22 signature and the existing local-GIF transport.
// This module returns a complete opaque background and an unchanged GIF layer.
export const LAYOUT = Object.freeze({
  width: 1920, height: 480,
  pet: Object.freeze({ x: 1466, y: 20, width: 442, height: 422 }),
  bubble: Object.freeze({ x: 466, y: 58, width: 938, height: 366 }),
  text: Object.freeze({ x: 518, width: 834 }),
});
const FONT = 'Noto Sans CJK SC,sans-serif';
const bad = message => { throw Object.assign(new TypeError(message), { status: 400 }); };
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) bad(`Invalid companion ${name}`);
  return value.trim();
};
const isoTime = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

function observationFor(payload) {
  if (payload.observation !== undefined) return payload.observation;
  return { kind: 'result', subject: payload.subject, sentence: payload.sentence,
    observedAt: payload.observedAt, label: '记录时间' };
}
export function validateCompanion(payload) {
  if (payload?.version !== 22) bad('version');
  // The commissioned screen keeps Beijing time/weather.
  if (payload.timeZone !== 'Asia/Shanghai' || payload.weatherCity !== '北京') bad('Beijing time/weather');
  text(payload.credit, 100, 'asset credit');
  const observation = observationFor(payload);
  if (!observation || !['result', 'attention', 'rest', 'quiet'].includes(observation.kind)) bad('observation kind');
  text(observation.subject, 40, 'subject');
  text(observation.sentence, 60, 'sentence');
  if (['result', 'attention'].includes(observation.kind)) {
    if (!isoTime(observation.observedAt)) bad('observation timestamp needs an explicit time zone');
    text(observation.label, 16, 'observation label');
  } else if (observation.observedAt != null) bad('reminder must not claim a source timestamp');
  if (payload.libraryId !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(payload.libraryId)) bad('library id');
  if (!payload.libraryId && (!Array.isArray(payload.actions) || payload.actions.length < 1)) bad('1–6 actions required');
  if (payload.actions !== undefined && (!Array.isArray(payload.actions) || payload.actions.length < 1 || payload.actions.length > 6)) bad('1–6 actions required');
  let bytes = 0;
  for (const action of payload.actions || []) {
    text(action.name, 64, 'action name');
    if (typeof action.gifBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(action.gifBase64)) bad('GIF');
    const gif = Buffer.from(action.gifBase64, 'base64');
    if (gif.toString('base64') !== action.gifBase64 || gif.length > 3 * 1024 * 1024
      || !/^GIF8[79]a/.test(gif.toString('ascii', 0, 6))) bad('GIF');
    bytes += action.gifBase64.length;
  }
  if (bytes > 12 * 1024 * 1024) bad('request size');
  if (payload.libraryInfo) {
    const info = payload.libraryInfo;
    if (!Number.isSafeInteger(info.total) || info.total < 1) bad('library total');
    text(info.category, 24, 'category');
    text(info.actionName, 64, 'library action name');
  }
}

const date = (at, options) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...options }).format(new Date(at));
export function wrapSentence(value, max = 20, keepWords = true) {
  const clauses = value.split('；');
  if (clauses.length === 2 && [...clauses[0]].length < max && [...clauses[1]].length <= max) {
    return [clauses[0] + '；', clauses[1]];
  }
  const chars = [...value], lines = [];
  while (chars.length) {
    let take = Math.min(max, chars.length);
    // Leave punctuation with its clause while retaining EVERY character.
    if (/^[，。；！？、：）】]/.test(chars[take] || '') && take > 1) take--;
    if (keepWords && /[A-Za-z0-9]/.test(chars[take - 1] || '') && /[A-Za-z0-9]/.test(chars[take] || '')) {
      let wordStart = take;
      while (wordStart > 0 && /[A-Za-z0-9]/.test(chars[wordStart - 1])) wordStart--;
      if (wordStart > 0) take = wordStart;
    }
    lines.push(chars.splice(0, take).join(''));
  }
  // Bound vertical space even when many Latin words would leave short lines.
  if (keepWords && lines.length > 4) return wrapSentence(value, max, false);
  return lines;
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
export function describeWeather(weather, nowMs) {
  // Existing weather-source uses local ISO without offset; only for Beijing
  // attach +08:00 explicitly, never use the server host's timezone.
  const raw = weather?.observedAt;
  const explicit = typeof raw === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(raw) ? `${raw}+08:00` : raw;
  const at = isoTime(explicit) ? Date.parse(explicit) : NaN;
  const valid = Number.isFinite(weather?.temperature) && Number.isInteger(weather?.code)
    && Number.isFinite(at) && at <= nowMs && nowMs - at <= 90 * 60_000;
  if (!valid) return { text: '北京天气暂不可用', detail: '等待天气更新', observedAt: null };
  const time = date(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { text: `北京  ${Math.round(weather.temperature)}°  ${weatherLabel(weather.code)}`,
    detail: `Open-Meteo · ${time}`, observedAt: new Date(at).toISOString() };
}
const THEMES = {
  result: { label: '最近结论', ink: '#496e61', chip: '#e7eee8' },
  attention: { label: '待确认记录', ink: '#98683b', chip: '#f4e8d8' },
  rest: { label: '歇一小会', ink: '#6b6389', chip: '#eeebf4' },
  quiet: { label: '陪伴中', ink: '#697484', chip: '#edf0f3' },
};

export function companionScene(payload, weather = null, nowMs = Date.now()) {
  validateCompanion(payload);
  if (!Number.isFinite(nowMs)) bad('nowMs');
  if (!payload.actions?.length) bad('library must be loaded before rendering');
  const observation = observationFor(payload), theme = THEMES[observation.kind];
  const clock = date(nowMs, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = date(nowMs, { month: 'long', day: 'numeric', weekday: 'long' });
  const observed = observation.observedAt ? date(Date.parse(observation.observedAt),
    { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
  const lines = wrapSentence(observation.sentence);
  const fontSize = lines.length > 3 ? 35 : 40;
  const firstY = lines.length === 1 ? 270 : lines.length === 2 ? 246 : lines.length > 3 ? 226 : 236;
  const lineHeight = lines.length > 3 ? 42 : 58;
  const actionIndex = Math.floor(nowMs / 60_000) % payload.actions.length;
  const action = payload.actions[actionIndex];
  const gif = Buffer.from(action.gifBase64, 'base64');
  const sourceWidth = gif.readUInt16LE(6), sourceHeight = gif.readUInt16LE(8);
  if (!sourceWidth || !sourceHeight) bad('GIF dimensions');
  const width = Math.min(LAYOUT.pet.width, Math.round(sourceWidth * LAYOUT.pet.height / sourceHeight));
  const petBox = { ...LAYOUT.pet, x: 1920 - 12 - width, width };
  const petCenter = petBox.x + petBox.width / 2;
  const weatherInfo = describeWeather(weather, nowMs);
  // Pure metadata: total means available library items, never completed work.
  const library = payload.libraryInfo;
  const libraryText = library ? `${library.category} · ${library.actionName}` : ({ wave: '元气挥手', stretch: '伸个懒腰', think: '思考冒泡' }[action.name] || action.name);
  const shortLibraryText = [...libraryText].length > 27 ? [...libraryText].slice(0, 26).join('') + '…' : libraryText;
  const sourceLine = observed ? `${observation.label} · ${observed}` : observation.kind === 'rest' ? '抬头放松一下' : '留一点轻松给自己';
  const subjectSize = [...observation.subject].length > 27 ? 20 : 25;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="480" viewBox="0 0 1920 480">
  <rect width="1920" height="480" fill="#f4f1ed"/>
  <ellipse cx="${petCenter}" cy="427" rx="125" ry="13" fill="#dce0e5"/>
  <path d="M516 104 Q516 58 562 58 H1408 Q1454 58 1454 104 V378 Q1454 424 1408 424 H562 Q516 424 516 378 V278 L470 298 L516 235Z" fill="#e5e4e3" transform="translate(1920 5) scale(-1 1)"/>
  <path d="M516 104 Q516 58 562 58 H1408 Q1454 58 1454 104 V378 Q1454 424 1408 424 H562 Q516 424 516 378 V278 L470 298 L516 235Z" fill="#fffdfb" transform="translate(1920 0) scale(-1 1)"/>
  <g transform="translate(-50 0)">
  <rect x="568" y="87" width="128" height="38" rx="19" fill="${theme.chip}"/>
  <text data-fit="chip" x="632" y="113" text-anchor="middle" fill="${theme.ink}" font-family="${FONT}" font-size="21" font-weight="500">${theme.label}</text>
  <text data-fit="subject" x="568" y="168" fill="#737c89" font-family="${FONT}" font-size="${subjectSize}">${xml(observation.subject)}</text>
  ${lines.map((line, index) => `<text data-fit="sentence" x="568" y="${firstY + index * lineHeight}" fill="#333f58" font-family="${FONT}" font-size="${fontSize}" font-weight="700">${xml(line)}</text>`).join('\n')}
  <circle cx="572" cy="390" r="3" fill="${theme.ink}"/>
  <text data-fit="source" x="588" y="397" fill="#7c8490" font-family="${FONT}" font-size="19">${xml(sourceLine)}</text>
  </g>
  <g transform="translate(-1440 0)">
  <path d="M1857 98 V382" stroke="#dededc" stroke-width="1"/>
  <text x="1680" y="119" text-anchor="middle" fill="#818590" font-family="${FONT}" font-size="19" letter-spacing="3">北京时间</text>
  <text data-fit="clock" x="1680" y="222" text-anchor="middle" fill="#333f58" font-family="${FONT}" font-size="94" font-weight="500">${xml(clock)}</text>
  <text data-fit="date" x="1680" y="269" text-anchor="middle" fill="#737c89" font-family="${FONT}" font-size="25">${xml(day)}</text>
  <text data-fit="weather" x="1680" y="331" text-anchor="middle" fill="#45546b" font-family="${FONT}" font-size="${weatherInfo.observedAt ? 30 : 26}">${xml(weatherInfo.text)}</text>
  <text data-fit="weather-source" x="1680" y="367" text-anchor="middle" fill="#7c8490" font-family="${FONT}" font-size="18">${xml(weatherInfo.detail)}</text>
  </g>
  <text data-fit="library" x="${petCenter}" y="465" text-anchor="middle" fill="#7c8490" font-family="${FONT}" font-size="16">${xml(shortLibraryText)}</text>
  <text x="1404" y="463" text-anchor="end" fill="#92969e" font-family="${FONT}" font-size="14">${library ? `动作库 ${library.total}` : ''}</text>
  <text x="410" y="463" text-anchor="end" fill="#92969e" font-family="${FONT}" font-size="13">${xml(payload.credit)}</text>
  </svg>`;
  return { svg, animations: [{ gifBase64: action.gifBase64, box: petBox, fit: 'contain', completeLoop: true }],
    meta: { clock, observed, sourceLabel: observation.label, kind: observation.kind,
      weatherText: weatherInfo.text, weatherTime: weatherInfo.observedAt,
      action: action.name, actionIndex, libraryInfo: library || null, lines } };
}

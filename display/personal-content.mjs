import { Resvg } from '@resvg/resvg-js';
import { decodeGifFrames } from './gif-frames.mjs';

export function normalizeSentence(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Enter one sentence'), { status: 400 });
  const sentence = value.replace(/\s+/g, ' ').trim();
  if (!sentence || Array.from(sentence).length > 48) {
    throw Object.assign(new Error('Sentence must contain 1–48 characters'), { status: 400 });
  }
  return sentence;
}

export function decodeGifBase64(value) {
  if (typeof value !== 'string' || !value || value.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw Object.assign(new Error('Upload a GIF no larger than 3 MB'), { status: 400 });
  }
  const gif = Buffer.from(value, 'base64');
  if (gif.length > 3 * 1024 * 1024 || gif.toString('base64') !== value) {
    throw Object.assign(new Error('Invalid GIF upload'), { status: 400 });
  }
  return gif;
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function prepareContent(entry) {
  const gif = decodeGifBase64(entry.gifBase64);
  return { ...decodeGifFrames(gif), sentence: normalizeSentence(entry.sentence), gif };
}

export function renderPersonalPng(content, nowMs = Date.now()) {
  const elapsed = nowMs % content.durationMs;
  const frame = content.frames.findLast((item) => item.startMs <= elapsed) || content.frames[0];
  const words = Array.from(content.sentence);
  const lines = [];
  for (let i = 0; i < words.length; i += 16) lines.push(words.slice(i, i + 16).join(''));
  const firstY = 250 - ((lines.length - 1) * 35);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="480" viewBox="0 0 1920 480">
    <rect width="1920" height="480" fill="#0b1118"/>
    <rect x="24" y="24" width="930" height="432" rx="20" fill="#151f29"/>
    <image x="24" y="24" width="930" height="432" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${frame.png.toString('base64')}"/>
    <path d="M997 56V424" stroke="#33424f" stroke-width="2"/>
    <text x="1045" y="95" fill="#91a6b5" font-size="26" font-family="PingFang SC,Noto Sans CJK SC,sans-serif">一句话</text>
    ${lines.map((line, index) => `<text x="1045" y="${firstY + index * 70}" fill="#f2f6f8" font-size="54" font-weight="700" font-family="PingFang SC,Noto Sans CJK SC,sans-serif">${xml(line)}</text>`).join('')}
  </svg>`;
  const renderer = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' } });
  return Buffer.from(renderer.render().asPng());
}

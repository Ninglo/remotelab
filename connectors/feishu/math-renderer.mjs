import { createHash } from 'crypto';

const MAX_LATEX_SOURCE_LENGTH = 12_000;
const MAX_SVG_BYTES = 4 * 1024 * 1024;
const MAX_PNG_BYTES = 9 * 1024 * 1024;
const MAX_FORMULA_CACHE_ENTRIES = 256;
const FORMULA_RENDER_VERSION = 'mathjax4-png-v1';
const DISPLAY_ENVIRONMENTS = new Set([
  'Bmatrix',
  'Vmatrix',
  'align',
  'align*',
  'aligned',
  'alignedat',
  'array',
  'bmatrix',
  'cases',
  'equation',
  'equation*',
  'gather',
  'gather*',
  'matrix',
  'multline',
  'multline*',
  'pmatrix',
  'smallmatrix',
  'split',
  'vmatrix',
]);
const UNSAFE_LATEX_PATTERN = /\\(?:DeclareMathOperator|bbox|catcode|class|csname|cssId|def|expandafter|futurelet|href|htmlClass|htmlData|htmlId|htmlStyle|includegraphics|input|let|loop|newcommand|renewcommand|repeat|require|style|unicode|url)\b/i;

const SIMPLE_INLINE_COMMAND_TEXT = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  omicron: 'ο',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  cdot: '·',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  equiv: '≡',
  approx: '≈',
  sim: '∼',
  simeq: '≃',
  propto: '∝',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  forall: '∀',
  exists: '∃',
  neg: '¬',
  land: '∧',
  lor: '∨',
  mid: '∣',
  vert: '|',
  Vert: '‖',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  to: '→',
  mapsto: '↦',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  max: 'max',
  min: 'min',
  sup: 'sup',
  inf: 'inf',
  lim: 'lim',
  log: 'log',
  ln: 'ln',
  exp: 'exp',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  Pr: 'Pr',
};

const SIMPLE_GROUP_COMMANDS = new Set([
  'mathrm',
  'mathbf',
  'mathit',
  'mathsf',
  'mathtt',
  'mathcal',
  'mathbb',
  'mathfrak',
  'operatorname',
  'text',
]);
const SIMPLE_IGNORED_COMMANDS = new Set([
  'left',
  'right',
]);
const SIMPLE_SPACE_COMMANDS = new Set([
  'quad',
  'qquad',
]);
const COMPLEX_INLINE_COMMANDS = new Set([
  'begin',
  'cases',
  'dfrac',
  'frac',
  'int',
  'oint',
  'overset',
  'prod',
  'sqrt',
  'stackrel',
  'sum',
  'tfrac',
  'underbrace',
  'underset',
]);
const SUPERSCRIPT_CHARS = {
  0: '⁰',
  1: '¹',
  2: '²',
  3: '³',
  4: '⁴',
  5: '⁵',
  6: '⁶',
  7: '⁷',
  8: '⁸',
  9: '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};
const SUBSCRIPT_CHARS = {
  0: '₀',
  1: '₁',
  2: '₂',
  3: '₃',
  4: '₄',
  5: '₅',
  6: '₆',
  7: '₇',
  8: '₈',
  9: '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

let mathJaxPromise = null;
let resvgPromise = null;
const runtimeFormulaResolvers = new WeakMap();

function normalizeLatexSource(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function assertSafeLatex(value) {
  const source = normalizeLatexSource(value);
  if (!source) throw new Error('LaTeX source is empty');
  if (source.length > MAX_LATEX_SOURCE_LENGTH) {
    throw new Error(`LaTeX source exceeds ${MAX_LATEX_SOURCE_LENGTH} characters`);
  }
  if (UNSAFE_LATEX_PATTERN.test(source)) {
    throw new Error('Unsafe or unsupported LaTeX command');
  }
  return source;
}

async function getMathJax() {
  if (!mathJaxPromise) {
    mathJaxPromise = (async () => {
      const { init: initMathJax } = await import('mathjax');
      return initMathJax({
        loader: {
          load: ['input/tex', 'output/svg'],
        },
        svg: {
          fontCache: 'local',
        },
        tex: {
          packages: {
            '[-]': ['autoload', 'html', 'noundefined', 'require'],
          },
          formatError(_jax, error) {
            throw error;
          },
        },
      });
    })();
  }
  return mathJaxPromise;
}

async function getResvg() {
  if (!resvgPromise) {
    resvgPromise = import('@resvg/resvg-js').then((module) => module.Resvg);
  }
  return resvgPromise;
}

async function renderLatexToSvg(value, { display = false } = {}) {
  const source = assertSafeLatex(value);
  const MathJax = await getMathJax();
  const node = await MathJax.tex2svgPromise(source, { display });
  const markup = MathJax.startup.adaptor.outerHTML(node);
  const start = markup.indexOf('<svg');
  const end = markup.lastIndexOf('</svg>');
  if (start < 0 || end < start) {
    throw new Error('MathJax did not produce SVG output');
  }
  const svg = markup.slice(start, end + 6);
  if (Buffer.byteLength(svg) > MAX_SVG_BYTES) {
    throw new Error(`Rendered formula SVG exceeds ${MAX_SVG_BYTES} bytes`);
  }
  if (/(?:href|xlink:href)=["'](?!#)/i.test(svg)) {
    throw new Error('Rendered formula contains an external resource');
  }
  return svg;
}

export async function renderLatexToPng(value, { display = false } = {}) {
  const svg = await renderLatexToSvg(value, { display });
  const Resvg = await getResvg();
  const measurement = new Resvg(svg, {
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'sans-serif',
    },
  });
  const zoom = Math.max(0.1, Math.min(
    2,
    1600 / Math.max(1, measurement.width),
    1200 / Math.max(1, measurement.height),
  ));
  const renderer = new Resvg(svg, {
    background: '#ffffff',
    fitTo: {
      mode: 'zoom',
      value: zoom,
    },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'sans-serif',
    },
  });
  const png = Buffer.from(renderer.render().asPng());
  if (png.length > MAX_PNG_BYTES) {
    throw new Error(`Rendered formula PNG exceeds ${MAX_PNG_BYTES} bytes`);
  }
  return png;
}

function isEscapedAt(value, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function looksLikeMathSource(value) {
  const text = normalizeLatexSource(value);
  return Boolean(text) && /(?:\\[a-zA-Z]+|[_^=+\-*/<>]|[{}]|\d)/.test(text);
}

function readBalancedGroup(text, startIndex) {
  let cursor = startIndex;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (text[cursor] !== '{') return null;
  let depth = 0;
  for (let index = cursor; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          text: text.slice(cursor + 1, index),
          end: index + 1,
        };
      }
    }
  }
  return null;
}

function latexCommandNames(source) {
  return Array.from(source.matchAll(/\\([a-zA-Z]+)/g), (match) => match[1]);
}

function isSimpleInlineLatex(source) {
  if (source.length > 120 || source.includes('\n')) return false;
  const commands = latexCommandNames(source);
  for (const command of commands) {
    if (COMPLEX_INLINE_COMMANDS.has(command)) return false;
    if (
      !Object.hasOwn(SIMPLE_INLINE_COMMAND_TEXT, command)
      && !SIMPLE_GROUP_COMMANDS.has(command)
      && !SIMPLE_IGNORED_COMMANDS.has(command)
      && !SIMPLE_SPACE_COMMANDS.has(command)
    ) {
      return false;
    }
  }
  return true;
}

function renderScriptText(text, map, fallbackMarker) {
  const rendered = renderSimpleLatexText(text);
  const characters = Array.from(rendered);
  if (characters.every((char) => Object.hasOwn(map, char))) {
    return characters.map((char) => map[char]).join('');
  }
  return `${fallbackMarker}(${rendered})`;
}

function convertLatexScripts(text, marker, map) {
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(marker, cursor);
    if (index < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, index);
    const group = readBalancedGroup(text, index + 1);
    if (group) {
      output += renderScriptText(group.text, map, marker);
      cursor = group.end;
      continue;
    }
    const next = text[index + 1] || '';
    output += Object.hasOwn(map, next) ? map[next] : `${marker}${next}`;
    cursor = index + (next ? 2 : 1);
  }
  return output;
}

function replaceGroupCommands(text) {
  let output = '';
  let cursor = 0;
  const pattern = /\\([a-zA-Z]+)/g;
  while (cursor < text.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (!match) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, match.index);
    const command = match[1];
    if (SIMPLE_GROUP_COMMANDS.has(command)) {
      const group = readBalancedGroup(text, pattern.lastIndex);
      if (group) {
        output += renderSimpleLatexText(group.text);
        cursor = group.end;
        continue;
      }
    }
    if (SIMPLE_IGNORED_COMMANDS.has(command)) {
      cursor = pattern.lastIndex;
      continue;
    }
    if (SIMPLE_SPACE_COMMANDS.has(command)) {
      output += command === 'qquad' ? '  ' : ' ';
      cursor = pattern.lastIndex;
      continue;
    }
    output += Object.hasOwn(SIMPLE_INLINE_COMMAND_TEXT, command)
      ? SIMPLE_INLINE_COMMAND_TEXT[command]
      : match[0];
    cursor = pattern.lastIndex;
  }
  return output;
}

function renderSimpleLatexText(value) {
  let text = normalizeLatexSource(value);
  text = replaceGroupCommands(text);
  text = text
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\([{}_$%#&])/g, '$1');
  text = convertLatexScripts(text, '^', SUPERSCRIPT_CHARS);
  text = convertLatexScripts(text, '_', SUBSCRIPT_CHARS);
  return text
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findClosingDollar(value, startIndex) {
  for (let cursor = startIndex; cursor < value.length; cursor += 1) {
    if (value[cursor] === '$' && value[cursor + 1] !== '$' && !isEscapedAt(value, cursor)) {
      return cursor;
    }
  }
  return -1;
}

function findNextInlineMathStart(value, startIndex) {
  for (let cursor = startIndex; cursor < value.length; cursor += 1) {
    if (value[cursor] === '`' && !isEscapedAt(value, cursor)) {
      const marker = value[cursor + 1] === '`' && value[cursor + 2] === '`' ? '```' : '`';
      const closeIndex = value.indexOf(marker, cursor + marker.length);
      if (closeIndex < 0) return null;
      cursor = closeIndex + marker.length - 1;
      continue;
    }
    if (value[cursor] === '$' && value[cursor + 1] !== '$' && !isEscapedAt(value, cursor)) {
      return {
        index: cursor,
        marker: '$',
        closeMarker: '$',
        contentStart: cursor + 1,
      };
    }
    if (value[cursor] === '\\' && value[cursor + 1] === '(' && !isEscapedAt(value, cursor)) {
      return {
        index: cursor,
        marker: '\\(',
        closeMarker: '\\)',
        contentStart: cursor + 2,
      };
    }
  }
  return null;
}

function splitInlineMathSegments(line) {
  const segments = [];
  let cursor = 0;
  while (cursor < line.length) {
    const start = findNextInlineMathStart(line, cursor);
    if (!start) {
      segments.push({ type: 'text', text: line.slice(cursor) });
      break;
    }
    const closeIndex = start.marker === '$'
      ? findClosingDollar(line, start.contentStart)
      : line.indexOf(start.closeMarker, start.contentStart);
    if (closeIndex < 0) {
      segments.push({ type: 'text', text: line.slice(cursor) });
      break;
    }
    const source = line.slice(start.contentStart, closeIndex);
    if (!looksLikeMathSource(source)) {
      segments.push({
        type: 'text',
        text: line.slice(cursor, closeIndex + start.closeMarker.length),
      });
      cursor = closeIndex + start.closeMarker.length;
      continue;
    }
    if (start.index > cursor) {
      segments.push({ type: 'text', text: line.slice(cursor, start.index) });
    }
    segments.push({
      type: 'math_source',
      source: normalizeLatexSource(source),
      raw: line.slice(start.index, closeIndex + start.closeMarker.length),
    });
    cursor = closeIndex + start.closeMarker.length;
  }
  return segments.filter((segment) => segment.text !== '');
}

function reportFormulaError(onFormulaError, error, formula) {
  if (typeof onFormulaError !== 'function') return;
  try {
    onFormulaError(error, formula);
  } catch {}
}

async function resolveInlineMathSegments(line, resolveFormulaImage, onFormulaError) {
  const output = [];
  for (const segment of splitInlineMathSegments(line)) {
    if (segment.type !== 'math_source') {
      output.push(segment);
      continue;
    }
    const formula = {
      source: segment.source,
      display: false,
    };
    try {
      await renderLatexToSvg(segment.source, { display: false });
      if (isSimpleInlineLatex(segment.source)) {
        const text = renderSimpleLatexText(segment.source);
        if (text && !/\\[a-zA-Z]+/.test(text)) {
          output.push({
            type: 'inline_math',
            source: segment.source,
            text,
          });
          continue;
        }
      }
      if (resolveFormulaImage) {
        const imageKey = await resolveFormulaImage(formula);
        if (imageKey) {
          output.push({
            type: 'formula_image',
            source: segment.source,
            imageKey,
          });
          continue;
        }
      }
      output.push({
        type: 'text',
        text: segment.raw,
      });
    } catch (error) {
      reportFormulaError(onFormulaError, error, formula);
      output.push({
        type: 'text',
        text: segment.raw,
      });
    }
  }
  return output;
}

function parseDisplayStart(trimmed) {
  if (trimmed.startsWith('$$')) {
    return {
      marker: '$$',
      endMarker: '$$',
      rest: trimmed.slice(2),
    };
  }
  if (trimmed.startsWith('\\[')) {
    return {
      marker: '\\[',
      endMarker: '\\]',
      rest: trimmed.slice(2),
    };
  }
  const environment = trimmed.match(/^\\begin\{([^{}]+)\}/);
  if (environment && DISPLAY_ENVIRONMENTS.has(environment[1])) {
    return {
      marker: environment[0],
      endMarker: `\\end{${environment[1]}}`,
      rest: trimmed,
      includeMarkers: true,
    };
  }
  return null;
}

function consumeDisplayFormula(lines, startIndex, start) {
  const sourceLines = [];
  let cursor = startIndex;
  let first = start.rest;
  if (start.includeMarkers) {
    const inlineEnd = first.indexOf(start.endMarker, start.marker.length);
    if (inlineEnd >= 0) {
      return {
        source: first.slice(0, inlineEnd + start.endMarker.length),
        endIndex: startIndex,
      };
    }
    sourceLines.push(first);
    first = '';
  } else {
    const inlineEnd = first.indexOf(start.endMarker);
    if (inlineEnd >= 0) {
      return {
        source: first.slice(0, inlineEnd).trim(),
        endIndex: startIndex,
      };
    }
    if (first) sourceLines.push(first);
  }
  for (cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    const endIndex = line.lastIndexOf(start.endMarker);
    if (endIndex >= 0) {
      if (start.includeMarkers) {
        sourceLines.push(line.slice(0, endIndex + start.endMarker.length));
      } else if (line.slice(0, endIndex)) {
        sourceLines.push(line.slice(0, endIndex));
      }
      return {
        source: sourceLines.join('\n').trim(),
        endIndex: cursor,
      };
    }
    sourceLines.push(line);
  }
  return null;
}

async function buildFormulaBlock(source, resolveFormulaImage, onFormulaError) {
  const normalized = normalizeLatexSource(source);
  const formula = {
    source: normalized,
    display: true,
  };
  try {
    if (resolveFormulaImage) {
      const imageKey = await resolveFormulaImage(formula);
      if (imageKey) {
        return {
          type: 'formula_image',
          source: normalized,
          imageKey,
        };
      }
    } else {
      await renderLatexToSvg(normalized, { display: true });
    }
  } catch (error) {
    reportFormulaError(onFormulaError, error, formula);
  }
  return {
    type: 'formula_fallback',
    source: normalized,
    text: `公式（未渲染）：\n${normalized}`,
  };
}

export async function buildFeishuMathDocument(value, {
  resolveFormulaImage = null,
  onFormulaError = null,
} = {}) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let fenced = false;
  let fenceMarker = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      if (!fenced) {
        fenced = true;
        fenceMarker = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceMarker) {
        fenced = false;
        fenceMarker = '';
      }
      blocks.push({
        type: 'line',
        segments: [{ type: 'text', text: line }],
      });
      continue;
    }
    if (fenced) {
      blocks.push({
        type: 'line',
        segments: [{ type: 'text', text: line }],
      });
      continue;
    }
    const displayStart = parseDisplayStart(trimmed);
    if (displayStart) {
      const formula = consumeDisplayFormula(lines, index, displayStart);
      if (formula?.source) {
        blocks.push(await buildFormulaBlock(formula.source, resolveFormulaImage, onFormulaError));
        index = formula.endIndex;
        continue;
      }
    }
    blocks.push({
      type: 'line',
      segments: await resolveInlineMathSegments(line, resolveFormulaImage, onFormulaError),
    });
  }
  return { blocks };
}

function formulaCacheKey({ source, display }) {
  return createHash('sha256')
    .update(FORMULA_RENDER_VERSION)
    .update('\0')
    .update(display ? 'display' : 'inline')
    .update('\0')
    .update(normalizeLatexSource(source))
    .digest('hex');
}

function setBoundedCache(cache, key, value) {
  if (cache.size >= MAX_FORMULA_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

export function createFeishuFormulaImageResolver({
  renderFormula = renderLatexToPng,
  uploadImage,
  cache = new Map(),
} = {}) {
  if (typeof uploadImage !== 'function') {
    throw new Error('uploadImage is required');
  }
  const inFlight = new Map();
  return async (formula) => {
    const key = formulaCacheKey(formula);
    if (cache.has(key)) return cache.get(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = (async () => {
      const image = await renderFormula(formula.source, {
        display: formula.display,
      });
      const imageKey = await uploadImage(image, formula);
      if (!imageKey) throw new Error('Feishu image upload returned no image key');
      setBoundedCache(cache, key, imageKey);
      return imageKey;
    })();
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  };
}

function runtimeFormulaResolver(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('Feishu runtime is required for formula image rendering');
  }
  if (runtimeFormulaResolvers.has(runtime)) {
    return runtimeFormulaResolvers.get(runtime);
  }
  const uploadImage = async (image) => {
    const createImage = runtime?.appClient?.im?.v1?.image?.create;
    if (typeof createImage !== 'function') {
      throw new Error('Feishu image upload API is unavailable');
    }
    const response = await createImage({
      data: {
        image_type: 'message',
        image,
      },
    });
    const imageKey = String(response?.image_key || response?.data?.image_key || '').trim();
    if (!imageKey) {
      throw new Error(response?.msg || 'Feishu formula image upload returned no image key');
    }
    return imageKey;
  };
  const resolver = createFeishuFormulaImageResolver({ uploadImage });
  runtimeFormulaResolvers.set(runtime, resolver);
  return resolver;
}

export async function resolveFeishuFormulaImage(runtime, formula) {
  return runtimeFormulaResolver(runtime)(formula);
}

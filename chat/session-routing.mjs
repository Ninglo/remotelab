function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isStrongMultiWorkstreamCue(text) {
  return /(?:需要|值得|应该)?(?:重点)?(?:关注|处理|回答|讨论|看)(?:的)?(?:两点|三点|几点|几件事|几个问题|几个事情)|(?:two|three|multiple|several)\s+(?:things|topics|questions|tracks|workstreams|asks)/i.test(text);
}

function hasExplicitSingleWorkflowInstruction(text) {
  return /(?:this|same|current)\s+session|(?:sole|single|one)\s+(?:workflow|session)|do not create another child|do not spawn|stop further spawn|continue advancing independently in this same session|独立工作流|同一(?:个)?会话|本会话|不要再(?:创建|生成|启动)(?:另一个)?子会话|不要再分裂|停止进一步(?:派生|委派|分流)/i.test(text);
}

function hasStructuredWorkflowChecklist(text, workstreams) {
  const normalizedText = String(text || '').toLowerCase();
  const triageKeywordCount = [
    /\bboundary\b|边界/,
    /\breproduction\b|复现/,
    /\bblast radius\b|影响范围|波及/,
    /\bworkaround\b|临时绕过|临时方案/,
    /\bnext steps?\b|后续|下一步/,
    /\btriage\b|排查|分诊/,
  ].reduce((count, pattern) => count + (pattern.test(normalizedText) ? 1 : 0), 0);

  if (triageKeywordCount >= 3) return true;
  if (!Array.isArray(workstreams) || workstreams.length === 0) return false;

  const checklistKeywordCount = workstreams.reduce((count, item) => {
    return count + (/(?:boundary|reproduction|blast radius|workaround|next steps?|triage|边界|复现|影响范围|临时绕过|临时方案|下一步|分诊)/i.test(item) ? 1 : 0);
  }, 0);

  return checklistKeywordCount >= 3;
}

function isAgendaMarker(line) {
  return /^\s*(?:[-*+]|\d+[.)]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[、.．)])\s+/.test(line);
}

function stripAgendaMarker(line) {
  return line.replace(/^\s*(?:[-*+]|\d+[.)]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[、.．)])\s+/, '').trim();
}

function extractAgendaItems(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let current = '';

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      if (current) {
        items.push(normalizeWhitespace(current));
        current = '';
      }
      continue;
    }
    if (isAgendaMarker(line)) {
      if (current) {
        items.push(normalizeWhitespace(current));
      }
      current = stripAgendaMarker(line);
      continue;
    }
    if (current) {
      current = `${current} ${line.trim()}`;
    }
  }

  if (current) {
    items.push(normalizeWhitespace(current));
  }

  return items
    .map((item) => normalizeWhitespace(item.replace(/[：:；;，,。.!?？]+$/g, '')))
    .filter((item) => item.length >= 8);
}

export function analyzeTurnRouting(text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    return {
      shouldSplit: false,
      workstreams: [],
      reason: '',
    };
  }

  const workstreams = extractAgendaItems(normalizedText).slice(0, 4);
  if (hasExplicitSingleWorkflowInstruction(normalizedText) || hasStructuredWorkflowChecklist(normalizedText, workstreams)) {
    return {
      shouldSplit: false,
      workstreams,
      reason: '',
    };
  }

  const hasStrongCue = isStrongMultiWorkstreamCue(normalizedText);
  if (workstreams.length < 2) {
    return {
      shouldSplit: false,
      workstreams,
      reason: '',
    };
  }

  const averageLength = workstreams.reduce((sum, item) => sum + item.length, 0) / workstreams.length;
  const shouldSplit = hasStrongCue || averageLength >= 14;

  return {
    shouldSplit,
    workstreams,
    reason: shouldSplit
      ? (hasStrongCue ? 'explicit_multi_agenda' : 'numbered_multi_agenda')
      : '',
  };
}

export function buildTurnRoutingHint(text) {
  const analysis = analyzeTurnRouting(text);
  if (!analysis.shouldSplit) return '';

  return [
    'Routing principle for this turn:',
    '- Bounded work should prefer bounded context.',
    `- This user turn contains ${analysis.workstreams.length} independently actionable goals.`,
    '- Prefer splitting them into child sessions instead of mixing them in one thread.',
    '- Only keep them together if they are tightly coupled; otherwise have a clear no-split reason.',
    '',
    'Detected goals:',
    ...analysis.workstreams.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

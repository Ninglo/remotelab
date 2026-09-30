const trim = value => typeof value === 'string' ? value.trim() : '';

// Reuse explicitly supplied acceptance criteria without another model output.
// Ambiguous requests stay with the Harness, which already understands the work.
export function draftWorkboardChecklist(task) {
  const lines = trim(task).split(/\r?\n/).map(trim).filter(Boolean);
  const goal = lines.find(line => /^目标[：:]\s*\S/.test(line));
  if (!goal || goal.length > 240) return '';
  const items = lines.filter(line => /^\[ \]\s+\S+\s+—\s+\S+/.test(line));
  if (items.length < 2 || items.length > 5
      || items.some(line => line.length > 220)) return '';
  // Do not silently drop a supplied deliverable that has no completion rule.
  if (lines.some(line => /^\[[ xX]\]\s+/.test(line) && !items.includes(line))) return '';
  return [goal, ...items].join('\n');
}

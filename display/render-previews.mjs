#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { makeStatusSnapshot, validateSourcePacket } from './status-state.mjs';
import { remotelabStatusSource } from './remotelab-status-source.mjs';
import { renderTheme } from './themes/official.mjs';

const outputDir = resolve(process.argv[2] || './display-preview');
const nowMs = Date.now();
const now = new Date(nowMs).toISOString();
const soon = new Date(nowMs + 10 * 60_000).toISOString();
const metrics = { running: 2, queued: 0, pendingReview: 3, deliveryIssues: 0 };
const remote = validateSourcePacket(remotelabStatusSource(metrics, nowMs), nowMs);
const attention = validateSourcePacket({
  schemaVersion: 1, sequence: 1, label: '评测系统', observedAt: now, validUntil: soon,
  signals: [{
    id: 'evaluation:42:decision', phase: 'attention', urgency: 'high',
    title: '评测等待你决定', summary: '异常任务已暂停，下一步需要你在评测页面确认。',
    subject: 'RoboDojo 评测', destination: '去评测页面处理',
    occurredAt: now, expiresAt: soon, evidence: 'confirmed',
  }],
}, nowMs);
const scenarios = {
  progress: { remotelab: remote },
  attention: { remotelab: remote, evaluation: attention },
  stale: { remotelab: { ...remote, validUntil: new Date(nowMs - 1).toISOString() } },
};
await mkdir(outputDir, { recursive: true });
for (const [name, sources] of Object.entries(scenarios)) {
  const snapshot = makeStatusSnapshot(sources, nowMs);
  const svg = renderTheme(snapshot, { metrics: name === 'stale' ? null : metrics, nowMs });
  const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' } }).render().asPng();
  await writeFile(join(outputDir, `${name}.png`), png);
  await writeFile(join(outputDir, `${name}.svg`), svg);
}
process.stdout.write(`Rendered ${Object.keys(scenarios).join(', ')} to ${outputDir}\n`);

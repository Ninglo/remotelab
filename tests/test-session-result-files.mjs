import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  extractAssistantArtifactBlockReferences,
  collectGeneratedResultFilesFromRun,
  extractAssistantResultFileReferences,
  looksLikeResultFilePath,
  stripAssistantArtifactDeliveryHints,
} from '../chat/session-result-files.mjs';

assert.equal(looksLikeResultFilePath('/subscribe/calendar'), false, 'product-local helper paths should not be treated as result files');
assert.equal(looksLikeResultFilePath('/subscribe/calendar?format=https'), false, 'product-local helper paths with query strings should not be treated as result files');
assert.equal(looksLikeResultFilePath('/root/report.xlsx'), true, 'real local file paths should still be detected');

assert.equal(
  stripAssistantArtifactDeliveryHints('点这里：[点击订阅日历](/subscribe/calendar)。'),
  '点这里：[点击订阅日历](/subscribe/calendar)。',
  'product-local markdown links should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('手动入口：[使用 HTTPS 订阅](/subscribe/calendar?format=https)。'),
  '手动入口：[使用 HTTPS 订阅](/subscribe/calendar?format=https)。',
  'product-local markdown links with query strings should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('下载：[report.xlsx](/root/report.xlsx)。'),
  '下载：report.xlsx。',
  'real local result-file links should still be collapsed to a safe display name',
);

assert.deepEqual(
  extractAssistantResultFileReferences('[官网](/pricing)'),
  [],
  'root-relative web routes should not be treated as assistant result-file links',
);

assert.deepEqual(
  extractAssistantResultFileReferences('[相对网页](docs/getting-started)'),
  [],
  'relative web links without a file-like basename should not be treated as result files',
);

assert.deepEqual(
  extractAssistantResultFileReferences('[站内页](./guide/intro)'),
  [],
  'explicit relative links without a file-like basename should not be treated as result files',
);

assert.deepEqual(
  extractAssistantResultFileReferences('[仓库文档](./AGENTS.md)'),
  [],
  'repo-relative markdown links should not be treated as inline result files',
);

assert.equal(
  extractAssistantArtifactBlockReferences('Artifacts:\n- ./report.pdf').length,
  1,
  'artifact blocks should still allow explicit relative local files',
);

assert.equal(
  extractAssistantResultFileReferences('`C:\\\\temp\\\\report.xlsx`').length,
  1,
  'windows absolute paths should still be treated as local result-file references',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('官网入口：[官网](/pricing)。'),
  '官网入口：[官网](/pricing)。',
  'root-relative web routes should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('文档：[相对网页](docs/getting-started)。'),
  '文档：[相对网页](docs/getting-started)。',
  'relative web links without a file-like basename should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('页面：[站内页](./guide/intro)。'),
  '页面：[站内页](./guide/intro)。',
  'explicit relative links without a file-like basename should survive assistant display cleanup',
);

assert.equal(
  stripAssistantArtifactDeliveryHints('仓库文档：[AGENTS](./AGENTS.md)。'),
  '仓库文档：[AGENTS](./AGENTS.md)。',
  'repo-relative markdown links should survive assistant display cleanup',
);

const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-session-result-files-'));
try {
  mkdirSync(join(tempRoot, 'docs'), { recursive: true });
  mkdirSync(join(tempRoot, 'guide'), { recursive: true });
  writeFileSync(join(tempRoot, 'docs', 'getting-started'), 'web-like relative target', 'utf8');
  writeFileSync(join(tempRoot, 'guide', 'intro'), 'web-like explicit relative target', 'utf8');
  const oldDocPath = join(tempRoot, 'AGENTS.md');
  writeFileSync(oldDocPath, 'pre-existing repo doc', 'utf8');
  utimesSync(oldDocPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  writeFileSync(join(tempRoot, 'report.pdf'), 'real result file', 'utf8');
  const runCreatedAt = new Date().toISOString();

  const generated = await collectGeneratedResultFilesFromRun(
    { id: 'run-test-session-result-files', createdAt: runCreatedAt },
    { folder: tempRoot },
    [
      { type: 'message', role: 'assistant', content: '网页：[相对网页](docs/getting-started) 和 [站内页](./guide/intro)' },
      { type: 'message', role: 'assistant', content: `仓库文档：[AGENTS](${oldDocPath})` },
      { type: 'message', role: 'assistant', content: 'Artifacts:\n- ./report.pdf' },
    ],
  );

  assert.deepEqual(
    generated.map((file) => file.originalName),
    ['report.pdf'],
    'assistant file collection should keep explicit result files while skipping web-like links and old docs',
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('test-session-result-files: ok');

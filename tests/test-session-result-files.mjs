import assert from 'assert/strict';

import {
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

console.log('test-session-result-files: ok');

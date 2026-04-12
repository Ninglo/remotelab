#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const templateSource = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static', 'chat', 'i18n.js'), 'utf8');

const uploadButtonIndex = templateSource.indexOf('id="imgBtn"');
const textareaIndex = templateSource.indexOf('id="msgInput"');
const configRowIndex = templateSource.indexOf('class="input-config-row"');
const wrapperIndex = templateSource.indexOf('class="input-wrapper"');
const actionsRowIndex = templateSource.indexOf('class="input-actions-row"');

assert.notEqual(uploadButtonIndex, -1, 'chat template should include the upload button');
assert.notEqual(textareaIndex, -1, 'chat template should include the message composer textarea');
assert.notEqual(configRowIndex, -1, 'chat template should include the inline tooling row');
assert.notEqual(wrapperIndex, -1, 'chat template should include the composer shell');
assert.notEqual(actionsRowIndex, -1, 'chat template should include a dedicated composer action row');
assert.ok(configRowIndex < wrapperIndex, 'tooling controls should sit above the composer shell instead of inside the textarea frame');
assert.ok(textareaIndex < actionsRowIndex, 'composer actions should render below the textarea in a stacked layout');
assert.ok(textareaIndex < uploadButtonIndex, 'upload button should no longer reduce textarea width by rendering before the input text');

assert.match(templateSource, /class="composer-action-btn composer-action-btn--upload" id="imgBtn"/, 'upload button should keep the dedicated composer action styling');
assert.match(templateSource, /<span class="img-btn-label sr-only" data-i18n="action\.upload">Upload<\/span>/, 'upload button should keep an accessible label even in the icon-only layout');
assert.match(templateSource, /title="Attach files" aria-label="Attach files" data-i18n-title="action\.attachFiles" data-i18n-aria-label="action\.attachFiles"/, 'upload button should keep descriptive accessibility text');
assert.match(templateSource, /<span class="img-btn-icon" data-icon="plus" aria-hidden="true"><\/span>/, 'upload button should render as a plus icon in the composer action row');

assert.match(i18nSource, /"action\.upload": "Upload"/, 'english UI copy should label the control as Upload');
assert.match(i18nSource, /"action\.attachFiles": "Attach files"/, 'english accessibility copy should describe file uploads clearly');
assert.match(i18nSource, /"action\.upload": "上传"/, 'chinese UI copy should label the control as 上传');
assert.match(i18nSource, /"action\.attachFiles": "上传文件"/, 'chinese accessibility copy should describe file uploads clearly');

console.log('test-chat-upload-button: ok');

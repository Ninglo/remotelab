#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settings = await readFile(new URL('../static/chat/display-settings.js', import.meta.url), 'utf8');
const template = await readFile(new URL('../templates/chat.html', import.meta.url), 'utf8');
const i18n = await readFile(new URL('../static/chat/i18n.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8');

assert.match(settings, /id = "settingsDisplaySection"/);
assert.match(settings, /fetchJsonOrRedirect\("\/api\/display\/devices"/);
assert.match(settings, /fetchJsonOrRedirect\("\/api\/display\/enrollments"/);
assert.match(settings, /textContent = device\.name/);
assert.doesNotMatch(settings, /innerHTML\s*=\s*device\./, 'device metadata must not be injected as HTML');
assert.match(i18n, /"settings\.display\.title": "Side display"/);
assert.match(i18n, /"settings\.display\.title": "副屏"/);
assert.match(css, /\.settings-display-command/);
assert.match(template, /chat\/display-settings\.js/);

console.log('ok - Settings includes a localized, person-scoped side display panel');

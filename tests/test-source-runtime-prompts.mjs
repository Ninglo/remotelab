#!/usr/bin/env node
import assert from 'assert/strict';
import { buildSourceRuntimePrompt } from '../chat/source-runtime-prompts.mjs';

const shortcutPrompt = buildSourceRuntimePrompt({ sourceId: 'shortcut' });
assert.match(shortcutPrompt, /Siri\/Shortcuts connector/, 'shortcut source id should map to the Siri/Shortcuts runtime prompt');
assert.match(shortcutPrompt, /speech-friendly answer/, 'shortcut runtime prompt should bias toward concise spoken replies');

const voicePrompt = buildSourceRuntimePrompt({ sourceId: 'voice' });
assert.doesNotMatch(voicePrompt, /Siri\/Shortcuts connector/, 'voice source id should keep the existing voice prompt');

const feishuPrompt = buildSourceRuntimePrompt({ sourceId: 'feishu', sourceName: 'Feishu' });
assert.match(feishuPrompt, /markdown will be rendered as Feishu\/Lark rich text/i, 'feishu runtime prompt should allow markdown replies');
assert.match(feishuPrompt, /standard LaTeX/i, 'feishu runtime prompt should request standard formula delimiters');

const wechatPrompt = buildSourceRuntimePrompt({ sourceId: 'wechat', sourceName: 'WeChat' });
assert.match(wechatPrompt, /WeChat/, 'wechat source id should map to the WeChat runtime prompt');
assert.match(wechatPrompt, /plain text suitable for sending back through WeChat/i, 'wechat runtime prompt should stay reply-surface aware');

const whatsappPrompt = buildSourceRuntimePrompt({ sourceId: 'whatsapp-business', sourceName: 'WhatsApp' });
assert.match(whatsappPrompt, /WhatsApp/, 'whatsapp source id should map to the WhatsApp runtime prompt');
assert.match(whatsappPrompt, /mobile-friendly replies/i, 'whatsapp runtime prompt should bias toward concise mobile replies');

console.log('test-source-runtime-prompts: ok');

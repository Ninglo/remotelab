#!/usr/bin/env node
import assert from 'assert/strict';
import { buildSourceRuntimePrompt } from '../chat/source-runtime-prompts.mjs';

const shortcutPrompt = buildSourceRuntimePrompt({ sourceId: 'shortcut' });
assert.match(shortcutPrompt, /Siri\/Shortcuts connector/, 'shortcut source id should map to the Siri/Shortcuts runtime prompt');
assert.match(shortcutPrompt, /speech-friendly answer/, 'shortcut runtime prompt should bias toward concise spoken replies');

const voicePrompt = buildSourceRuntimePrompt({ sourceId: 'voice' });
assert.doesNotMatch(voicePrompt, /Siri\/Shortcuts connector/, 'voice source id should keep the existing voice prompt');

console.log('test-source-runtime-prompts: ok');

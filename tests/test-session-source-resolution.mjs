#!/usr/bin/env node
import assert from 'assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const {
  resolveAuthSessionAgentId,
  normalizeSessionPrincipalId,
  resolveAuthSessionPrincipalId,
  resolveRequestedSessionPrincipalFields,
  resolveSessionAgentId,
  resolveSessionPrincipalId,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-source-resolution.mjs')).href);

assert.equal(normalizeSessionPrincipalId('  prn_123  '), 'prn_123');
assert.equal(resolveAuthSessionAgentId({ agentId: ' app_agent_0 ' }), 'app_agent_0');
assert.equal(resolveAuthSessionAgentId({ scope: { agentId: ' app_agent_1 ' } }), 'app_agent_1');
assert.equal(resolveAuthSessionPrincipalId({ visitorId: 'visitor_1' }), 'visitor_1');
assert.equal(
  resolveAuthSessionPrincipalId({ principalId: 'principal_1', visitorId: 'visitor_1' }),
  'principal_1',
);

assert.equal(resolveSessionAgentId({ templateId: ' app_agent_2 ' }), 'app_agent_2');
assert.equal(resolveSessionAgentId({ agentId: ' app_agent_3 ', templateId: ' app_agent_2 ' }), 'app_agent_2');
assert.equal(resolveSessionPrincipalId({ visitorId: 'visitor_2' }), 'visitor_2');
assert.equal(
  resolveSessionPrincipalId({ createdByPrincipalId: 'principal_2', visitorId: 'visitor_2' }),
  'principal_2',
);

assert.deepEqual(
  resolveRequestedSessionPrincipalFields({
    createdByPrincipalId: ' principal_3 ',
    visitorName: ' Guest ',
  }),
  {
    createdByPrincipalId: 'principal_3',
    visitorId: 'principal_3',
  },
);

assert.deepEqual(
  resolveRequestedSessionPrincipalFields({
    visitorId: ' visitor_4 ',
  }),
  {
    createdByPrincipalId: 'visitor_4',
    visitorId: 'visitor_4',
  },
);

assert.deepEqual(
  resolveRequestedSessionPrincipalFields({
    createdByPrincipalId: 'owner_1',
  }),
  {
    createdByPrincipalId: 'owner_1',
    visitorId: '',
  },
);

console.log('test-session-source-resolution: ok');

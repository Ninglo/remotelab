#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';

import {
  buildDesiredCloudflarePlan,
  findLiteralRule,
  literalRuleAddress,
  ruleTargetsWorker,
  summarizeSendEmailBinding,
} from '../scripts/agent-mail-cloudflare-routing.mjs';

const exampleWorkerConfig = JSON.parse(readFileSync(new URL('../cloudflare/email-worker/wrangler.example.jsonc', import.meta.url), 'utf8'));

const exampleBinding = summarizeSendEmailBinding(exampleWorkerConfig);
assert.equal(exampleBinding.configured, true);
assert.equal(exampleBinding.bindingName, 'EMAIL');
assert.equal(exampleBinding.recipientMode, 'unrestricted');
assert.deepEqual(exampleBinding.recipientRestrictions, []);
assert.equal(exampleBinding.recipientRestricted, false);
assert.equal(exampleBinding.senderRestricted, false);
assert.deepEqual(Object.keys(exampleWorkerConfig.vars).sort(), ['MAILBOX_BRIDGE_URL', 'MAILBOX_FROM']);
assert.equal('destination_address' in exampleWorkerConfig.send_email[0], false);
assert.equal('allowed_destination_addresses' in exampleWorkerConfig.send_email[0], false);

const singleAddressBinding = summarizeSendEmailBinding({
  send_email: [{ name: 'EMAIL', destination_address: 'Owner@Example.com' }],
});
assert.equal(singleAddressBinding.recipientMode, 'single_address');
assert.deepEqual(singleAddressBinding.recipientRestrictions, ['owner@example.com']);
assert.equal(singleAddressBinding.recipientRestricted, true);

const allowlistBinding = summarizeSendEmailBinding({
  send_email: [{
    name: 'EMAIL',
    allowed_destination_addresses: ['B@example.com', 'a@example.com', 'b@example.com'],
    allowed_sender_addresses: ['rowan@example.com'],
  }],
});
assert.equal(allowlistBinding.recipientMode, 'allowlist');
assert.deepEqual(allowlistBinding.recipientRestrictions, ['a@example.com', 'b@example.com']);
assert.equal(allowlistBinding.senderMode, 'allowlist');
assert.deepEqual(allowlistBinding.senderRestrictions, ['rowan@example.com']);

const localPartPlan = buildDesiredCloudflarePlan({
  zone: 'jiujianian.dev',
  workerName: 'remotelab-email-worker',
  ownerAddress: 'rowan@jiujianian.dev',
  localPart: 'rowan',
  desiredAddresses: ['rowan@jiujianian.dev', 'trial6@jiujianian.dev', 'trial5@jiujianian.dev'],
  instanceAddressMode: 'local_part',
});

assert.equal(localPartPlan.desiredRouteModel, 'literal_worker_rules_per_address');
assert.equal(localPartPlan.requireSubaddressing, false);
assert.deepEqual(localPartPlan.requiredLiteralWorkerAddresses, [
  'rowan@jiujianian.dev',
  'trial5@jiujianian.dev',
  'trial6@jiujianian.dev',
]);

const plusPlan = buildDesiredCloudflarePlan({
  zone: 'jiujianian.dev',
  workerName: 'remotelab-email-worker',
  ownerAddress: 'rowan@jiujianian.dev',
  localPart: 'rowan',
  desiredAddresses: ['rowan@jiujianian.dev', 'rowan+trial6@jiujianian.dev'],
  instanceAddressMode: 'plus',
});

assert.equal(plusPlan.desiredRouteModel, 'owner_literal_rule_plus_subaddressing');
assert.equal(plusPlan.requireSubaddressing, true);
assert.deepEqual(plusPlan.requiredLiteralWorkerAddresses, ['rowan@jiujianian.dev']);
assert.equal(plusPlan.exampleOwnerPlusAddress, 'rowan+trial6@jiujianian.dev');

const rules = [
  {
    id: 'rule_rowan',
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: 'rowan@jiujianian.dev' }],
    actions: [{ type: 'worker', value: ['remotelab-email-worker'] }],
  },
  {
    id: 'rule_drop',
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'drop' }],
  },
];

assert.equal(literalRuleAddress(rules[0]), 'rowan@jiujianian.dev');
assert.equal(literalRuleAddress(rules[1]), '');
assert.equal(findLiteralRule(rules, 'rowan@jiujianian.dev')?.id, 'rule_rowan');
assert.equal(findLiteralRule(rules, 'trial6@jiujianian.dev'), null);
assert.equal(ruleTargetsWorker(rules[0], 'remotelab-email-worker'), true);
assert.equal(ruleTargetsWorker(rules[1], 'remotelab-email-worker'), false);

console.log('agent mail cloudflare routing tests passed');

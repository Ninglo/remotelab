#!/usr/bin/env node

import { createPoolBResetRequest, formatPoolBResetApprovalMessage, loadPoolBResetRequest } from '../lib/pool-b-reset-approval.mjs';

function value(argv, flag, required = true) {
  const index = argv.indexOf(flag);
  if (index < 0) {
    if (required) throw new Error(`Missing ${flag}`);
    return '';
  }
  const result = argv[index + 1] || '';
  if (!result && required) throw new Error(`Missing value for ${flag}`);
  return result;
}

function usage() {
  console.error(`Usage:\n  node scripts/pool-b-reset-approval.mjs request --account <slot> --chat-id <oc_xxx> --requester-open-id <ou_xxx> [options]\n  node scripts/pool-b-reset-approval.mjs show --request-id <rb-reset-...> [--state-dir <path>]`);
  process.exit(1);
}

const [command, ...argv] = process.argv.slice(2);
try {
  if (command === 'request') {
    const requester = {
      openId: value(argv, '--requester-open-id'),
      userId: value(argv, '--requester-user-id', false),
      unionId: value(argv, '--requester-union-id', false),
      name: value(argv, '--requester-name', false),
    };
    const cardsValue = value(argv, '--cards-available', false);
    const request = await createPoolBResetRequest({
      stateDir: value(argv, '--state-dir', false),
      account: value(argv, '--account'),
      accountLabel: value(argv, '--account-label', false),
      creditId: value(argv, '--credit-id', false),
      chatId: value(argv, '--chat-id'),
      threadId: value(argv, '--thread-id', false),
      requester,
      reason: value(argv, '--reason', false),
      cardsAvailable: /^\d+$/.test(cardsValue) ? Number(cardsValue) : null,
    });
    console.log(JSON.stringify({ request, message: formatPoolBResetApprovalMessage(request) }, null, 2));
    process.exit(0);
  }
  if (command === 'show') {
    const request = await loadPoolBResetRequest(value(argv, '--state-dir', false), value(argv, '--request-id'));
    console.log(JSON.stringify(request, null, 2));
    process.exit(0);
  }
  usage();
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

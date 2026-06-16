#!/usr/bin/env node

import { resolve } from 'path';

import {
  formatMailboxIngressSelfCheckText,
  runMailboxIngressSelfCheck,
} from '../../../lib/mailbox-ingress-self-check.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseArgs(argv) {
  const options = {
    configDir: '',
    cloudflaredConfig: '',
    publicHealthUrl: '',
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--config-dir':
        options.configDir = argv[++index] || '';
        break;
      case '--cloudflared-config':
        options.cloudflaredConfig = argv[++index] || '';
        break;
      case '--public-health-url':
        options.publicHealthUrl = argv[++index] || '';
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    'Usage: node automation/instance-factory/scripts/check-mailbox-ingress.mjs [options]',
    '',
    'Options:',
    '  --config-dir <path>           Override ~/.config/remotelab root',
    '  --cloudflared-config <path>   Override ~/.cloudflared/agent-mailbox-config.yml',
    '  --public-health-url <url>     Override the derived public /healthz URL',
    '  --json                        Print machine-readable JSON',
    '  --help                        Show this help',
    '',
  ].join('\n'));
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const result = await runMailboxIngressSelfCheck({
  configDir: trimString(options.configDir) ? resolve(options.configDir) : undefined,
  cloudflaredConfigPath: trimString(options.cloudflaredConfig) ? resolve(options.cloudflaredConfig) : undefined,
  publicHealthUrl: trimString(options.publicHealthUrl),
});

process.stdout.write(options.json
  ? `${JSON.stringify(result, null, 2)}\n`
  : formatMailboxIngressSelfCheckText(result));
process.exit(result.overallStatus === 'blocked' ? 1 : 0);

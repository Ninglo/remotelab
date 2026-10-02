#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CodexAccounts } from '../lib/codex-accounts.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'default-home': { type: 'string' }, command: { type: 'string' } } });
if (!values.root || !values['default-home'] || !values.command) throw new Error('root, default-home and command are required');
const accounts = new CodexAccounts({ root: values.root, defaultHome: values['default-home'] });
// Active native runs publish quota samples through their own App Server. Idle
// accounts are queried under the same lease, so the monitor never rotates an
// authorization in a competing process.
const view = await accounts.list({ refresh: true, command: values.command });
process.stdout.write(JSON.stringify(view) + '\n');

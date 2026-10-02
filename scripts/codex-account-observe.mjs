#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CodexAccounts } from '../lib/codex-accounts.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'default-home': { type: 'string' }, command: { type: 'string' } } });
if (!values.root || !values['default-home'] || !values.command) throw new Error('root, default-home and command are required');
const accounts = new CodexAccounts({ root: values.root, defaultHome: values['default-home'] });
// Active native runs publish samples through their own App Server. The observer
// refreshes idle accounts and updates the default below the 10% reserve. Model
// requests never wait for this observer or perform their own quota preflight.
const view = await accounts.list({ refresh: 'stale', command: values.command });
process.stdout.write(JSON.stringify(view) + '\n');

#!/usr/bin/env node
import { inspectRemoteLabHost } from '../../../lib/instance-factory-command.mjs';

const report = await inspectRemoteLabHost();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

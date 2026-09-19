#!/usr/bin/env node

import { basename } from 'path';

import { backfillBootstrapSessions } from '../chat/bootstrap-sessions.mjs';

const result = await backfillBootstrapSessions();
const instanceRoot = process.env.REMOTELAB_INSTANCE_ROOT || '';

console.log(JSON.stringify({
  instance: instanceRoot ? basename(instanceRoot) : '',
  created: result.created,
  updated: result.updated,
  welcomeSessionId: result.welcomeSession?.id || '',
}, null, 2));

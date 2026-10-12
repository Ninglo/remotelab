// Isolated component host for lifecycle/provider tests; never a shipped service.
import { readFile } from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createRemoteLabHttpClient } from '../../lib/remotelab-http-client.mjs';
import { createFeishuWorkboardSync } from '../../connectors/feishu/workboard-sync.mjs';
const statePath = process.argv[2];
const pilot = JSON.parse(await readFile(statePath, 'utf8'));
const config = JSON.parse(await readFile(pilot.botConfigPath, 'utf8'));
const component = await createFeishuWorkboardSync({ statePath, pilot,
  app: new Lark.Client(config), remote: createRemoteLabHttpClient({ baseUrl: config.chatBaseUrl }) });
process.once('SIGTERM', async () => { await component.stop(); });

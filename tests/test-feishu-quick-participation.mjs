import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-quick-participation-'));
setIsolatedTestHome(home);
try {
  const { classifyFeishuQuickParticipation, createFeishuQuickParticipationPilot } =
    await import('../connectors/feishu/quick-participation.mjs');
  const config = {
    storageDir: home, appId: 'self-app',
    groups: { pilot: { participationMode: 'ambient', quickReactions: true } },
    responsePolicy: { group: 'mention_only' },
  };
  const runtime = { config, botIdentity: { openId: 'bot' } };
  const base = {
    chatId: 'pilot', chatType: 'group', messageType: 'text', createTime: String(Date.now()),
    sender: { senderType: 'user', openId: 'human' }, mentions: [],
  };
  const reactions = [];
  const inputs = [];
  const pilot = createFeishuQuickParticipationPilot(runtime, {
    classify: async context => {
      inputs.push(context);
      return { decision: inputs.length === 1 ? 'silent' : 'reply', confidence: 0.9, latencyMs: 50 };
    },
    react: async (summary, emojiType) => reactions.push([summary.messageId, emojiType]),
  });
  await pilot.handle({ ...base, messageId: 'first', messageText: '链接打不开。' });
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  assert.deepEqual(reactions, [
    ['first', 'StatusReading'], ['first', 'EatingFood'],
    ['second', 'StatusReading'], ['second', 'OnIt'],
  ]);
  assert.match(inputs[1], /链接打不开/);
  assert.match(inputs[1], /下午要用/);
  await pilot.handle({ ...base, messageId: 'second', messageText: '是机器人发的测试报告，下午要用。' });
  await pilot.handle({ ...base, chatId: 'other', messageId: 'other' });
  await pilot.handle({ ...base, threadId: 'thread', messageId: 'thread', messageText: '话题里的问题' });
  await pilot.handle({ ...base, sender: { senderType: 'bot', openId: 'other-bot' }, messageId: 'bot' });
  assert.equal(reactions.length, 6);
  assert.doesNotMatch(inputs[2], /链接打不开/);
  const records = (await readFile(join(home, 'quick-participation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(item => item.decision), ['silent', 'reply', 'reply']);

  const eventsPath = join(home, 'events.jsonl');
  await writeFile(eventsPath, `${JSON.stringify({ allowed: true, summary: { ...base, messageId: 'restored', messageText: '早上说过报告打不开。' } })}\n`);
  let restoredInput = '';
  const restored = createFeishuQuickParticipationPilot(runtime, {
    classify: async context => { restoredInput = context; return { decision: 'unknown', reason: 'low_margin' }; },
    react: async (_summary, emojiType) => reactions.push(['restored-test', emojiType]),
  });
  await restored.restore(eventsPath);
  await restored.handle({ ...base, messageId: 'now', messageText: '下午评审。' });
  assert.match(restoredInput, /早上说过报告打不开/);
  assert.deepEqual(reactions.at(-1), ['restored-test', 'StatusReading']);

  restored.seedConversation({ ...base, threadId: 'ongoing' }, [
    { messageId: 'bot-reply', timestamp: Date.now(), senderType: 'app', senderId: 'self-app',
      sender: '茵蒂克丝', text: '我可以继续处理报告链接。' },
  ]);
  await restored.handle({ ...base, threadId: 'ongoing', messageId: 'follow-up', messageText: '那就继续处理。' });
  assert.match(restoredInput, /assistant: 我可以继续处理报告链接/);

  const uncertain = await classifyFeishuQuickParticipation('A: @bot', {
    key: 'test-key',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      model: 'jev-test', answers: { participation: {
        choice: 'reply', confidence: 0.01, probabilities: { reply: 0.5, silent: 0.5 },
      } },
    }) }),
  });
  assert.equal(uncertain.decision, 'unknown');
  assert.equal(uncertain.reason, 'low_margin');
  console.log('test-feishu-quick-participation: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}

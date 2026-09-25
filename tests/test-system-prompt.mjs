import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-system-prompt-'));
process.env.HOME = tempHome;
process.env.REMOTELAB_INSTANCE_ROOT = path.join(tempHome, 'instance-data');
process.env.REMOTELAB_MEMORY_DIR = path.join(tempHome, 'instance-data', 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = path.join(tempHome, 'instance-data', 'workspace');
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://trial23.example.com';
process.env.REMOTELAB_PLATFORM_SKILLS_DIR = path.join(tempHome, '.remotelab', 'platform', 'skills');

const { buildSystemContext } = await import(`../chat/system-prompt.mjs?t=${Date.now()}`);

const context = await buildSystemContext({ sessionId: 'session-test-123' });

assert.match(context, /RemoteLab is the transport and runtime substrate for this session/);
assert.match(context, /does not replace the Harness's native task interpretation, planning, safety model, tool use, or response style/);
assert.match(context, /RemoteLab Surfaces/);
assert.match(context, /default working directory for newly created files is ~\/instance-data\/workspace/);
assert.match(context, /An explicit user-provided project or path takes precedence/);
assert.match(context, /Artifacts:/);
assert.match(context, /turns those paths into chat attachments/);
assert.match(context, /<private>.*<\/private>/);

assert.match(context, /Context Pointers/);
assert.match(context, /Bootstrap: ~\/instance-data\/memory\/bootstrap\.md/);
assert.match(context, /Project index: ~\/instance-data\/memory\/projects\.md/);
assert.match(context, /Skill index: ~\/instance-data\/memory\/skills\.md/);
assert.match(context, /Task notes: ~\/instance-data\/memory\/tasks\//);
assert.match(context, /Shared system memory: \[platform-shared-memory\]\/system\.md/);
assert.match(context, /These are pointers, not an instruction to load every file/);

assert.match(context, /RemoteLab Core Workflows/);
assert.match(context, /session-spawn --guide/);
assert.doesNotMatch(context, /--internal --output-mode final-only/);
assert.match(context, /a Feishu discussion thread is a different surface/);
assert.match(context, /Timed or recurring AI work uses a Trigger or Schedule/);
assert.match(context, /RemoteLab Capability Directory/);
assert.match(context, /remotelab preview --help/);
assert.doesNotMatch(context, /Quick Tunnel/);
for (const guide of ['stable-static-publish', 'guest-port-expose', 'feishu-cli', 'session-debug']) {
  assert.match(context, new RegExp(`\\$REMOTELAB_PROJECT_ROOT/docs/platform-skills/${guide}\\.md`));
  await fs.access(new URL(`../docs/platform-skills/${guide}.md`, import.meta.url));
}
for (const command of ['trigger create --help', 'schedule create --help', 'agenda --help', 'gmail status --json', 'mail --help', 'connector list --json', 'local-bridge status --json']) {
  assert.ok(context.includes(`remotelab ${command}`), `${command} should be discoverable`);
}
assert.doesNotMatch(context, /--conversation-file|--gate-file|Events in feed:/);

assert.match(context, /Instance Local Access/);
assert.match(context, /running inside the instance-scoped environment `instance-data`/);
assert.match(context, /instance workspace is ~\/instance-data\/workspace/);
assert.match(context, /not applying a filesystem confinement boundary/);

assert.doesNotMatch(context, /Subscription helper path: \/subscribe\/calendar/);
assert.doesNotMatch(context, /If Gmail status is `ready`/);

// RemoteLab projects runtime facts and capabilities. It must not grow a
// second Harness policy stack through startup prose.
assert.doesNotMatch(context, /User Access Boundary/);
assert.doesNotMatch(context, /Guest Privacy Boundary/);
assert.doesNotMatch(context, /Manager Policy Boundary/);
assert.doesNotMatch(context, /Shared Startup Defaults/);
assert.doesNotMatch(context, /Agent Self-Management/);
assert.doesNotMatch(context, /Execution Bias/);
assert.doesNotMatch(context, /standing authorization/);
assert.doesNotMatch(context, /Do not read, write, summarize, or deliver host-level auth files/);
assert.doesNotMatch(context, /credentials found on disk that are not declared here/);
assert.doesNotMatch(context, /default to natural connected prose/i);
assert.doesNotMatch(context, /brief self-review/i);

console.log('test-system-prompt: ok');

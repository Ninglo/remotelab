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

assert.match(context, /RemoteLab Session and Scheduling Capabilities/);
assert.match(context, /remotelab session-spawn --task "<task>" --json/);
assert.match(context, /add `--wait`/);
assert.match(context, /--internal --output-mode final-only/);
assert.match(context, /remotelab trigger create --in 2h --text "<task>" --json/);
assert.match(context, /remotelab schedule create --cron/);
assert.match(context, /REMOTELAB_SESSION_ID/);
assert.match(context, /session-test-123/);

assert.match(context, /Instance Local Access/);
assert.match(context, /running inside the instance-scoped environment `instance-data`/);
assert.match(context, /instance workspace is ~\/instance-data\/workspace/);
assert.match(context, /not applying a filesystem confinement boundary/);

assert.match(context, /remotelab agenda add --title "Title" --start "ISO8601" --duration 60/);
assert.match(context, /Subscription helper path: \/subscribe\/calendar/);
assert.match(context, /\[点击订阅日历\]\(\/subscribe\/calendar\)/);
assert.match(context, /complete RemoteLab connector-action catalog for this instance/);

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

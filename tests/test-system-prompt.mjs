import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-system-prompt-'));
process.env.HOME = tempHome;
process.env.REMOTELAB_MEMORY_DIR = path.join(tempHome, 'instance-data', 'memory');

const { buildSystemContext } = await import('../chat/system-prompt.mjs');

const context = await buildSystemContext({ sessionId: 'session-test-123' });

assert.match(context, /Seed Layer — Editable Default Constitution/);
assert.match(context, /editable seed layer, not permanent law/);
assert.match(context, /Template-Session-First Routing/);
assert.match(context, /Manager Policy Boundary/);
assert.match(context, /Treat provider runtimes such as Codex or Claude as execution engines/);
assert.match(context, /synchronize principles, boundaries, and default assembly rules/);
assert.match(context, /For normal conversation and conceptual discussion, default to natural connected prose/);
assert.match(context, /state-first reorientation: current execution state, whether the user is needed now, or whether the work can stay parked for later/);
assert.match(context, /do not mirror its headings, bullets, or checklist structure back to the user/);
assert.match(context, /Context Topology/);
assert.match(context, /Session Continuity/);
assert.match(context, /Bounded work should prefer bounded context/);
assert.match(context, /reusable template\/base session likely exists/);
assert.match(context, /clean, comprehensive project-task context/);
assert.match(context, /improve it or derive a better template\/base/);
assert.match(context, /saved template context as bootstrap, not eternal truth/);
assert.match(context, /fresh working child\/fork/);
assert.match(context, /approximate the behavior by loading the best matching template context/);
assert.match(context, /Parallel Session Spawning/);
assert.match(context, /core dispatch principle/);
assert.match(context, /not primarily a user-facing UI action/);
assert.match(context, /independent worker that simply received bounded handoff context/);
assert.match(context, /2\+ independently actionable goals/);
assert.match(context, /clear no-split reason/);
assert.match(context, /parent session may coordinate while each child session owns one goal/);
assert.match(context, /remotelab session-spawn --task/);
assert.match(context, /remotelab trigger create --in 2h --text/);
assert.match(context, /--wait --json/);
assert.match(context, /Keep spawned-session handoff minimal/);
assert.match(context, /focused task plus the parent session id is enough/);
assert.match(context, /Do not impose a heavy handoff template by default/);
assert.match(context, /let the child fetch it from the parent session/);
assert.match(context, /REMOTELAB_SESSION_ID/);
assert.match(context, /trigger command defaults to REMOTELAB_SESSION_ID/);
assert.match(context, /session-test-123/);
assert.match(context, /Execution Bias/);
assert.match(context, /Treat a clear user request as standing permission to carry the task forward until it reaches a meaningful stopping point/);
assert.match(context, /Default to continuing after partial progress instead of stopping to ask whether you should proceed/);
assert.match(context, /Prefer doing the next reasonable, reversible step over describing what you could do next/);
assert.match(context, /Pause only for a real blocker: an explicitly requested stop\/wait, missing credentials or external information you cannot obtain yourself, a destructive or irreversible action without clear authorization, or a decision that only the user can make/);
assert.match(context, /Do not treat the absence of micro-instructions as a blocker; execution-layer decisions are part of your job/);
assert.match(context, /~\/instance-data\/memory\//);
assert.doesNotMatch(context, /~\/\.remotelab\/memory\//);

console.log('test-system-prompt: ok');

import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-instance-visible-paths-'));
const instanceRoot = path.join(tempHome, 'instances', 'trial24');
const workRoot = path.join(instanceRoot, 'workspace');
const tmpRoot = path.join(instanceRoot, 'tmp');

process.env.HOME = tempHome;
process.env.REMOTELAB_INSTANCE_ROOT = instanceRoot;
process.env.REMOTELAB_WORK_ROOT_DIR = workRoot;
process.env.TMPDIR = tmpRoot;

const moduleUrl = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'chat', 'instance-visible-paths.mjs')).href;

delete process.env.REMOTELAB_ENFORCE_INSTANCE_LOCAL_BOUNDARY;
const relaxed = await import(`${moduleUrl}?t=${Date.now()}`);

assert.equal(relaxed.getScopedInstanceName(), 'trial24');
assert.equal(relaxed.isScopedInstanceUserSurface(), true);
assert.equal(relaxed.getDefaultUserVisibleRoot(), workRoot);
assert.deepEqual(relaxed.getUserVisibleRoots(), [workRoot, tmpRoot]);
assert.equal(relaxed.resolveUserVisiblePathInput('~'), workRoot);
assert.equal(relaxed.resolveUserVisiblePathInput('~/exports/report.pdf'), path.join(workRoot, 'exports', 'report.pdf'));
assert.equal(relaxed.resolveUserVisiblePathInput('./notes/todo.md'), path.join(workRoot, 'notes', 'todo.md'));
assert.equal(relaxed.resolveUserVisiblePathInput('/root/.ssh/id_rsa'), '/root/.ssh/id_rsa');
assert.equal(relaxed.isUserVisiblePathAllowed(path.join(workRoot, 'notes', 'todo.md')), true);
assert.equal(relaxed.isUserVisiblePathAllowed(path.join(tmpRoot, 'scratch.txt')), true);
assert.equal(relaxed.isUserVisiblePathAllowed(path.join(instanceRoot, 'config', 'auth.json')), true);
assert.equal(relaxed.isUserVisiblePathAllowed('/root/.ssh/id_rsa'), true);

process.env.REMOTELAB_ENFORCE_INSTANCE_LOCAL_BOUNDARY = '1';
assert.equal(relaxed.isUserVisiblePathAllowed(path.join(instanceRoot, 'config', 'auth.json'), {
  enforceBoundary: true,
}), false);
assert.equal(relaxed.isUserVisiblePathAllowed('/root/.ssh/id_rsa', {
  enforceBoundary: true,
}), false);

const ownerRoot = path.join(tempHome, 'instances', 'owner');
const ownerWorkRoot = path.join(ownerRoot, 'workspace');
const ownerTmpRoot = path.join(ownerRoot, 'tmp');
assert.equal(relaxed.getScopedInstanceName({ instanceRoot: ownerRoot }), 'owner');
assert.equal(relaxed.isScopedInstanceUserSurface({ instanceRoot: ownerRoot }), true);
assert.equal(relaxed.getDefaultUserVisibleRoot({ instanceRoot: ownerRoot, workRoot: ownerWorkRoot }), ownerWorkRoot);
assert.deepEqual(
  relaxed.getUserVisibleRoots({ instanceRoot: ownerRoot, workRoot: ownerWorkRoot, tmpRoot: ownerTmpRoot }),
  [ownerWorkRoot, ownerTmpRoot],
);
assert.equal(relaxed.resolveUserVisiblePathInput('~', { instanceRoot: ownerRoot, workRoot: ownerWorkRoot }), ownerWorkRoot);
assert.equal(
  relaxed.isUserVisiblePathAllowed(path.join(ownerRoot, 'config', 'auth.json'), {
    instanceRoot: ownerRoot,
    workRoot: ownerWorkRoot,
    tmpRoot: ownerTmpRoot,
    enforceBoundary: true,
  }),
  false,
);
assert.equal(
  relaxed.isUserVisiblePathAllowed(path.join(ownerWorkRoot, 'notes', 'todo.md'), {
    instanceRoot: ownerRoot,
    workRoot: ownerWorkRoot,
    tmpRoot: ownerTmpRoot,
    enforceBoundary: true,
  }),
  true,
);

console.log('test-instance-visible-paths: ok');

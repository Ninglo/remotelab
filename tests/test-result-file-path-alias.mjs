import assert from 'assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const testRoot = await mkdtemp(join(tmpdir(), 'remotelab-result-file-path-alias-'));
const physicalRoot = join(testRoot, 'physical-instance');
const aliasRoot = join(testRoot, 'instance-alias');
const physicalWorkspace = join(physicalRoot, 'workspace');
const aliasWorkspace = join(aliasRoot, 'workspace');

try {
  await mkdir(physicalWorkspace, { recursive: true });
  await symlink(physicalRoot, aliasRoot, 'dir');
  const reportPath = join(physicalWorkspace, 'report.pdf');
  await writeFile(reportPath, 'generated report');
  const outsidePath = join(testRoot, 'private.pdf');
  await writeFile(outsidePath, 'private file');
  const escapePath = join(aliasWorkspace, 'escape.pdf');
  await symlink(outsidePath, escapePath);

  process.env.HOME = testRoot;
  process.env.REMOTELAB_INSTANCE_ROOT = aliasRoot;
  process.env.REMOTELAB_WORK_ROOT_DIR = aliasWorkspace;
  process.env.REMOTELAB_CONFIG_DIR = join(aliasRoot, 'config');
  process.env.REMOTELAB_ENFORCE_INSTANCE_LOCAL_BOUNDARY = '1';
  process.env.REMOTELAB_ASSET_STORAGE_BASE_URL = '';
  process.env.REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL = '';

  const { collectGeneratedResultFilesFromRun } = await import('../chat/session-result-files.mjs');
  const { publishLocalFileAssetFromPath } = await import('../chat/file-assets.mjs');
  const { buildReplyPublicationPayload } = await import('../chat/reply-publication.mjs');

  const collected = await collectGeneratedResultFilesFromRun({}, { folder: aliasWorkspace }, [
    { type: 'message', role: 'assistant', content: `Artifacts:\n- ${reportPath}\n- ${escapePath}` },
  ]);
  assert.equal(collected.length, 1, 'the physical workspace alias should resolve, while a symlink escape is rejected');
  assert.equal(collected[0].localPath, reportPath);

  const asset = await publishLocalFileAssetFromPath({
    sessionId: 'alias-test-session',
    localPath: collected[0].localPath,
    originalName: 'report.pdf',
  });
  assert.equal(asset.originalName, 'report.pdf');
  assert.equal(asset.sizeBytes, Buffer.byteLength('generated report'));
  const objectNames = await readdir(join(aliasRoot, 'config', 'file-assets', 'objects'));
  assert.equal(objectNames.length, 1);
  assert.equal(await readFile(join(aliasRoot, 'config', 'file-assets', 'objects', objectNames[0]), 'utf8'), 'generated report');

  const reply = buildReplyPublicationPayload([
    { type: 'message', role: 'user', seq: 1, content: 'Send the report' },
    { type: 'message', role: 'assistant', seq: 2, runId: 'alias-run', content: `下载：[PDF](${reportPath})\n\nArtifacts:\n- ${reportPath}` },
    { type: 'message', role: 'assistant', seq: 3, runId: 'alias-run', source: 'result_file_assets', content: 'Generated file ready to download.', attachments: [{ assetId: asset.id, originalName: 'report.pdf', mimeType: 'application/pdf', renderAs: 'file' }] },
  ], { id: 'alias-run' }, { includeSessionEntry: false });
  assert.equal(reply.attachments.length, 1, 'the connector payload should include the file');
  assert.doesNotMatch(reply.text, /\/physical-instance\/workspace\//, 'the connector text should not expose an unusable local link');

  for (const forbiddenPath of [outsidePath, escapePath]) {
    await assert.rejects(
      publishLocalFileAssetFromPath({ sessionId: 'alias-test-session', localPath: forbiddenPath }),
      (error) => error.code === 'FILE_ASSET_LOCAL_PATH_FORBIDDEN',
      `publishing ${forbiddenPath} must remain forbidden`,
    );
  }
} finally {
  await rm(testRoot, { recursive: true, force: true });
}

console.log('test-result-file-path-alias: ok');

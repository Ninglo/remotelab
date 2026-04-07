#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function importFresh(relativePath) {
  const href = pathToFileURL(join(repoRoot, relativePath)).href;
  return import(`${href}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-file-assets-tos-'));
const envKeys = [
  'REMOTELAB_INSTANCE_ROOT',
  'REMOTELAB_ASSET_STORAGE_BASE_URL',
  'REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL',
  'REMOTELAB_ASSET_STORAGE_REGION',
  'REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID',
  'REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY',
  'REMOTELAB_ASSET_STORAGE_PRESIGN_TTL_SECONDS',
  'REMOTELAB_ASSET_STORAGE_PROVIDER',
  'REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED',
];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

try {
  process.env.REMOTELAB_INSTANCE_ROOT = tempHome;
  process.env.REMOTELAB_ASSET_STORAGE_BASE_URL = 'https://tos-cn-beijing.volces.com/example-bucket';
  delete process.env.REMOTELAB_ASSET_STORAGE_PUBLIC_BASE_URL;
  process.env.REMOTELAB_ASSET_STORAGE_REGION = 'cn-beijing';
  process.env.REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID = 'test-access-key';
  process.env.REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY = 'test-secret-key';
  process.env.REMOTELAB_ASSET_STORAGE_PRESIGN_TTL_SECONDS = '900';
  delete process.env.REMOTELAB_ASSET_STORAGE_PROVIDER;
  process.env.REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED = '0';

  const config = await importFresh('lib/config.mjs');
  assert.equal(config.FILE_ASSET_STORAGE_PROVIDER, 'tos', 'Volcengine endpoints should auto-detect as TOS');
  assert.equal(
    config.FILE_ASSET_STORAGE_BASE_URL,
    'https://example-bucket.tos-cn-beijing.volces.com',
    'TOS path-style endpoints should normalize to virtual-host form',
  );
  assert.equal(config.FILE_ASSET_DIRECT_UPLOAD_ENABLED, false, 'direct upload toggle should be independently disableable');
  assert.deepEqual(
    config.FILE_ASSET_ALLOWED_ORIGINS,
    ['https://example-bucket.tos-cn-beijing.volces.com'],
    'allowed origins should use the normalized TOS origin',
  );

  const fileAssets = await importFresh('chat/file-assets.mjs');
  assert.deepEqual(fileAssets.getFileAssetBootstrapConfig(), {
    enabled: true,
    directUpload: false,
    provider: 'tos',
  }, 'bootstrap config should advertise TOS storage while keeping browser direct upload disabled');

  const intent = await fileAssets.createFileAssetUploadIntent({
    sessionId: 'session-test',
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 7,
  });
  const uploadUrl = new URL(intent.upload.url);
  assert.equal(uploadUrl.origin, 'https://example-bucket.tos-cn-beijing.volces.com', 'upload URL should target the normalized TOS bucket host');
  assert.equal(uploadUrl.searchParams.get('X-Tos-Algorithm'), 'TOS4-HMAC-SHA256', 'upload URL should use TOS signing parameters');
  assert.equal(uploadUrl.searchParams.get('X-Tos-SignedHeaders'), 'content-disposition;content-type;host', 'upload URL should sign content-disposition, content-type, and host headers');
  assert.equal(uploadUrl.searchParams.get('X-Amz-Algorithm'), null, 'upload URL should not use AWS query params for TOS');
  assert.match(
    uploadUrl.pathname,
    /^\/session-assets\/session-test\/\d{4}\/\d{2}\/\d{2}\/fasset_[a-f0-9]{24}-report\.pdf$/,
    'upload URL should preserve the object-key layout',
  );

  const finalized = await fileAssets.finalizeFileAssetUpload(intent.asset.id, {
    sizeBytes: 7,
    etag: 'etag-1',
  });
  assert.equal(finalized.downloadUrl, `/api/assets/${intent.asset.id}/download`, 'client metadata should keep the stable download route');
  assert.ok(finalized.directUrl, 'finalized asset should expose a direct TOS download URL');
  assert.ok(finalized.directUrlExpiresAt, 'private TOS downloads should remain presigned');

  const directUrl = new URL(finalized.directUrl);
  assert.equal(directUrl.origin, 'https://example-bucket.tos-cn-beijing.volces.com', 'download URL should target the normalized TOS bucket host');
  assert.equal(directUrl.searchParams.get('X-Tos-Algorithm'), 'TOS4-HMAC-SHA256', 'download URL should use TOS signing parameters');
  assert.equal(directUrl.searchParams.get('X-Amz-Algorithm'), null, 'download URL should not leak AWS-style signing params');
  assert.ok(
    directUrl.searchParams.has('response-content-disposition'),
    'TOS direct URLs should include response-content-disposition for consistent redirect-based downloads',
  );

  console.log('test-file-assets-tos-signing: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  for (const key of envKeys) {
    if (typeof previousEnv[key] === 'undefined') delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  rmSync(tempHome, { recursive: true, force: true });
}

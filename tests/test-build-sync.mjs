#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildInstanceVersionState,
  buildStateNeedsAttention,
  normalizeBuildSummary,
} from '../lib/build-sync.mjs';

const owner = normalizeBuildSummary({
  assetVersion: 'owner-ui-a',
  serviceAssetVersion: 'owner-svc-a',
  label: 'owner build',
});
const localMatch = normalizeBuildSummary({
  assetVersion: 'owner-ui-a',
  serviceAssetVersion: 'owner-svc-a',
  label: 'guest local match',
});
const localStale = normalizeBuildSummary({
  assetVersion: 'guest-ui-old',
  serviceAssetVersion: 'guest-svc-old',
  label: 'guest local stale',
});
const publicMismatch = normalizeBuildSummary({
  assetVersion: 'public-ui-b',
  serviceAssetVersion: 'owner-svc-a',
  label: 'guest public mismatch',
});

const current = buildInstanceVersionState({
  owner,
  local: localMatch,
  publicBuild: localMatch,
});
assert.equal(current.status, 'current');
assert.equal(current.localMatchesOwner, true);
assert.equal(current.publicMatchesLocal, true);
assert.equal(buildStateNeedsAttention(current), false);

const stale = buildInstanceVersionState({
  owner,
  local: localStale,
});
assert.equal(stale.status, 'stale_runtime');
assert.equal(stale.localMatchesOwner, false);
assert.equal(buildStateNeedsAttention(stale), true);

const publicDrift = buildInstanceVersionState({
  owner,
  local: localMatch,
  publicBuild: publicMismatch,
});
assert.equal(publicDrift.status, 'public_mismatch');
assert.equal(publicDrift.localMatchesOwner, true);
assert.equal(publicDrift.publicMatchesLocal, false);
assert.equal(buildStateNeedsAttention(publicDrift), true);

console.log('test-build-sync: ok');

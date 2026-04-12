function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeBuildSummary(source = null) {
  if (!source || typeof source !== 'object') return null;
  const assetVersion = trimString(source.assetVersion);
  const serviceAssetVersion = trimString(source.serviceAssetVersion || source.assetVersion);
  const label = trimString(source.label || source.serviceLabel || source.title || source.serviceTitle);
  const title = trimString(source.title || source.serviceTitle || source.label || source.serviceLabel);
  if (!assetVersion && !serviceAssetVersion && !label && !title) return null;
  return {
    assetVersion,
    serviceAssetVersion,
    label,
    title,
  };
}

function compareVersions(left, right) {
  const normalizedLeft = trimString(left);
  const normalizedRight = trimString(right);
  if (!normalizedLeft || !normalizedRight) return null;
  return normalizedLeft === normalizedRight;
}

export function buildInstanceVersionState({
  owner = null,
  local = null,
  publicBuild = null,
} = {}) {
  const normalizedOwner = normalizeBuildSummary(owner);
  const normalizedLocal = normalizeBuildSummary(local);
  const normalizedPublic = normalizeBuildSummary(publicBuild);

  const localMatchesOwner = compareVersions(
    normalizedLocal?.serviceAssetVersion,
    normalizedOwner?.serviceAssetVersion,
  );
  const publicMatchesLocal = compareVersions(
    normalizedPublic?.assetVersion,
    normalizedLocal?.assetVersion,
  );

  let status = 'unknown';
  let label = '待确认';
  let detail = '版本检查尚未完成。';

  if (localMatchesOwner === false) {
    status = 'stale_runtime';
    label = '落后 owner';
    detail = '本地运行版本落后于 owner 基线，建议收敛或重启。';
  } else if (publicMatchesLocal === false) {
    status = 'public_mismatch';
    label = '公网偏差';
    detail = '公网入口返回的版本和实例本地版本不一致。';
  } else if (normalizedLocal && normalizedOwner) {
    status = 'current';
    label = '与 owner 一致';
    detail = '实例本地运行版本已经和 owner 基线一致。';
  } else if (normalizedLocal) {
    status = 'current';
    label = '当前版本';
    detail = '实例本地运行版本可见。';
  }

  return {
    status,
    label,
    detail,
    ownerAssetVersion: trimString(normalizedOwner?.assetVersion),
    ownerServiceAssetVersion: trimString(normalizedOwner?.serviceAssetVersion),
    ownerLabel: trimString(normalizedOwner?.label),
    localAssetVersion: trimString(normalizedLocal?.assetVersion),
    localServiceAssetVersion: trimString(normalizedLocal?.serviceAssetVersion),
    localLabel: trimString(normalizedLocal?.label),
    publicAssetVersion: trimString(normalizedPublic?.assetVersion),
    publicServiceAssetVersion: trimString(normalizedPublic?.serviceAssetVersion),
    publicLabel: trimString(normalizedPublic?.label),
    localMatchesOwner,
    publicMatchesLocal,
  };
}

export function buildStateNeedsAttention(buildState = null) {
  const status = trimString(buildState?.status);
  return status === 'stale_runtime' || status === 'public_mismatch';
}

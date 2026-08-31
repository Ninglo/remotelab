function normalizeErrorText(value) {
  return typeof value === 'string' ? value : '';
}

export function isCodexMissingRolloutFailure(value) {
  const normalized = normalizeErrorText(value);
  return /thread\/resume failed:\s*no rollout found for thread id/i.test(normalized)
    || /\bno rollout found for thread id\b/i.test(normalized);
}

export function isCodexResumeUnavailableFailure(value) {
  const normalized = normalizeErrorText(value);
  return isCodexMissingRolloutFailure(normalized)
    || /Saved Codex resume thread is no longer available/i.test(normalized);
}

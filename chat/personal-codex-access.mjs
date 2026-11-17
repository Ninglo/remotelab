// Instance-scoped binding access: '*' admits all authenticated People; a list
// retains selective enrollment. Keep deployment choices out of source.
export function isPersonalCodexAvailable(authSession, allowlist = process.env.REMOTELAB_PERSONAL_CODEX_PERSON_IDS || '') {
  const personId = authSession?.personId;
  if (!personId || personId === 'person_system' || authSession.authKind === 'service') return false;
  const enrolled = allowlist.split(',').map(id => id.trim()).filter(Boolean);
  return enrolled.includes('*') || enrolled.includes(personId);
}

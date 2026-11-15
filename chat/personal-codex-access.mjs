// Instance-scoped preview enrollment; administrator status does not enroll a
// Person. Keep actual participant IDs in deployment configuration, not source.
export function isPersonalCodexAvailable(authSession, allowlist = process.env.REMOTELAB_PERSONAL_CODEX_PERSON_IDS || '') {
  const personId = authSession?.personId;
  return Boolean(personId && personId !== 'person_system' && authSession.authKind !== 'service'
    && allowlist.split(',').map(id => id.trim()).filter(Boolean).includes(personId));
}

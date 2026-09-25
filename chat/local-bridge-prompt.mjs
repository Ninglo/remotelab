function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildLocalBridgePromptBlock(session = {}) {
  const surface = session?.localBridge && typeof session.localBridge === 'object'
    ? session.localBridge
    : null;
  if (!surface || !trimString(surface.deviceId)) return '';

  const lines = [
    '## Local Helper Bridge',
    `A linked local helper is available for this session.`,
    `- state: ${trimString(surface.state) || 'unknown'}`,
    `- device: ${trimString(surface.deviceName) || trimString(surface.deviceId)}`,
    trimString(surface.platform) ? `- platform: ${trimString(surface.platform)}` : '',
    Array.isArray(surface.allowedRoots) && surface.allowedRoots.length > 0
      ? `- allowed roots: ${surface.allowedRoots.map((entry) => `\`${trimString(entry.alias)}\``).filter(Boolean).join(', ')}`
      : '',
    '- Use `remotelab local-bridge status --help` for file operations within these root aliases; `remotelab local-bridge status --json` refreshes the live device state.',
    '- `stage` and `pack` attach selected local content to this Session. Use reported root aliases rather than invented absolute device paths.',
  ];
  return lines.filter(Boolean).join('\n');
}

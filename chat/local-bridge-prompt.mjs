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
    '- Use the RemoteLab CLI, not raw HTTP, when you need local files for this session.',
    '- Preferred commands:',
    '  - `remotelab local-bridge status --json`',
    '  - `remotelab local-bridge list --root <alias> --path <relPath> --json`',
    '  - `remotelab local-bridge find --root <alias> --path <relPath> --query <text> --glob "*.ext" --json`',
    '  - `remotelab local-bridge stat --root <alias> --path <relPath> --json`',
    '  - `remotelab local-bridge read-text --root <alias> --path <relPath> --json`',
    '  - `remotelab local-bridge stage --root <alias> --path <relPath> --json`',
    '- `stage` uploads the selected local file into this RemoteLab session through the normal asset pipeline.',
    '- Do not invent absolute local paths. Stay within the reported root aliases.',
  ];
  return lines.filter(Boolean).join('\n');
}


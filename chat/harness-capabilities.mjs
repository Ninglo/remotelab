import capabilities from './harness-capabilities.json' with { type: 'json' };

export const HARNESS_CAPABILITIES = capabilities;
export const harnessCapability = (harness, capability) => HARNESS_CAPABILITIES.harnesses?.[harness]?.[capability] || 'missing';

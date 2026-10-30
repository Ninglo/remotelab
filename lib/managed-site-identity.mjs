import { createEmployeeSiteIdentity } from './employee-site-identity.mjs';
import { createEmployeeSiteGateway, validateEmployeeGatewaySettings } from './employee-site-gateway.mjs';
import { loadEmployeeSiteSettings } from './site-publication-policy.mjs';

// Provider selection belongs to the shared website ingress, never individual sites.
export function createManagedSiteIdentity(options) {
  const legacy = options.legacyIdentity || createEmployeeSiteIdentity(options);
  const gateway = createEmployeeSiteGateway(options);
  const configurations = new WeakMap();
  async function configuration(req) {
    if (!configurations.has(req)) configurations.set(req, loadEmployeeSiteSettings(options.configDir).catch(error => {
      if (error.code === 'ENOENT') return {};
      throw error;
    }));
    const cfg = await configurations.get(req);
    if (cfg.provider && !['feishu-device', 'muka-sso-gateway'].includes(cfg.provider)) throw new Error('Unknown employee login provider');
    return cfg;
  }
  async function gatewaySettings(req) {
    const cfg = await configuration(req);
    return cfg.provider === 'muka-sso-gateway' ? validateEmployeeGatewaySettings(cfg) : null;
  }
  return {
    gatewaySettings,
    async member(req, remote) {
      const cfg = await gatewaySettings(req);
      return cfg ? gateway.member(req, cfg) : legacy.member(req, remote);
    },
    async renew(req, person) { return await gatewaySettings(req) ? null : legacy.renew(req, person); },
    async begin(req) {
      if (await gatewaySettings(req)) throw new Error('SSO must enter through the registered gateway');
      return legacy.begin(req);
    },
    async poll(req) {
      if (await gatewaySettings(req)) throw new Error('SSO does not use device polling');
      return legacy.poll(req);
    },
    async logout(req) {
      if (await gatewaySettings(req)) throw new Error('SSO logout belongs to the issuer');
      return legacy.logout(req);
    },
  };
}

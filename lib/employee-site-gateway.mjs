import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const subject = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const permission = /^[a-z][a-z0-9_.-]*$/;

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('SSO requires an exact HTTPS origin');
}

export function validateEmployeeGatewaySettings(cfg) {
  httpsOrigin(cfg.issuer); httpsOrigin(cfg.publicOrigin);
  if (!identifier.test(cfg.appId) || !permission.test(cfg.entryPermission)
    || !isAbsolute(cfg.sourceKeyFile || '')) throw new Error('Incomplete employee SSO gateway configuration');
  return cfg;
}

// Consume the existing Muka Envoy -> application contract. The gateway owns
// OAuth, root-session checks, refresh and revocation; no second session is minted.
export function createEmployeeSiteGateway({ registerIdentity }) {
  return {
    async member(req, cfg) {
      validateEmployeeGatewaySettings(cfg);
      if (cfg.enabled === false) return null;
      const key = (await readFile(cfg.sourceKeyFile, 'utf8')).trim();
      if (key.length < 32 || key.length > 4096) throw new Error('Invalid employee SSO gateway source key');
      const supplied = req.headers['x-muka-source-key'];
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(key)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) return null;
      // Forwarded headers are meaningful only after authenticating the gateway.
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
      if (`${proto}://${host}` !== cfg.publicOrigin) return null;
      const subjectId = req.headers['x-muka-user-id'];
      const role = req.headers['x-muka-platform-role'];
      const permissions = req.headers['x-muka-permissions'];
      const encoded = req.headers['x-muka-user-profile'];
      if (typeof subjectId !== 'string' || !subject.test(subjectId)
        || !['platform_admin', 'member'].includes(role) || typeof permissions !== 'string'
        || permissions.length > 4096 || permissions.split(',').some(p => !/^[a-z][a-z0-9._:-]{0,127}$/.test(p))
        || !permissions.split(',').includes(cfg.entryPermission)
        || typeof encoded !== 'string' || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
      let profile;
      try { profile = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
      if (profile?.id !== subjectId || typeof profile.displayName !== 'string' || profile.displayName.length > 256) return null;
      const person = await registerIdentity({ kind: 'muka-sso', realm: cfg.issuer, openId: subjectId, name: profile.displayName });
      return { id: person.id, name: person.name, auth_kind: 'muka-sso' };
    },
  };
}

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sqliteState } from './sqlite-state.mjs';

const DAY = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
export const validGuestSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validGuestGrant = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function createPreviewGuestStore(configDir, now = Date.now) {
  const path = join(configDir, 'preview-guest-grants.json');
  const state = (action, scope, args = {}) => sqliteState(path, 'preview-guest', { action, scope, ...args });
  return {
    list: scope => state('list', scope, { at: now() }),
    async issue(scope, label, issuer) {
      const secret = random(), id = randomBytes(16).toString('hex'), at = now();
      const grant = await state('issue', scope, { id, label, issuer, inviteHash: hash(secret), at, expiresAt: at + DAY });
      return { ...grant, secret };
    },
    async redeem(scope, secret) {
      if (!validGuestSecret(secret)) return null;
      const session = random();
      const grant = await state('redeem', scope, { inviteHash: hash(secret), sessionHash: hash(session), at: now() });
      return grant && { session };
    },
    async member(scope, session) {
      if (!validGuestSecret(session)) return null;
      const row = await state('member', scope, { sessionHash: hash(session) });
      return row && { id: `person_guest_${row.id}` };
    },
    revoke: (scope, id, issuer) => state('revoke', scope, { id, issuer, at: now() }),
  };
}

// Run only inside the existing SQLite worker. A grant and its session live in
// one row, so spending an invite and creating access are one durable operation.
const initialized = new WeakSet();
export function previewGuestOperation(db, prepare, a) {
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS preview_guest_grants (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, label TEXT NOT NULL,
      issuer TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      invite_hash TEXT UNIQUE, session_hash TEXT UNIQUE,
      redeemed_at INTEGER, revoked_at INTEGER, revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS preview_guest_scope_created ON preview_guest_grants(scope, created_at DESC);
    CREATE INDEX IF NOT EXISTS preview_guest_pending_expiry ON preview_guest_grants(expires_at) WHERE invite_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS preview_guest_revoked_at ON preview_guest_grants(revoked_at) WHERE revoked_at IS NOT NULL;`);
    initialized.add(db);
  }
  const run = sql => prepare(db, sql);
  const view = 'id, label, created_at AS createdAt, expires_at AS expiresAt, redeemed_at AS redeemedAt, revoked_at AS revokedAt';
  switch (a.action) {
    case 'issue': {
      // Keep inactive history for 90 days. Active grants do not expire.
      const cutoff = a.at - 90 * DAY;
      run('DELETE FROM preview_guest_grants WHERE invite_hash IS NOT NULL AND expires_at < ?').run(cutoff);
      run('DELETE FROM preview_guest_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?').run(cutoff);
      return run(`INSERT INTO preview_guest_grants(id,scope,label,issuer,created_at,expires_at,invite_hash)
        VALUES(?,?,?,?,?,?,?) RETURNING ${view}`).get(a.id, a.scope, a.label, a.issuer, a.at, a.expiresAt, a.inviteHash);
    }
    case 'list': {
      // Do not hide active grants behind an audit retention cutoff.
      const current = run(`SELECT ${view} FROM preview_guest_grants WHERE scope=? AND revoked_at IS NULL
        AND (redeemed_at IS NOT NULL OR expires_at>?) ORDER BY created_at DESC`).all(a.scope, a.at);
      const inactive = run(`SELECT ${view} FROM preview_guest_grants WHERE scope=? AND
        (revoked_at IS NOT NULL OR (redeemed_at IS NULL AND expires_at<=?)) ORDER BY created_at DESC LIMIT 30`).all(a.scope, a.at);
      return { current, inactive };
    }
    case 'redeem':
      return run(`UPDATE preview_guest_grants SET invite_hash=NULL, session_hash=?, redeemed_at=?
        WHERE invite_hash=? AND scope=? AND revoked_at IS NULL AND expires_at>? RETURNING id`)
        .get(a.sessionHash, a.at, a.inviteHash, a.scope, a.at) || null;
    case 'member':
      return run('SELECT id FROM preview_guest_grants WHERE session_hash=? AND scope=? AND revoked_at IS NULL')
        .get(a.sessionHash, a.scope) || null;
    case 'revoke':
      return Boolean(run(`UPDATE preview_guest_grants SET invite_hash=NULL,session_hash=NULL,revoked_at=?,revoked_by=?
        WHERE id=? AND scope=? AND revoked_at IS NULL RETURNING id`).get(a.at, a.issuer, a.id, a.scope));
    default:
      throw new Error('Unknown preview guest operation');
  }
}

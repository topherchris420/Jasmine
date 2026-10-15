import { createHash, randomBytes } from 'node:crypto';
import type { JasmineDb } from '../db/database.ts';
import type { ApiKeyStore } from './apikeys.ts';

export const SESSION_COOKIE = 'jasmine_session';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const LIFETIME = 7 * 24 * 3600;

/** Browser sessions contain random tokens, never the workspace's admin key. */
export class SessionStore {
  constructor(privateDb: JasmineDb, keys: ApiKeyStore, envKey?: string) {
    this.db = privateDb;
    this.keys = keys;
    this.envFingerprint = envKey ? digest(envKey) : '';
  }
  private readonly db: JasmineDb;
  private readonly keys: ApiKeyStore;
  private readonly envFingerprint: string;

  create(apiKey: string): string | undefined {
    const key = this.keys.verify(apiKey);
    if (key?.scope !== 'admin') return undefined;
    const token = randomBytes(32).toString('base64url');
    this.db.run('DELETE FROM browser_sessions WHERE expires_at <= ?', Date.now());
    this.db.run('INSERT INTO browser_sessions (hash, key_id, fingerprint, expires_at) VALUES (?, ?, ?, ?)',
      digest(token), key.id, key.id === 'env' ? this.envFingerprint : '', Date.now() + LIFETIME * 1000);
    return token;
  }

  verify(token: string | undefined): boolean {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const row = this.db.get<{ key_id: string; fingerprint: string }>(
      'SELECT key_id, fingerprint FROM browser_sessions WHERE hash = ? AND expires_at > ?', digest(token), Date.now());
    if (!row) return false;
    if (row.key_id === 'env') return !!this.envFingerprint && row.fingerprint === this.envFingerprint;
    return !!this.db.get("SELECT 1 FROM api_keys WHERE id = ? AND revoked_at IS NULL AND substr(prefix, 1, 6) = 'jsm_a_'", row.key_id);
  }

  revoke(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM browser_sessions WHERE hash = ?', digest(token));
  }

  cookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? LIFETIME : 0}${secure ? '; Secure' : ''}`;
  }
}

export function sessionToken(cookie: string | undefined): string | undefined {
  return cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}

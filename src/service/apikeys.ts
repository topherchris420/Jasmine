import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { JasmineDb } from '../db/database.ts';
import { EngineError } from '../errors.ts';

export type KeyScope = 'admin' | 'execute';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scope: KeyScope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface Row { id: string; name: string; prefix: string; hash: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Project API keys. Only a SHA-256 hash is stored; the token is shown once at creation.
 * `admin` keys can manage the project (Studio API); `execute` keys can only run flows and read run status.
 */
export class ApiKeyStore {
  private readonly db: JasmineDb;
  private readonly envKey: string | undefined;
  private readonly touched = new Map<string, number>();

  constructor(db: JasmineDb, envKey?: string) {
    this.db = db;
    this.envKey = envKey || undefined;
  }

  /** Studio/management requests need an admin key once one exists (or JASMINE_API_KEY is set). */
  get adminEnabled(): boolean {
    return !!this.envKey || !!this.db.get("SELECT 1 FROM api_keys WHERE revoked_at IS NULL AND substr(prefix, 1, 6) = 'jsm_a_' LIMIT 1");
  }

  /** Flow execution needs a key (admin or execute) once any key exists. */
  get executeEnabled(): boolean {
    return !!this.envKey || !!this.db.get('SELECT 1 FROM api_keys WHERE revoked_at IS NULL LIMIT 1');
  }

  list(): ApiKeyView[] {
    return this.db.all<Row>('SELECT * FROM api_keys ORDER BY created_at DESC').map(view);
  }

  create(name: string, scope: KeyScope = 'execute'): { key: ApiKeyView; token: string } {
    const clean = name.trim();
    if (!clean || clean.length > 100) throw new EngineError('BAD_PAYLOAD', 'Key name must contain 1–100 characters');
    if (scope !== 'admin' && scope !== 'execute') throw new EngineError('BAD_PAYLOAD', 'Scope must be admin or execute');
    const token = `jsm_${scope === 'admin' ? 'a' : 'x'}_${randomBytes(24).toString('base64url')}`;
    const id = randomUUID();
    this.db.run('INSERT INTO api_keys (id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?)', id, clean, token.slice(0, 12), hash(token), new Date().toISOString());
    return { key: view(this.db.get<Row>('SELECT * FROM api_keys WHERE id = ?', id)!), token };
  }

  revoke(id: string): boolean {
    return Number(this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', new Date().toISOString(), id).changes) > 0;
  }

  /** Returns the key's scope, or undefined for unknown or revoked tokens. */
  verify(token: string | undefined): { id: string; scope: KeyScope } | undefined {
    if (!token) return undefined;
    if (this.envKey && safeEqual(token, this.envKey)) return { id: 'env', scope: 'admin' };
    const row = this.db.get<Row>('SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL', hash(token));
    if (!row) return undefined;
    const now = Date.now();
    if ((this.touched.get(row.id) ?? 0) < now - 60_000) {
      this.touched.set(row.id, now);
      this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', new Date(now).toISOString(), row.id);
    }
    return { id: row.id, scope: scopeOf(row.prefix) };
  }
}

const scopeOf = (prefix: string): KeyScope => (prefix.startsWith('jsm_a_') ? 'admin' : 'execute');

function view(r: Row): ApiKeyView {
  return { id: r.id, name: r.name, prefix: `${r.prefix}…`, scope: scopeOf(r.prefix), createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

import { randomUUID } from 'node:crypto';
import type { JasmineDb } from '../db/database.ts';
import type { SecretBox } from '../db/secrets.ts';
import { EngineError } from '../errors.ts';

export interface CredentialView {
  id: string;
  integration: string;
  name: string;
  /** Field names only; values never leave the server. */
  fields: string[];
  createdAt: string;
  updatedAt: string;
}

interface Row { id: string; integration: string; name: string; secret: string; created_at: string; updated_at: string }

export interface CredentialResolver {
  /**
   * Finds a credential by id or name, optionally constrained to an integration. Without a reference,
   * returns the integration's credential when exactly one exists.
   */
  resolve(ref: string | undefined, integration?: string): Record<string, string> | undefined;
  updateTokens?(ref: string | undefined, integration: string, tokens: Record<string, string>): void;
}

/** Integration credentials (tokens, webhook URLs, connection strings), encrypted at rest. */
export class CredentialStore implements CredentialResolver {
  private readonly db: JasmineDb;
  private readonly secrets: SecretBox;

  constructor(db: JasmineDb, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  list(integration?: string): CredentialView[] {
    const rows = integration
      ? this.db.all<Row>('SELECT * FROM credentials WHERE integration = ? ORDER BY name', integration)
      : this.db.all<Row>('SELECT * FROM credentials ORDER BY integration, name');
    return rows.map((r) => this.view(r));
  }

  upsert(input: { id?: string; integration: string; name: string; data: Record<string, unknown> }): CredentialView {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.integration)) throw new EngineError('BAD_PAYLOAD', 'Invalid integration id');
    const name = input.name?.trim();
    if (!name || name.length > 100) throw new EngineError('BAD_PAYLOAD', 'Credential name must contain 1–100 characters');
    if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new EngineError('BAD_PAYLOAD', 'Credential data must be an object');
    const existing = input.id ? this.db.get<Row>('SELECT * FROM credentials WHERE id = ?', input.id) : undefined;
    if (input.id && !existing) throw new EngineError('NOT_FOUND', 'Credential not found');
    // Blank fields on update keep their stored value, so the UI never needs to read secrets back.
    const previous = existing ? this.secrets.openJson<Record<string, string>>(existing.secret) : {};
    const data: Record<string, string> = { ...previous };
    for (const [k, v] of Object.entries(input.data)) {
      if (v === undefined || v === null || (v === '' && existing)) continue;
      data[k] = String(v);
    }
    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    try {
      this.db.run(
        `INSERT INTO credentials (id, integration, name, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, secret = excluded.secret, updated_at = excluded.updated_at`,
        id, input.integration, name, this.secrets.sealJson(data), existing?.created_at ?? now, now,
      );
    } catch (e) {
      if (/UNIQUE/.test((e as Error).message)) throw new EngineError('CONFLICT', `A ${input.integration} credential named "${name}" already exists`);
      throw e;
    }
    return this.view(this.db.get<Row>('SELECT * FROM credentials WHERE id = ?', id)!);
  }

  remove(id: string): boolean {
    return Number(this.db.run('DELETE FROM credentials WHERE id = ?', id).changes) > 0;
  }

  resolve(ref: string | undefined, integration?: string): Record<string, string> | undefined {
    if (!ref) {
      if (!integration) return undefined;
      const rows = this.db.all<Row>('SELECT * FROM credentials WHERE integration = ? LIMIT 2', integration);
      return rows.length === 1 ? this.secrets.openJson<Record<string, string>>(rows[0]!.secret) : undefined;
    }
    const row = integration
      ? this.db.get<Row>('SELECT * FROM credentials WHERE integration = ? AND (id = ? OR name = ?)', integration, ref, ref)
      : this.db.get<Row>('SELECT * FROM credentials WHERE id = ? OR name = ?', ref, ref);
    return row ? this.secrets.openJson<Record<string, string>>(row.secret) : undefined;
  }

  /** Persists OAuth token rotation without returning secret values to Studio. */
  updateTokens(ref: string | undefined, integration: string, tokens: Record<string, string>): void {
    const rows = ref
      ? this.db.all<Row>('SELECT * FROM credentials WHERE integration = ? AND (id = ? OR name = ?)', integration, ref, ref)
      : this.db.all<Row>('SELECT * FROM credentials WHERE integration = ? LIMIT 2', integration);
    if (rows.length !== 1) throw new EngineError('CONFLICT', 'Choose one credential before refreshing its token');
    const row = rows[0]!;
    const data = { ...this.secrets.openJson<Record<string, string>>(row.secret), ...tokens };
    this.db.run('UPDATE credentials SET secret = ?, updated_at = ? WHERE id = ?', this.secrets.sealJson(data), new Date().toISOString(), row.id);
  }

  private view(r: Row): CredentialView {
    return {
      id: r.id, integration: r.integration, name: r.name,
      fields: Object.keys(this.secrets.openJson<Record<string, string>>(r.secret)),
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }
}

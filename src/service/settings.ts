import { json, parseJson, type JasmineDb } from '../db/database.ts';

/** Small JSON key/value settings stored in the operational database. */
export class SettingsStore {
  private readonly db: JasmineDb;

  constructor(db: JasmineDb) {
    this.db = db;
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return row ? parseJson(row.value, fallback) : fallback;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, json(value), new Date().toISOString(),
    );
  }
}

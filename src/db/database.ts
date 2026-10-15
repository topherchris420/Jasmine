import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * Jasmine's operational store: deployments, run logs, vector collections, chat sessions,
 * connections, credentials and API keys. One SQLite file per data directory, WAL mode.
 * Flow drafts stay in the workspace snapshot (`workspace.json`).
 */
export class JasmineDb {
  readonly sqlite: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  static memory(): JasmineDb {
    return new JasmineDb(':memory:');
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.sqlite.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }

  /** Runs `fn` atomically; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    if (this.sqlite.isOpen) this.sqlite.close();
  }

  private depth = 0;

  private migrate(): void {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (applied.has(version)) return;
      this.transaction(() => {
        this.sqlite.exec(sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, new Date().toISOString());
      });
    });
  }
}

export const json = (value: unknown): string => JSON.stringify(value ?? null);
export const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const MIGRATIONS: string[] = [
  /* 1: core */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE model_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT,
    api_key TEXT,
    chat_model TEXT,
    embedding_model TEXT,
    aliases TEXT NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    integration TEXT NOT NULL,
    name TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (integration, name)
  );

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE deployment_versions (
    flow_id TEXT NOT NULL,
    version TEXT NOT NULL,
    definition TEXT NOT NULL,
    deployed_at TEXT NOT NULL,
    PRIMARY KEY (flow_id, version)
  );
  CREATE TABLE deployment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id TEXT NOT NULL,
    version TEXT,
    action TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX deployment_events_flow ON deployment_events (flow_id, id);
  CREATE TABLE active_deployments (flow_id TEXT PRIMARY KEY, version TEXT NOT NULL, activated_at TEXT NOT NULL);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    version TEXT NOT NULL,
    source TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    status_code INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms REAL,
    input TEXT,
    output TEXT,
    error_code TEXT,
    error TEXT,
    nodes TEXT,
    trace TEXT,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    models TEXT,
    retry_of TEXT
  );
  CREATE INDEX runs_flow_started ON runs (flow_id, started_at);
  CREATE INDEX runs_started ON runs (started_at);
  CREATE INDEX runs_status ON runs (status);

  CREATE TABLE vector_collections (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    dimension INTEGER,
    metric TEXT NOT NULL DEFAULT 'cosine',
    embedding_connection TEXT,
    embedding_model TEXT,
    kind TEXT NOT NULL DEFAULT 'knowledge',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE vector_records (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL REFERENCES vector_collections (name) ON DELETE CASCADE,
    id TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    vector BLOB,
    document_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (collection, id)
  );
  CREATE INDEX vector_records_document ON vector_records (collection, document_id);
  CREATE VIRTUAL TABLE vector_fts USING fts5 (text, content = 'vector_records', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER vector_records_ai AFTER INSERT ON vector_records BEGIN
    INSERT INTO vector_fts (rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER vector_records_ad AFTER DELETE ON vector_records BEGIN
    INSERT INTO vector_fts (vector_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER vector_records_au AFTER UPDATE ON vector_records BEGIN
    INSERT INTO vector_fts (vector_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO vector_fts (rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL REFERENCES vector_collections (name) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    mime TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    chunks INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX documents_collection ON documents (collection, created_at);

  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX chat_messages_session ON chat_messages (flow_id, session_id, id);

  CREATE TABLE prompts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    messages TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE schedule_state (flow_id TEXT PRIMARY KEY, last_fired_at TEXT, last_run_id TEXT, last_status TEXT);
  `,
  /* 2: local monitoring alerts */ `
  CREATE TABLE alert_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, flow_id TEXT, kind TEXT NOT NULL, threshold REAL NOT NULL, enabled INTEGER NOT NULL);
  CREATE TABLE alert_events (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, rule_name TEXT NOT NULL, run_id TEXT NOT NULL, flow_id TEXT NOT NULL,
    kind TEXT NOT NULL, value REAL NOT NULL, threshold REAL NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT, UNIQUE(rule_id,run_id));
  CREATE INDEX alert_events_created ON alert_events(created_at);
  `,
  /* 3: durable execution, response caching and feedback */ `
  CREATE TABLE execution_state(id TEXT PRIMARY KEY,flow_id TEXT NOT NULL,version TEXT NOT NULL,secret TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE execution_keys(flow_id TEXT NOT NULL,key_hash TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(flow_id,key_hash));
  CREATE TABLE response_cache(cache_key TEXT PRIMARY KEY,flow_id TEXT NOT NULL,secret TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE TABLE run_feedback(id TEXT PRIMARY KEY,feedback_id TEXT NOT NULL,request_id TEXT NOT NULL,rating INTEGER,weight REAL NOT NULL,comment TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE INDEX run_feedback_request ON run_feedback(request_id);
  CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY,secret TEXT NOT NULL,expires_at INTEGER NOT NULL);
  `,
  /* 4: revocable browser sessions, bound to an active admin key */ `
  CREATE TABLE browser_sessions (hash TEXT PRIMARY KEY, key_id TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX browser_sessions_expiry ON browser_sessions (expires_at);
  `,
];

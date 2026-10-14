import { createHash } from 'node:crypto';
import type { JasmineDb } from '../db/database.ts';
import type { SecretBox } from '../db/secrets.ts';
import type { RunResult } from '../runtime/executor.ts';

export interface ExecutionSnapshot {
  requestId: string;
  flowId: string;
  version: string;
  payloadHash: string;
  idempotencyRoot: string;
  input: unknown;
  result?: RunResult;
}

/** Encrypted execution records, separate from deliberately redacted monitoring logs. */
export class ExecutionStateStore {
  constructor(privateDb: JasmineDb, box: SecretBox) {
    this.db = privateDb;
    this.box = box;
  }
  private readonly db: JasmineDb;
  private readonly box: SecretBox;
  accept(snapshot: ExecutionSnapshot): void {
    this.db.run(
      'INSERT INTO execution_state (id,flow_id,version,secret,updated_at) VALUES (?,?,?,?,?)',
      snapshot.requestId,
      snapshot.flowId,
      snapshot.version,
      this.box.sealJson(snapshot),
      new Date().toISOString(),
    );
  }
  finish(id: string, result: RunResult): void {
    const prior = this.get(id);
    if (!prior) return;
    this.db.run(
      'UPDATE execution_state SET secret=?,updated_at=? WHERE id=?',
      this.box.sealJson({ ...prior, result }),
      new Date().toISOString(),
      id,
    );
  }
  get(id: string): ExecutionSnapshot | undefined {
    const row = this.db.get<{ secret: string }>('SELECT secret FROM execution_state WHERE id=?', id);
    return row ? this.box.openJson<ExecutionSnapshot>(row.secret) : undefined;
  }
  bind(flowId: string, key: string, requestId: string, payloadHash: string, ttlMs: number): void {
    this.db.run(
      'INSERT INTO execution_keys (flow_id,key_hash,request_id,payload_hash,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(flow_id,key_hash) DO UPDATE SET request_id=excluded.request_id,payload_hash=excluded.payload_hash,expires_at=excluded.expires_at',
      flowId,
      digest(key),
      requestId,
      payloadHash,
      Date.now() + ttlMs,
    );
  }
  lookup(flowId: string, key: string): { requestId: string; payloadHash: string } | undefined {
    const row = this.db.get<{ request_id: string; payload_hash: string }>(
      'SELECT request_id,payload_hash FROM execution_keys WHERE flow_id=? AND key_hash=? AND expires_at>?',
      flowId,
      digest(key),
      Date.now(),
    );
    return row ? { requestId: row.request_id, payloadHash: row.payload_hash } : undefined;
  }
  prune(): void {
    this.db.run('DELETE FROM execution_keys WHERE expires_at<=?', Date.now());
    this.db.run(
      'DELETE FROM execution_state WHERE id NOT IN (SELECT id FROM runs) AND id NOT IN (SELECT request_id FROM execution_keys)',
    );
  }
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

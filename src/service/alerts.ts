import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JasmineDb } from '../db/database.ts';
import { EngineError } from '../errors.ts';
import type { RunResult } from '../runtime/executor.ts';
import type { RunSummary } from './runlog.ts';

const ruleSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100),
  flowId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).nullable().default(null),
  kind: z.enum(['failure', 'latency', 'tokens']), threshold: z.number().finite().nonnegative().max(1e12).default(0), enabled: z.boolean().default(true),
});
export interface AlertRule { id: string; name: string; flowId: string | null; kind: 'failure' | 'latency' | 'tokens'; threshold: number; enabled: boolean; }
export interface AlertEvent { id: string; ruleId: string; ruleName: string; runId: string; flowId: string; kind: string; value: number; threshold: number; createdAt: string; acknowledgedAt: string | null; }

/** Local monitoring inbox. Rule evaluation is deterministic and performs no external delivery. */
export class AlertStore {
  constructor(privateDb: JasmineDb) { this.db = privateDb; }
  private readonly db: JasmineDb;
  rules(): AlertRule[] {
    return this.db.all<{ id: string; name: string; flow_id: string | null; kind: AlertRule['kind']; threshold: number; enabled: number }>('SELECT * FROM alert_rules ORDER BY name, id').map((r) => ({ id: r.id, name: r.name, flowId: r.flow_id, kind: r.kind, threshold: r.threshold, enabled: !!r.enabled }));
  }
  upsert(input: unknown): AlertRule {
    const parsed = ruleSchema.safeParse(input);
    if (!parsed.success) throw new EngineError('BAD_PAYLOAD', 'Invalid alert rule', { details: parsed.error.issues });
    const r = { ...parsed.data, id: parsed.data.id ?? randomUUID() };
    this.db.run(`INSERT INTO alert_rules (id,name,flow_id,kind,threshold,enabled) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,flow_id=excluded.flow_id,kind=excluded.kind,threshold=excluded.threshold,enabled=excluded.enabled`, r.id, r.name, r.flowId, r.kind, r.threshold, r.enabled ? 1 : 0);
    return r;
  }
  remove(id: string): boolean { return Number(this.db.run('DELETE FROM alert_rules WHERE id=?', id).changes) > 0; }
  evaluate(run: RunResult, status: RunSummary['status']): void {
    // Cancelled runs are intentional; failures include interrupted/error runs completed by the engine.
    for (const rule of this.rules()) {
      if (!rule.enabled || (rule.flowId && rule.flowId !== run.flowId)) continue;
      const value = rule.kind === 'failure' ? (status === 'failed' || status === 'error' ? 1 : 0) : rule.kind === 'latency' ? run.timeTakenMs : run.usage.inputTokens + run.usage.outputTokens;
      if (rule.kind === 'failure' ? value === 0 : value <= rule.threshold) continue;
      this.db.run('INSERT OR IGNORE INTO alert_events (id,rule_id,rule_name,run_id,flow_id,kind,value,threshold,created_at) VALUES (?,?,?,?,?,?,?,?,?)', randomUUID(), rule.id, rule.name, run.runId, run.flowId, rule.kind, value, rule.threshold, new Date().toISOString());
    }
  }
  list(unread = false, limit = 100): AlertEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new EngineError('BAD_PAYLOAD', 'Alert limit must be 1–500');
    return this.db.all<{ id: string; rule_id: string; rule_name: string; run_id: string; flow_id: string; kind: string; value: number; threshold: number; created_at: string; acknowledged_at: string | null }>(`SELECT * FROM alert_events ${unread ? 'WHERE acknowledged_at IS NULL' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, limit).map((r) => ({ id:r.id, ruleId:r.rule_id, ruleName:r.rule_name, runId:r.run_id, flowId:r.flow_id, kind:r.kind, value:r.value, threshold:r.threshold, createdAt:r.created_at, acknowledgedAt:r.acknowledged_at }));
  }
  acknowledge(id: string): boolean { return Number(this.db.run('UPDATE alert_events SET acknowledged_at=? WHERE id=? AND acknowledged_at IS NULL', new Date().toISOString(), id).changes) > 0; }
}

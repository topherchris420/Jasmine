import { canonicalJson, sha256 } from '../canonical.ts';
import type { JasmineDb } from '../db/database.ts';
import type { SecretBox } from '../db/secrets.ts';
import type { ExecutionPlan } from '../flow/compile.ts';
import type { ExecuteResponse } from './runs.ts';
import type { SettingsStore } from './settings.ts';

export interface CachePolicy {
  enabled: boolean;
  ttlSeconds: number;
}
/** Version-addressed, encrypted, opt-in response cache. Side-effecting flows bypass it. */
export class ResponseCache {
  constructor(db: JasmineDb, box: SecretBox, settings: SettingsStore, context: () => unknown) {
    this.db = db;
    this.box = box;
    this.settings = settings;
    this.context = context;
  }
  private readonly db: JasmineDb;
  private readonly box: SecretBox;
  private readonly settings: SettingsStore;
  private readonly context: () => unknown;
  policy(id: string): CachePolicy {
    return this.settings.get(`flow-cache:${id}`, { enabled: false, ttlSeconds: 86400 });
  }
  configure(id: string, policy: CachePolicy): CachePolicy {
    if (
      typeof policy.enabled !== 'boolean' ||
      !Number.isInteger(policy.ttlSeconds) ||
      policy.ttlSeconds < 1 ||
      policy.ttlSeconds > 86400
    )
      throw new Error('Cache TTL must be 1–86400 seconds');
    this.settings.set(`flow-cache:${id}`, policy);
    this.clear(id);
    return policy;
  }
  key(plan: ExecutionPlan, payload: unknown): string | undefined {
    if (
      !this.policy(plan.flowId).enabled ||
      [...plan.nodes.values()].some(
        (n) => n.handler.sideEffect?.(n.node) || ['agentNode', 'mcpNode', 'flowNode'].includes(n.node.type),
      )
    )
      return undefined;
    return sha256(canonicalJson({ flow: plan.flowId, version: plan.version, payload, context: this.context() }));
  }
  get(key: string): ExecuteResponse | undefined {
    const row = this.db.get<{ secret: string }>(
      'SELECT secret FROM response_cache WHERE cache_key=? AND expires_at>?',
      key,
      Date.now(),
    );
    return row ? { ...this.box.openJson<ExecuteResponse>(row.secret), cached: true } : undefined;
  }
  put(key: string, flowId: string, response: ExecuteResponse): void {
    if (response.status !== 'success') return;
    this.db.run(
      'INSERT INTO response_cache(cache_key,flow_id,secret,expires_at) VALUES(?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at',
      key,
      flowId,
      this.box.sealJson(response),
      Date.now() + this.policy(flowId).ttlSeconds * 1000,
    );
  }
  clear(flowId?: string): number {
    return Number(
      flowId
        ? this.db.run('DELETE FROM response_cache WHERE flow_id=?', flowId).changes
        : this.db.run('DELETE FROM response_cache').changes,
    );
  }
  prune(): void {
    this.db.run('DELETE FROM response_cache WHERE expires_at<=?', Date.now());
  }
}

import { canonicalJson, sha256 } from '../canonical.ts';
import type { JasmineDb } from '../db/database.ts';
import type { SecretBox } from '../db/secrets.ts';
import type { CompiledNode, ExecutionPlan } from '../flow/compile.ts';
import type { ExecuteResponse } from './runs.ts';
import type { SettingsStore } from './settings.ts';

export interface CachePolicy {
  enabled: boolean;
  ttlSeconds: number;
}
/** Node types whose work is not described by their own values: agents, MCP tool use and sub-flows. */
const UNCACHEABLE_TYPES = new Set(['agentNode', 'mcpNode', 'flowNode']);

/** True when a node has model tools configured (an array, or its JSON text). Tools can call HTTP APIs, flows or MCP servers. */
export function hasTools(values: Record<string, unknown> | undefined): boolean {
  let tools = values?.['tools'];
  if (typeof tools === 'string') {
    const text = tools.trim();
    if (!text) return false;
    try {
      tools = JSON.parse(text);
    } catch {
      return true; // unparsable but present: treat as configured
    }
  }
  if (Array.isArray(tools)) return tools.length > 0;
  return !!tools && typeof tools === 'object' && Object.keys(tools).length > 0;
}

/** A node may be served from the cache only when replaying its recorded output cannot skip work in another system. */
function cacheable(n: CompiledNode): boolean {
  return !UNCACHEABLE_TYPES.has(n.node.type) && !n.sideEffect && !n.handler.sideEffect?.(n.node) && !hasTools(n.node.values);
}

/** Version-addressed, encrypted, opt-in response cache. Flows with side effects, agents, sub-flows or tool-using model nodes bypass it. */
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
    if (!this.policy(plan.flowId).enabled || [...plan.nodes.values()].some((n) => !cacheable(n))) return undefined;
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

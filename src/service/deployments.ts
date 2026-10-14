import { EngineError } from '../errors.ts';
import { compileFlow, type ExecutionPlan } from '../flow/compile.ts';
import { importStudioFlow, isStudioExport } from '../flow/import.ts';
import { FlowDefinitionSchema, type Diagnostic } from '../flow/schema.ts';
import { versionOf } from '../canonical.ts';
import type { NodeRegistry } from '../nodes/types.ts';

export interface DeployedVersion {
  flowId: string;
  version: string;
  plan: ExecutionPlan;
  deployedAt: string;
  diagnostics: Diagnostic[];
}

export interface DeployResult {
  flowId: string;
  version: string;
  previousVersion: string | null;
  changed: boolean;
  diagnostics: Diagnostic[];
}

/** Ships a compiled version to the runtime (e.g. builds + uploads an edge bundle). Must be idempotent per version. */
export type Publisher = (deployed: DeployedVersion) => Promise<void>;

export interface DeployOptions {
  /** Compare-and-swap guard: the version the caller believes is active (null = none). */
  expectedVersion?: string | null;
  resolveFileRef?: (ref: string) => unknown;
}

/** Durable record of versions, the active pointer and deploy history. */
export interface DeploymentStore {
  saveVersion(flowId: string, version: string, definition: unknown, deployedAt: string): void;
  setActive(flowId: string, version: string | null, at: string, action: 'deploy' | 'rollback' | 'undeploy'): void;
  load(): { versions: { flowId: string; version: string; definition: unknown; deployedAt: string }[]; active: Map<string, string> };
  history(flowId: string, limit: number): { version: string | null; action: string; at: string }[];
  deleteFlow?(flowId: string): void;
}

function toDefinition(flowId: string, input: unknown, opts: Pick<DeployOptions, 'resolveFileRef'>): { definition: unknown; diagnostics: Diagnostic[] } {
  if (isStudioExport(input)) {
    const imported = importStudioFlow(input, { flowId, ...(opts.resolveFileRef ? { resolveFileRef: opts.resolveFileRef } : {}) });
    return { definition: imported.definition, diagnostics: imported.diagnostics };
  }
  return { definition: { ...(input as object), id: flowId }, diagnostics: [] };
}

export type DeploymentListener = (event: { flowId: string; version: string | null; action: 'deploy' | 'rollback' | 'undeploy' }) => void;

export class DeploymentRegistry {
  private readonly registry: NodeRegistry;
  private readonly publish: Publisher;
  private readonly versions = new Map<string, Map<string, DeployedVersion>>();
  private readonly active = new Map<string, string>();
  private readonly history = new Map<string, { version: string; at: string }[]>();
  private readonly store: DeploymentStore | undefined;
  private readonly listeners = new Set<DeploymentListener>();
  stats = { compiles: 0, cacheHits: 0 };

  constructor(registry: NodeRegistry, publish: Publisher = async () => {}, store?: DeploymentStore) {
    this.registry = registry;
    this.publish = publish;
    this.store = store;
  }

  onChange(listener: DeploymentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recompiles every stored version and restores the active pointers. Versions that no longer compile are skipped. */
  restore(): { restored: number; failed: { flowId: string; version: string; error: string }[] } {
    if (!this.store) return { restored: 0, failed: [] };
    const { versions, active } = this.store.load();
    const failed: { flowId: string; version: string; error: string }[] = [];
    let restored = 0;
    for (const v of versions) {
      try {
        const deployed = this.compile(v.flowId, v.definition);
        deployed.deployedAt ||= v.deployedAt;
        const map = this.versions.get(v.flowId) ?? new Map<string, DeployedVersion>();
        map.set(deployed.version, deployed);
        this.versions.set(v.flowId, map);
        restored++;
      } catch (e) {
        failed.push({ flowId: v.flowId, version: v.version, error: (e as Error).message });
      }
    }
    for (const [flowId, version] of active) {
      if (this.versions.get(flowId)?.has(version)) this.active.set(flowId, version);
    }
    // Rebuild each flow's activation history (oldest first) so "roll back to the previous version" still works after a restart.
    for (const flowId of this.versions.keys()) {
      const known = this.versions.get(flowId)!;
      const events = this.store.history(flowId, 50).filter((e) => e.version !== null && known.has(e.version)).reverse();
      const history = events.map((e) => ({ version: e.version!, at: e.at }));
      const current = this.active.get(flowId);
      if (current && history.at(-1)?.version !== current) history.push({ version: current, at: known.get(current)!.deployedAt });
      if (history.length) this.history.set(flowId, history);
    }
    return { restored, failed };
  }

  /** Compiles a draft without activating it (Studio test runs). Throws COMPILE with diagnostics. */
  preview(flowId: string, input: unknown, opts: Pick<DeployOptions, 'resolveFileRef'> = {}): { plan: ExecutionPlan; diagnostics: Diagnostic[] } {
    const { definition, diagnostics } = toDefinition(flowId, input, opts);
    const deployed = this.compile(flowId, definition);
    return { plan: deployed.plan, diagnostics: [...diagnostics, ...deployed.diagnostics] };
  }

  /** Validates a draft and returns every diagnostic without throwing. */
  validate(flowId: string, input: unknown): { ok: boolean; diagnostics: Diagnostic[] } {
    try {
      return { ok: true, diagnostics: this.preview(flowId, input).diagnostics };
    } catch (e) {
      const err = e as EngineError;
      const details = Array.isArray(err.details) ? (err.details as Diagnostic[]) : [{ severity: 'error' as const, code: err.code ?? 'COMPILE', message: err.message }];
      return { ok: false, diagnostics: details };
    }
  }

  /** Forgets a flow entirely: active pointer and every stored version. */
  remove(flowId: string): void {
    this.undeploy(flowId);
    this.versions.delete(flowId);
    this.history.delete(flowId);
    this.store?.deleteFlow?.(flowId);
  }

  /** Stops serving a flow (its versions are kept for rollback). */
  undeploy(flowId: string): boolean {
    if (!this.active.has(flowId)) return false;
    this.active.delete(flowId);
    this.store?.setActive(flowId, null, new Date().toISOString(), 'undeploy');
    for (const l of this.listeners) l({ flowId, version: null, action: 'undeploy' });
    return true;
  }

  activeFlows(): DeployedVersion[] {
    return [...this.active.entries()].map(([flowId, version]) => this.versions.get(flowId)!.get(version)!).filter(Boolean);
  }

  deployHistory(flowId: string, limit = 50): { version: string | null; action: string; at: string }[] {
    return this.store ? this.store.history(flowId, limit) : [...(this.history.get(flowId) ?? [])].reverse().slice(0, limit).map((h) => ({ version: h.version, action: 'deploy', at: h.at }));
  }

  async deploy(flowId: string, input: unknown, opts: DeployOptions = {}): Promise<DeployResult> {
    const before = this.active.get(flowId) ?? null;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== before) {
      throw new EngineError('CONFLICT', `Active version is ${before ?? 'none'}, expected ${opts.expectedVersion ?? 'none'}`);
    }

    const { definition, diagnostics: importDiagnostics } = toDefinition(flowId, input, opts);
    const deployed = this.compile(flowId, definition);
    const diagnostics = [...importDiagnostics, ...deployed.diagnostics];
    if (deployed.version === before) {
      return { flowId, version: deployed.version, previousVersion: before, changed: false, diagnostics };
    }

    try {
      await this.publish(deployed);
    } catch (e) {
      throw new EngineError('DEPLOY_FAILED', `Publishing ${deployed.version} failed; ${before ?? 'no version'} remains active`, { cause: e, retryable: true });
    }

    // The swap is the only mutation and happens after every fallible step. If another deploy
    // finished while this one was publishing, refuse instead of silently overwriting it.
    const current = this.active.get(flowId) ?? null;
    if (current !== before) {
      throw new EngineError('CONFLICT', `${current} was deployed while ${deployed.version} was publishing; redeploy against ${current}`);
    }
    const versions = this.versions.get(flowId) ?? new Map<string, DeployedVersion>();
    this.versions.set(flowId, versions);
    if (!versions.has(deployed.version)) versions.set(deployed.version, deployed);
    this.activate(flowId, deployed.version, 'deploy');
    return { flowId, version: deployed.version, previousVersion: before, changed: true, diagnostics };
  }

  rollback(flowId: string, opts: { toVersion?: string; expectedVersion?: string | null } = {}): DeployResult {
    const before = this.active.get(flowId) ?? null;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== before) {
      throw new EngineError('CONFLICT', `Active version is ${before ?? 'none'}, expected ${opts.expectedVersion ?? 'none'}`);
    }
    const target = opts.toVersion ?? [...(this.history.get(flowId) ?? [])].reverse().find((h) => h.version !== before)?.version;
    if (!target || !this.versions.get(flowId)?.has(target)) throw new EngineError('NOT_FOUND', `No version ${target ?? '(previous)'} to roll back to for ${flowId}`);
    if (target !== before) this.activate(flowId, target, 'rollback');
    return { flowId, version: target, previousVersion: before, changed: target !== before, diagnostics: [] };
  }

  getActive(flowId: string): DeployedVersion | undefined {
    const v = this.active.get(flowId);
    return v ? this.versions.get(flowId)?.get(v) : undefined;
  }

  getVersion(flowId: string, version: string): DeployedVersion | undefined {
    return this.versions.get(flowId)?.get(version);
  }

  listVersions(flowId: string): { version: string; deployedAt: string; active: boolean }[] {
    const active = this.active.get(flowId);
    return [...(this.versions.get(flowId)?.values() ?? [])].map((d) => ({ version: d.version, deployedAt: d.deployedAt, active: d.version === active }));
  }

  /** Content-addressed: an unchanged definition is never recompiled. */
  private compile(flowId: string, definition: unknown): DeployedVersion {
    const parsed = FlowDefinitionSchema.safeParse(definition);
    if (parsed.success) {
      const cached = this.versions.get(flowId)?.get(versionOf(parsed.data));
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }
    }
    this.stats.compiles++;
    const result = compileFlow(definition, this.registry);
    if (!result.ok) {
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      throw new EngineError('COMPILE', `Flow ${flowId} failed to compile: ${errors.map((d) => `${d.code}${d.nodeId ? ` (${d.nodeId})` : ''}`).join(', ')}`, {
        details: result.diagnostics,
      });
    }
    const deployed: DeployedVersion = {
      flowId,
      version: result.plan.version,
      plan: result.plan,
      deployedAt: '',
      diagnostics: result.diagnostics,
    };
    return deployed;
  }

  private activate(flowId: string, version: string, action: 'deploy' | 'rollback') {
    const existing = this.versions.get(flowId)!.get(version)!;
    const at = new Date().toISOString();
    const first = !existing.deployedAt;
    if (first) existing.deployedAt = at;
    if (this.store) {
      if (first) this.store.saveVersion(flowId, version, existing.plan.definition, at);
      this.store.setActive(flowId, version, at, action);
    }
    this.active.set(flowId, version);
    const h = this.history.get(flowId) ?? [];
    h.push({ version, at });
    this.history.set(flowId, h);
    for (const l of this.listeners) l({ flowId, version, action });
  }
}

/** SQLite-backed deployment history. */
export class SqliteDeploymentStore implements DeploymentStore {
  private readonly db: import('../db/database.ts').JasmineDb;

  constructor(db: import('../db/database.ts').JasmineDb) {
    this.db = db;
  }

  saveVersion(flowId: string, version: string, definition: unknown, deployedAt: string): void {
    this.db.run('INSERT OR IGNORE INTO deployment_versions (flow_id, version, definition, deployed_at) VALUES (?, ?, ?, ?)', flowId, version, JSON.stringify(definition), deployedAt);
  }

  setActive(flowId: string, version: string | null, at: string, action: 'deploy' | 'rollback' | 'undeploy'): void {
    this.db.transaction(() => {
      if (version === null) this.db.run('DELETE FROM active_deployments WHERE flow_id = ?', flowId);
      else this.db.run('INSERT INTO active_deployments (flow_id, version, activated_at) VALUES (?, ?, ?) ON CONFLICT (flow_id) DO UPDATE SET version = excluded.version, activated_at = excluded.activated_at', flowId, version, at);
      this.db.run('INSERT INTO deployment_events (flow_id, version, action, at) VALUES (?, ?, ?, ?)', flowId, version, action, at);
    });
  }

  load() {
    const versions = this.db.all<{ flow_id: string; version: string; definition: string; deployed_at: string }>('SELECT * FROM deployment_versions ORDER BY deployed_at')
      .map((r) => ({ flowId: r.flow_id, version: r.version, definition: JSON.parse(r.definition) as unknown, deployedAt: r.deployed_at }));
    const active = new Map(this.db.all<{ flow_id: string; version: string }>('SELECT flow_id, version FROM active_deployments').map((r) => [r.flow_id, r.version]));
    return { versions, active };
  }

  history(flowId: string, limit: number) {
    return this.db.all<{ version: string | null; action: string; at: string }>('SELECT version, action, at FROM deployment_events WHERE flow_id = ? ORDER BY id DESC LIMIT ?', flowId, limit);
  }

  deleteFlow(flowId: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM deployment_versions WHERE flow_id = ?', flowId);
      this.db.run('DELETE FROM active_deployments WHERE flow_id = ?', flowId);
    });
  }
}

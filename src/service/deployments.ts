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

export class DeploymentRegistry {
  private readonly registry: NodeRegistry;
  private readonly publish: Publisher;
  private readonly versions = new Map<string, Map<string, DeployedVersion>>();
  private readonly active = new Map<string, string>();
  private readonly history = new Map<string, { version: string; at: string }[]>();
  stats = { compiles: 0, cacheHits: 0 };

  constructor(registry: NodeRegistry, publish: Publisher = async () => {}) {
    this.registry = registry;
    this.publish = publish;
  }

  async deploy(flowId: string, input: unknown, opts: DeployOptions = {}): Promise<DeployResult> {
    const before = this.active.get(flowId) ?? null;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== before) {
      throw new EngineError('CONFLICT', `Active version is ${before ?? 'none'}, expected ${opts.expectedVersion ?? 'none'}`);
    }

    let importDiagnostics: Diagnostic[] = [];
    let definition: unknown;
    if (isStudioExport(input)) {
      const imported = importStudioFlow(input, { flowId, ...(opts.resolveFileRef ? { resolveFileRef: opts.resolveFileRef } : {}) });
      definition = imported.definition;
      importDiagnostics = imported.diagnostics;
    } else {
      definition = { ...(input as object), id: flowId };
    }

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
    this.activate(flowId, deployed.version);
    return { flowId, version: deployed.version, previousVersion: before, changed: true, diagnostics };
  }

  rollback(flowId: string, opts: { toVersion?: string; expectedVersion?: string | null } = {}): DeployResult {
    const before = this.active.get(flowId) ?? null;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== before) {
      throw new EngineError('CONFLICT', `Active version is ${before ?? 'none'}, expected ${opts.expectedVersion ?? 'none'}`);
    }
    const target = opts.toVersion ?? [...(this.history.get(flowId) ?? [])].reverse().find((h) => h.version !== before)?.version;
    if (!target || !this.versions.get(flowId)?.has(target)) throw new EngineError('NOT_FOUND', `No version ${target ?? '(previous)'} to roll back to for ${flowId}`);
    if (target !== before) this.activate(flowId, target);
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

  private activate(flowId: string, version: string) {
    const existing = this.versions.get(flowId)!.get(version)!;
    const at = new Date().toISOString();
    if (!existing.deployedAt) existing.deployedAt = at;
    this.active.set(flowId, version);
    const h = this.history.get(flowId) ?? [];
    h.push({ version, at });
    this.history.set(flowId, h);
  }
}

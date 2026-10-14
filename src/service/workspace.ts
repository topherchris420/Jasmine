import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EngineError } from '../errors.ts';
import { isStudioExport } from '../flow/import.ts';
import { FlowDefinitionSchema, StudioFlowSchema } from '../flow/schema.ts';

export interface WorkspaceFlow {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  definition: unknown;
  deployedDefinition?: unknown;
  deployedVersion?: string;
}

/** Local draft storage. Writes are serialized and atomically replace a complete snapshot. */
export class WorkspaceStore {
  private flows = new Map<string, WorkspaceFlow>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'workspace.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || (data as { schema?: unknown }).schema !== 1 || !Array.isArray((data as { flows?: unknown }).flows)) {
      throw new Error('Invalid Jasmine workspace snapshot');
    }
    for (const flow of (data as { flows: WorkspaceFlow[] }).flows) {
      this.validate(flow.id, flow.definition);
      if (typeof flow.name !== 'string' || !Number.isSafeInteger(flow.revision) || flow.revision < 1 || typeof flow.updatedAt !== 'string') throw new Error('Invalid workspace flow metadata');
      if (flow.deployedDefinition !== undefined) this.validate(flow.id, flow.deployedDefinition);
      this.flows.set(flow.id, structuredClone(flow));
    }
  }

  list(): WorkspaceFlow[] { return structuredClone([...this.flows.values()]); }
  get(id: string): WorkspaceFlow | undefined { const flow = this.flows.get(id); return flow && structuredClone(flow); }

  save(id: string, name: string, definition: unknown, expectedRevision?: number): Promise<WorkspaceFlow> {
    this.validate(id, definition);
    if (!name.trim() || name.length > 200) throw new EngineError('BAD_PAYLOAD', 'Flow name must contain 1–200 characters');
    return this.mutate(() => {
      const old = this.flows.get(id);
      if (expectedRevision !== undefined && expectedRevision !== (old?.revision ?? 0)) throw new EngineError('CONFLICT', 'This flow changed in another tab; reload before saving');
      const next: WorkspaceFlow = { ...old, id, name, definition: structuredClone(definition), revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      this.flows.set(id, next);
      return structuredClone(next);
    });
  }

  markDeployed(id: string, definition: unknown, version: string): Promise<WorkspaceFlow> {
    return this.mutate(() => {
      const current = this.flows.get(id);
      if (!current) throw new EngineError('NOT_FOUND', 'Save this flow before deploying');
      current.deployedDefinition = structuredClone(definition);
      current.deployedVersion = version;
      return structuredClone(current);
    });
  }

  private validate(id: string, definition: unknown): void {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new EngineError('BAD_PAYLOAD', 'Invalid workflow ID');
    const nodes = (definition as { nodes?: unknown } | null)?.nodes;
    const studioDraft = isStudioExport(definition) || (Array.isArray(nodes) && nodes.length === 0);
    const parsed = studioDraft ? StudioFlowSchema.safeParse(definition) : FlowDefinitionSchema.safeParse(definition);
    if (!parsed.success) throw new EngineError('BAD_PAYLOAD', 'Invalid flow definition', { details: parsed.error.issues });
  }

  private mutate<T>(change: () => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const previous = structuredClone(this.flows);
      try {
        const result = change();
        const temporary = path.join(this.directory, `workspace-${randomUUID()}.tmp`);
        await writeFile(temporary, JSON.stringify({ schema: 1, flows: [...this.flows.values()] }, null, 2), { mode: 0o600 });
        await rename(temporary, path.join(this.directory, 'workspace.json'));
        return result;
      } catch (error) { this.flows = previous; throw error; }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

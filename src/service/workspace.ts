import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
    const restored = new Map<string, WorkspaceFlow>();
    for (const flow of (data as { flows: WorkspaceFlow[] }).flows) {
      if (!flow || typeof flow !== 'object') throw new Error('Invalid workspace flow metadata');
      this.validate(flow.id, flow.definition);
      if (typeof flow.name !== 'string' || !Number.isSafeInteger(flow.revision) || flow.revision < 1 || typeof flow.updatedAt !== 'string') throw new Error('Invalid workspace flow metadata');
      if (flow.deployedDefinition !== undefined) this.validate(flow.id, flow.deployedDefinition);
      if (restored.has(flow.id)) throw new Error('Duplicate workspace flow ID');
      if (flow.deployedVersion !== undefined && (typeof flow.deployedVersion !== 'string' || !flow.deployedVersion)) throw new Error('Invalid deployed version');
      restored.set(flow.id, structuredClone(flow));
    }
    this.flows = restored;
  }

  list(): WorkspaceFlow[] { return structuredClone([...this.flows.values()]); }
  get(id: string): WorkspaceFlow | undefined { const flow = this.flows.get(id); return flow && structuredClone(flow); }

  save(id: string, name: string, definition: unknown, expectedRevision?: number): Promise<WorkspaceFlow> {
    this.validate(id, definition);
    if (!name.trim() || name.length > 200) throw new EngineError('BAD_PAYLOAD', 'Flow name must contain 1–200 characters');
    const snapshot = structuredClone(definition);
    return this.mutate((flows) => {
      const old = flows.get(id);
      if (expectedRevision !== undefined && expectedRevision !== (old?.revision ?? 0)) throw new EngineError('CONFLICT', 'This flow changed in another tab; reload before saving');
      const next: WorkspaceFlow = { ...old, id, name, definition: snapshot, revision: (old?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      flows.set(id, next);
      return structuredClone(next);
    });
  }

  saveMany(entries:{id:string;name:string;definition:unknown}[]):Promise<WorkspaceFlow[]>{
    if(!Array.isArray(entries)||entries.length>500)throw new EngineError('BAD_PAYLOAD','Import at most 500 flows');
    const ids=new Set<string>();for(const entry of entries){this.validate(entry.id,entry.definition);if(ids.has(entry.id)||!entry.name?.trim()||entry.name.length>200)throw new EngineError('BAD_PAYLOAD','Invalid or duplicate imported flow');ids.add(entry.id);}
    const snapshots=structuredClone(entries);return this.mutate(flows=>{for(const entry of snapshots)if(flows.has(entry.id))throw new EngineError('CONFLICT',`Flow ${entry.id} already exists; choose a fresh workspace or rename before import`);const now=new Date().toISOString();const added=snapshots.map(e=>({...e,revision:1,updatedAt:now}));for(const entry of added)flows.set(entry.id,entry);return structuredClone(added);});
  }

  markDeployed(id: string, definition: unknown, version: string): Promise<WorkspaceFlow> {
    this.validate(id, definition);
    if (!version.trim()) throw new EngineError('BAD_PAYLOAD', 'Deployed version must not be empty');
    const snapshot = structuredClone(definition);
    return this.mutate((flows) => {
      const current = flows.get(id);
      if (!current) throw new EngineError('NOT_FOUND', 'Save this flow before deploying');
      current.deployedDefinition = snapshot;
      current.deployedVersion = version;
      return structuredClone(current);
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate((flows) => flows.delete(id));
  }

  rename(id: string, name: string): Promise<WorkspaceFlow> {
    if (!name.trim() || name.length > 200) throw new EngineError('BAD_PAYLOAD', 'Flow name must contain 1–200 characters');
    return this.mutate((flows) => {
      const current = flows.get(id);
      if (!current) throw new EngineError('NOT_FOUND', 'Flow not found');
      current.name = name.trim();
      current.updatedAt = new Date().toISOString();
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

  private mutate<T>(change: (flows: Map<string, WorkspaceFlow>) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.flows);
      const temporary = path.join(this.directory, `workspace-${randomUUID()}.tmp`);
      try {
        const result = change(next);
        await writeFile(temporary, JSON.stringify({ schema: 1, flows: [...next.values()] }, null, 2), { mode: 0o600 });
        await rename(temporary, path.join(this.directory, 'workspace.json'));
        this.flows = next;
        return result;
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}


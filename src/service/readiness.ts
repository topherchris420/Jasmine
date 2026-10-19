import type { Jasmine } from '../app.ts';
import { collectRefs } from '../flow/template.ts';
import type { ModelInfo } from '../llm/types.ts';
import { modelConfigs } from '../nodes/common.ts';
import { NEEDS_CHAT_MODEL, NEEDS_EMBEDDINGS, PUBLIC_WIDGET_TRIGGERS, READS_COLLECTION, SCHEDULED_TRIGGERS, WRITES_COLLECTION } from '../nodes/guide.ts';
import type { CollectionInfo } from '../vector/store.ts';

/** What one connection looks like right now: reachability and the models it serves. Never contains credentials. */
export interface ConnectionState {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  models: ModelInfo[];
  chatModel: string | null;
  embeddingModel: string | null;
  defaultChat: boolean;
  defaultEmbedding: boolean;
  /** The base URL points at the runtime's own loopback interface. */
  loopback: boolean;
}

export interface WorkspaceSnapshot {
  connections: ConnectionState[];
  collections: Pick<CollectionInfo, 'name' | 'kind' | 'records' | 'documents' | 'embeddingConnection' | 'embeddingModel'>[];
  credentials: { integration: string; name: string; id: string }[];
  /** True when the runtime is reached through a hosted URL, so `localhost` means the runtime, not the visitor's computer. */
  hosted: boolean;
}

export type RequirementStatus = 'ready' | 'missing' | 'warning' | 'info';

export interface Requirement {
  id: string;
  kind: 'model' | 'embedding' | 'collection' | 'credential' | 'input' | 'runtime' | 'exposure';
  status: RequirementStatus;
  title: string;
  detail: string;
  nodeIds: string[];
  action?: { label: string; href: string };
}

export interface Readiness {
  /** Nothing is missing: the workflow can be tested now. Warnings may still apply. */
  ready: boolean;
  missing: number;
  warnings: number;
  requirements: Requirement[];
}

interface PlainNode {
  id: string;
  type: string;
  values: Record<string, unknown>;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

export function isLoopback(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return LOOPBACK.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Reads connection reachability, collections and credential names. Connection probes run in parallel and are time-bounded. */
export async function workspaceSnapshot(app: Jasmine, timeoutMs = 4000): Promise<WorkspaceSnapshot> {
  const connections = await Promise.all(app.connections.list().map(async (c) => {
    const t = await app.connections.test(c.id, timeoutMs);
    return {
      id: c.id, name: c.name, kind: c.kind, baseUrl: c.baseUrl, ok: t.ok, error: t.error ?? null, latencyMs: t.latencyMs, models: t.models,
      chatModel: c.chatModel, embeddingModel: c.embeddingModel, defaultChat: c.defaultChat, defaultEmbedding: c.defaultEmbedding, loopback: isLoopback(c.baseUrl),
    };
  }));
  const env = app.config.env ?? {};
  return {
    connections,
    collections: app.vectors.listCollections().map((c) => ({ name: c.name, kind: c.kind, records: c.records, documents: c.documents, embeddingConnection: c.embeddingConnection, embeddingModel: c.embeddingModel })),
    credentials: app.credentials.list().map((c) => ({ integration: c.integration, name: c.name, id: c.id })),
    hosted: !!env['JASMINE_GATEWAY_SECRET'] || (env['PUBLIC_URL'] ?? '').startsWith('https://'),
  };
}

/** Accepts Studio drafts (`data.nodeId`) and engine definitions (`type`). */
export function nodesOf(definition: unknown): PlainNode[] {
  const nodes = (definition as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: PlainNode[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as { id?: unknown; type?: unknown; values?: unknown; data?: { nodeId?: unknown; values?: unknown } };
    const type = typeof n.data?.nodeId === 'string' ? n.data.nodeId : typeof n.type === 'string' ? n.type : undefined;
    if (typeof n.id !== 'string' || !type) continue;
    const values = (n.data ? n.data.values : n.values) ?? {};
    out.push({ id: n.id, type, values: values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {} });
  }
  return out;
}

/** Edges that only return a response or close a loop; they do not order steps. */
const NON_EXEC_EDGES = new Set(['responseEdge', 'loopEdge', 'agentLoopEdge', 'response', 'loop']);

/**
 * A check of whether one step always runs before another: every path from the trigger to `later` passes through `earlier`.
 * Reads execution edges of a Studio draft or an engine definition.
 */
function runsBefore(definition: unknown): (earlier: string, later: string) => boolean {
  const raw = (definition ?? {}) as { nodes?: unknown; edges?: unknown };
  const edges = ((Array.isArray(raw.edges) ? raw.edges : []) as ({ source?: unknown; target?: unknown; type?: unknown; kind?: unknown } | null)[])
    .flatMap((e) => (e && typeof e.source === 'string' && typeof e.target === 'string' && !NON_EXEC_EDGES.has(String(e.type ?? e.kind ?? '')) ? [{ source: e.source, target: e.target }] : []));
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []) as ({ id?: unknown; type?: unknown; trigger?: unknown; data?: { trigger?: unknown } } | null)[];
  const triggers = nodes.filter((n) => n && (n.trigger === true || n.data?.trigger === true || n.type === 'triggerNode')).map((n) => String(n!.id));
  const roots = triggers.length ? triggers : nodes.map((n) => String(n?.id)).filter((id) => !edges.some((e) => e.target === id));
  return (earlier, later) => {
    // Walk from the trigger without passing through `earlier`; if `later` is still reachable, it can run without it.
    const seen = new Set<string>([earlier]);
    const stack = roots.filter((id) => !seen.has(id));
    while (stack.length) {
      const id = stack.pop()!;
      if (id === later) return false;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const target of next.get(id) ?? []) if (!seen.has(target)) stack.push(target);
    }
    return true;
  };
}

const firstString = (v: unknown): string => (typeof (Array.isArray(v) ? v[0] : v) === 'string' ? String(Array.isArray(v) ? v[0] : v).trim() : '');
const dynamic = (s: string) => collectRefs(s).length > 0;
const hasModel = (models: ModelInfo[], id: string) => models.some((m) => m.id === id || m.id === `${id}:latest` || `${m.id}:latest` === id);

function pickConnection(snap: WorkspaceSnapshot, purpose: 'chat' | 'embedding', ref?: string): ConnectionState | undefined {
  if (ref) {
    const key = ref.toLowerCase();
    const named = snap.connections.find((c) => c.id.toLowerCase() === key) ?? snap.connections.find((c) => c.name.toLowerCase() === key) ?? snap.connections.find((c) => c.kind === key);
    if (named) return named;
  }
  const preferred = snap.connections.find((c) => (purpose === 'chat' ? c.defaultChat : c.defaultEmbedding));
  return preferred
    ?? (purpose === 'embedding' ? snap.connections.find((c) => c.embeddingModel && c.kind !== 'builtin') : undefined)
    ?? snap.connections.find((c) => c.kind !== 'builtin')
    ?? snap.connections[0];
}

function loopbackNote(snap: WorkspaceSnapshot, conn: ConnectionState): string {
  return snap.hosted && conn.loopback
    ? ` This runtime is hosted, so ${conn.baseUrl} points at the runtime server itself, not at your computer. Run the model server next to the runtime or use an address the runtime can reach.`
    : '';
}

/**
 * Checks what a workflow needs (models, embeddings, knowledge, credentials) against the current workspace.
 * Every finding names the steps it affects and, when something is missing, where to fix it.
 */
export function analyzeRequirements(definition: unknown, snap: WorkspaceSnapshot, catalog: { type: string; label: string; integration?: string; fields: { key: string; type: string; integration?: string }[] }[]): Readiness {
  const nodes = nodesOf(definition);
  const specs = new Map(catalog.map((c) => [c.type, c]));
  const found = new Map<string, Requirement>();
  // Steps can report the same requirement differently (a writer: “will be created”, a reader: “missing”); the most severe wins.
  const add = (r: Requirement) => {
    const existing = found.get(r.id);
    const nodeIds = [...(existing?.nodeIds ?? []), ...r.nodeIds.filter((id) => !existing?.nodeIds.includes(id))];
    found.set(r.id, existing && ORDER[existing.status] <= ORDER[r.status] ? { ...existing, nodeIds } : { ...r, nodeIds });
  };
  const before = runsBefore(definition);
  const writers = new Map<string, string[]>();
  for (const node of nodes) {
    const name = firstString(node.values['vectorDB']);
    const stores = WRITES_COLLECTION.has(node.type) && (node.type !== 'vectorNode' || node.values['action'] === 'index');
    if (stores && name && !dynamic(name)) writers.set(name, [...(writers.get(name) ?? []), node.id]);
  }

  for (const node of nodes) {
    const spec = specs.get(node.type);
    if (!spec) continue;
    const v = node.values;

    /* ---- generation model ---- */
    const usesModel = NEEDS_CHAT_MODEL.has(node.type) || ((node.type === 'memoryNode' || node.type === 'agenticDocExtractionNode') && modelConfigs(v['generativeModelName']).length > 0);
    if (usesModel) {
      const ref = modelConfigs(v['generativeModelName'])[0];
      const conn = pickConnection(snap, 'chat', ref?.connection ?? ref?.provider);
      const wanted = ref?.model ?? conn?.chatModel ?? '';
      if (!conn || conn.kind === 'builtin') {
        add({ id: 'model:none', kind: 'model', status: 'missing', title: 'Connect an AI model', detail: 'This workflow generates text, but no model connection is set up yet. Connect Ollama, LM Studio or another OpenAI-compatible server.', nodeIds: [node.id], action: { label: 'Connect a model', href: '/setup?path=connect' } });
      } else if (conn.kind === 'mock') {
        add({ id: `model:${conn.id}`, kind: 'model', status: 'warning', title: 'Using demonstration responses', detail: `“${conn.name}” returns deterministic demo text. It runs the workflow end to end but performs no AI inference.`, nodeIds: [node.id], action: { label: 'Connect a real model', href: '/setup?path=connect' } });
      } else if (!conn.ok) {
        add({ id: `model:${conn.id}`, kind: 'model', status: 'missing', title: `${conn.name} is not reachable`, detail: `${conn.error ?? 'The model server did not answer.'}${loopbackNote(snap, conn)}`, nodeIds: [node.id], action: { label: 'Diagnose connection', href: `/models?diagnose=${encodeURIComponent(conn.id)}` } });
      } else if (!conn.models.some((m) => m.kind === 'chat')) {
        add({ id: `model:${conn.id}`, kind: 'model', status: 'missing', title: `${conn.name} has no chat model`, detail: conn.kind === 'ollama' ? 'Ollama is running but has no chat model yet. Run “ollama pull llama3.2”, then refresh.' : 'The server is running but lists no chat-capable model. Load one in your model server.', nodeIds: [node.id], action: { label: 'Open Models', href: '/models' } });
      } else if (wanted && wanted !== 'auto' && !hasModel(conn.models, wanted)) {
        add({ id: `model:${conn.id}:${wanted}`, kind: 'model', status: 'warning', title: `Model “${wanted}” not found on ${conn.name}`, detail: `Available: ${conn.models.filter((m) => m.kind === 'chat').map((m) => m.id).slice(0, 6).join(', ')}. Pick one of these or install the model.`, nodeIds: [node.id], action: { label: 'Open Models', href: '/models' } });
      } else {
        const model = wanted && wanted !== 'auto' ? wanted : conn.models.find((m) => m.kind === 'chat')!.id;
        add({ id: `model:${conn.id}`, kind: 'model', status: 'ready', title: `Model: ${conn.name}`, detail: `Generates with ${model}${conn.loopback ? ' on this machine' : ` at ${conn.baseUrl ?? conn.name}`}.`, nodeIds: [node.id] });
      }
    }

    /* ---- knowledge collections ---- */
    const collectionKey = node.type === 'memoryNode' || node.type === 'memoryRetrieveNode' ? 'memoryCollection' : 'vectorDB';
    const collectionName = firstString(v[collectionKey]);
    const collection = collectionName && !dynamic(collectionName) ? snap.collections.find((c) => c.name === collectionName) : undefined;
    if (READS_COLLECTION.has(node.type) || (node.type === 'vectorNode' && v['action'] !== 'index')) {
      if (!collectionName) {
        add({ id: `collection:unset:${node.id}`, kind: 'collection', status: 'missing', title: 'Choose a knowledge collection', detail: 'Select which documents this step should search.', nodeIds: [node.id], action: { label: 'Open Knowledge', href: '/context' } });
      } else if (!dynamic(collectionName) && !collection && writers.get(collectionName)?.some((w) => before(w, node.id))) {
        // A step that stores into the collection always runs first, so it exists by the time this one searches.
        add({ id: `collection:${collectionName}`, kind: 'collection', status: 'info', title: `“${collectionName}” will be created`, detail: 'An earlier step creates the collection the first time it stores passages, before this step searches it.', nodeIds: [node.id] });
      } else if (!dynamic(collectionName) && !collection) {
        add({ id: `collection:${collectionName}`, kind: 'collection', status: 'missing', title: `Create the “${collectionName}” collection`, detail: 'Create it, choose an embedding model and upload your documents. Searches fail until it exists.', nodeIds: [node.id], action: { label: 'Create collection', href: `/context?tab=knowledge&create=${encodeURIComponent(collectionName)}` } });
      } else if (collection && collection.records === 0) {
        add({ id: `collection:${collectionName}`, kind: 'collection', status: 'warning', title: `“${collectionName}” is empty`, detail: 'Upload documents so this step has something to search. Until then it finds nothing and answers without sources.', nodeIds: [node.id], action: { label: 'Upload documents', href: `/context/${encodeURIComponent(collectionName)}` } });
      } else if (collection) {
        add({ id: `collection:${collectionName}`, kind: 'collection', status: 'ready', title: `Knowledge: ${collectionName}`, detail: `${collection.documents} document(s), ${collection.records} searchable passage(s).`, nodeIds: [node.id] });
      }
    } else if (WRITES_COLLECTION.has(node.type) && collectionName && !dynamic(collectionName) && !collection) {
      add({ id: `collection:${collectionName}`, kind: 'collection', status: 'info', title: `“${collectionName}” will be created`, detail: 'The collection is created the first time this step stores passages.', nodeIds: [node.id] });
    } else if ((node.type === 'memoryNode' || node.type === 'memoryRetrieveNode') && collectionName && !collection) {
      add({ id: `memory:${collectionName}`, kind: 'collection', status: 'info', title: `Memory store “${collectionName}”`, detail: 'Created automatically the first time something is remembered.', nodeIds: [node.id] });
    }

    /* ---- embeddings ---- */
    if (NEEDS_EMBEDDINGS.has(node.type) && !(READS_COLLECTION.has(node.type) && !collection)) {
      const ref = modelConfigs(v['embeddingModelName'])[0];
      const conn = pickConnection(snap, 'embedding', ref?.connection ?? ref?.provider ?? collection?.embeddingConnection ?? undefined);
      const model = ref?.model ?? collection?.embeddingModel ?? conn?.embeddingModel ?? '';
      if (!conn) {
        add({ id: 'embedding:none', kind: 'embedding', status: 'missing', title: 'Choose an embedding model', detail: 'Searching documents by meaning needs an embedding model.', nodeIds: [node.id], action: { label: 'Open Models', href: '/models' } });
      } else if (conn.kind === 'builtin') {
        add({ id: 'embedding:builtin', kind: 'embedding', status: 'info', title: 'Built-in keyword embeddings', detail: 'Matches shared words, not meaning, and needs no model server. For semantic search, pull an embedding model such as nomic-embed-text and select it for the collection.', nodeIds: [node.id] });
      } else if (conn.kind === 'mock') {
        add({ id: `embedding:${conn.id}`, kind: 'embedding', status: 'warning', title: 'Demonstration embeddings', detail: `“${conn.name}” produces deterministic keyword vectors, not learned embeddings.`, nodeIds: [node.id] });
      } else if (!conn.ok) {
        add({ id: `embedding:${conn.id}`, kind: 'embedding', status: 'missing', title: `${conn.name} is not reachable for embeddings`, detail: `${conn.error ?? 'The model server did not answer.'}${loopbackNote(snap, conn)}`, nodeIds: [node.id], action: { label: 'Diagnose connection', href: `/models?diagnose=${encodeURIComponent(conn.id)}` } });
      } else if (!conn.models.some((m) => m.kind === 'embedding') && !(model && hasModel(conn.models, model))) {
        add({ id: `embedding:${conn.id}`, kind: 'embedding', status: 'missing', title: `${conn.name} has no embedding model`, detail: conn.kind === 'ollama' ? 'Run “ollama pull nomic-embed-text”, then set it as the embedding model.' : 'Load an embedding model on your server, or use the built-in keyword embeddings.', nodeIds: [node.id], action: { label: 'Open Models', href: '/models' } });
      } else {
        const chosen = model || conn.models.find((m) => m.kind === 'embedding')?.id || 'auto';
        add({ id: `embedding:${conn.id}`, kind: 'embedding', status: 'ready', title: `Embeddings: ${conn.name}`, detail: `Uses ${chosen}.`, nodeIds: [node.id] });
      }
    }

    /* ---- integration credentials ---- */
    for (const field of spec.fields) {
      if (field.type !== 'credential') continue;
      const integration = field.integration ?? spec.integration;
      if (!integration) continue;
      const raw = v[field.key];
      const ref = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? String((raw as Record<string, unknown>)['name'] ?? (raw as Record<string, unknown>)['credential_name'] ?? '') : '';
      const available = snap.credentials.filter((c) => c.integration === integration);
      const label = spec.label.replace(/ \(SMTP\)$/, '');
      if (ref && available.some((c) => c.name === ref || c.id === ref)) {
        add({ id: `credential:${integration}:${ref}`, kind: 'credential', status: 'ready', title: `${label} account`, detail: `Uses the saved “${ref}” credential.`, nodeIds: [node.id] });
      } else if (ref) {
        add({ id: `credential:${integration}:${ref}`, kind: 'credential', status: 'missing', title: `Add the “${ref}” ${label} credential`, detail: `No ${label} credential with that name is saved.`, nodeIds: [node.id], action: { label: 'Add credential', href: `/integrations?add=${encodeURIComponent(integration)}` } });
      } else if (available.length === 1) {
        add({ id: `credential:${integration}`, kind: 'credential', status: 'ready', title: `${label} account`, detail: `Uses your saved “${available[0]!.name}” credential.`, nodeIds: [node.id] });
      } else if (available.length > 1) {
        add({ id: `credential:${integration}`, kind: 'credential', status: 'warning', title: `Choose a ${label} credential`, detail: `${available.length} credentials exist; select one on the step.`, nodeIds: [node.id] });
      } else {
        add({ id: `credential:${integration}`, kind: 'credential', status: 'missing', title: `Connect ${label}`, detail: `Add your ${label} credentials. Jasmine encrypts them on your runtime and never sends them to the browser again.`, nodeIds: [node.id], action: { label: `Add ${label}`, href: `/integrations?add=${encodeURIComponent(integration)}` } });
      }
    }

    /* ---- runtime and exposure ---- */
    if (SCHEDULED_TRIGGERS.has(node.type)) {
      add({ id: 'runtime:schedule', kind: 'runtime', status: 'info', title: 'Runs on your persistent runtime', detail: 'Scheduled and folder triggers start only after you deploy, and only while the Jasmine runtime is online. Static Studio hosting cannot run them.', nodeIds: [node.id] });
    }
    if (node.type === 'localFolderNode') {
      const folder = typeof v['folderPath'] === 'string' ? v['folderPath'].trim() : '';
      add({ id: `folder:${node.id}`, kind: 'input', status: folder ? 'info' : 'missing', title: folder ? `Watches ${folder}` : 'Choose a folder', detail: 'The folder must exist on the machine running the Jasmine runtime.', nodeIds: [node.id] });
    }
    if (PUBLIC_WIDGET_TRIGGERS.has(node.type)) {
      const domains = Array.isArray(v['domains']) ? v['domains'].map(String) : [];
      add({ id: `exposure:${node.id}`, kind: 'exposure', status: 'info', title: 'Public widget after deployment', detail: domains.includes('*') || !domains.length ? 'Once deployed, anyone who can reach your runtime can use this widget. Limit allowed domains on the trigger before sharing it.' : `Once deployed, the widget can be embedded on: ${domains.join(', ')}.`, nodeIds: [node.id] });
    }
    if (node.type === 'webhookTriggerNode' && !v['webhookSecret']) {
      add({ id: `exposure:${node.id}`, kind: 'exposure', status: 'info', title: 'Unsigned webhook', detail: 'Once deployed, anyone who can reach the runtime can call this webhook. Add a shared secret under the trigger’s advanced settings for public use.', nodeIds: [node.id] });
    }
  }

  const requirements = [...found.values()].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const missing = requirements.filter((r) => r.status === 'missing').length;
  return { ready: missing === 0, missing, warnings: requirements.filter((r) => r.status === 'warning').length, requirements };
}

const ORDER: Record<RequirementStatus, number> = { missing: 0, warning: 1, ready: 2, info: 3 };

/** What a workflow needs, independent of the current workspace (template cards, plan summaries). */
export function prerequisitesOf(definition: unknown, catalog: { type: string; label: string; integration?: string; fields: { key: string; type: string; integration?: string }[] }[]): { modelFree: boolean; items: { kind: Requirement['kind']; label: string }[] } {
  const specs = new Map(catalog.map((c) => [c.type, c]));
  const items = new Map<string, { kind: Requirement['kind']; label: string }>();
  let model = false;
  for (const node of nodesOf(definition)) {
    const spec = specs.get(node.type);
    if (NEEDS_CHAT_MODEL.has(node.type) || ((node.type === 'memoryNode' || node.type === 'agenticDocExtractionNode') && modelConfigs(node.values['generativeModelName']).length > 0)) {
      model = true;
      items.set('model', { kind: 'model', label: node.type === 'multiModalLLMNode' ? 'A vision-capable model' : 'A chat model' });
    }
    if (NEEDS_EMBEDDINGS.has(node.type)) items.set('embedding', { kind: 'embedding', label: 'Embeddings (a model, or built-in keyword matching)' });
    const collection = firstString(node.values[node.type.startsWith('memory') ? 'memoryCollection' : 'vectorDB']);
    if (collection && !dynamic(collection) && (READS_COLLECTION.has(node.type) || WRITES_COLLECTION.has(node.type))) items.set(`collection:${collection}`, { kind: 'collection', label: `Knowledge collection “${collection}”` });
    for (const field of spec?.fields ?? []) {
      const integration = field.type === 'credential' ? field.integration ?? spec?.integration : undefined;
      if (integration) items.set(`credential:${integration}`, { kind: 'credential', label: `${spec!.label.replace(/ \(SMTP\)$/, '')} credentials` });
    }
    if (node.type === 'localFolderNode') items.set('folder', { kind: 'input', label: 'A folder on the runtime machine' });
    if (SCHEDULED_TRIGGERS.has(node.type)) items.set('runtime', { kind: 'runtime', label: 'An always-on runtime (runs after deploy)' });
  }
  return { modelFree: !model, items: [...items.values()] };
}

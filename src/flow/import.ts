import { NodeLogicSchema, StudioFlowSchema, type Diagnostic, type EdgeKind, type FlowDefinition, type FlowEdge, type FlowNode, type NodeLogic } from './schema.ts';
import { EngineError } from '../errors.ts';

const EDGE_KINDS: Record<string, EdgeKind> = {
  defaultEdge: 'default',
  responseEdge: 'response',
  conditionEdge: 'condition',
  agentClassifierEdge: 'condition',
  loopEdge: 'loop',
  agentLoopEdge: 'loop',
  branchEdge: 'branch',
};

/** UI placeholders that edges run straight through ("+" buttons). */
const PASS_THROUGH_TYPES = new Set(['addNode', 'plusNode']);
/** Canvas annotations; never executable. */
const ANNOTATION_TYPES = new Set(['stickyNoteNode', 'noteNode']);

/** Nodes whose outgoing condition edges select a branch, and how to read their options. */
const BRANCHING: Record<string, (values: Record<string, unknown>) => { label: string | undefined; value: string | undefined }[]> = {
  conditionNode: (v) => listOf(v['conditions']).map((c) => ({ label: str(c['label']), value: str(c['value']) })),
  agentClassifierNode: (v) => listOf(v['classifier']).map((c) => ({ label: str(c['label']), value: str(c['value']) ?? str(c['label']) })),
  agentNode: (v) => listOf(v['agents']).map((a) => ({ label: str(a['name']), value: str(a['name']) })),
};

const FILE_REF_RE = /^@(prompts|scripts|model-configs|constitutions|tools|triggers|memory)\/.+/;
const MODEL_FIELD_RE = /ModelName$/;

export interface ImportOptions {
  flowId: string;
  /** Resolves `@prompts/x.md`, `@scripts/x.ts`, `@model-configs/x.ts` references from an exported kit. */
  resolveFileRef?: (ref: string) => unknown;
}

export interface ImportResult {
  definition: FlowDefinition;
  diagnostics: Diagnostic[];
}

const listOf = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function resolveFileRefs(value: unknown, opts: ImportOptions): unknown {
  if (typeof value === 'string' && FILE_REF_RE.test(value) && opts.resolveFileRef) {
    const resolved = opts.resolveFileRef(value);
    return resolved === undefined ? value : resolved;
  }
  if (Array.isArray(value)) return value.map((v) => resolveFileRefs(v, opts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveFileRefs(v, opts)]));
  }
  return value;
}

function intOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** apiNode/response nodes keep `retries` / `retry_delay` (sometimes `retry_deplay`) as strings in values. */
function logicFromValues(values: Record<string, unknown>): NodeLogic | undefined {
  const retries = intOrUndefined(values['retries']);
  if (!retries || retries <= 0) return undefined;
  const delaySeconds = intOrUndefined(values['retry_delay'] ?? values['retry_deplay']) ?? 0;
  return {
    retry: { maxAttempts: Math.min(retries + 1, 10), delayMs: Math.min(delaySeconds * 1000, 30_000), backoff: 'fixed', jitter: false },
  };
}

export function isStudioExport(input: unknown): boolean {
  const nodes = (input as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) && nodes.some((n) => typeof (n as { data?: { nodeId?: unknown } })?.data?.nodeId === 'string');
}

interface RawEdge {
  id: string | undefined;
  source: string;
  target: string;
  kind: EdgeKind;
  branch: string | undefined;
  handle: string | undefined;
  label: string | undefined;
}

export function importStudioFlow(input: unknown, opts: ImportOptions): ImportResult {
  const flow = StudioFlowSchema.parse(input);
  const diagnostics: Diagnostic[] = [];
  const passThrough = new Set<string>();
  const dropped = new Set<string>();
  const nodes: FlowNode[] = [];

  for (const n of flow.nodes) {
    const type = n.data.nodeId;
    if (ANNOTATION_TYPES.has(type) || n.type === 'stickyNoteNode') {
      dropped.add(n.id);
      continue;
    }
    if (PASS_THROUGH_TYPES.has(type)) {
      passThrough.add(n.id);
      continue;
    }
    if (n.data['disabled'] === true) {
      passThrough.add(n.id);
      diagnostics.push({ severity: 'warning', code: 'IMPORT_NODE_DISABLED', message: `Node ${n.id} is disabled; edges pass straight through it`, nodeId: n.id });
      continue;
    }
    const values = resolveFileRefs(n.data.values, opts) as Record<string, unknown>;
    for (const [key, v] of Object.entries(values)) {
      if (!MODEL_FIELD_RE.test(key)) continue;
      const unset = (typeof v === 'string' && (v === '' || FILE_REF_RE.test(v))) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
      if (unset) {
        if (typeof v === 'string' && v !== '') {
          diagnostics.push({ severity: 'warning', code: 'IMPORT_MODEL_UNSET', message: `${key} on ${n.id} references ${v}, which was not provided; the default local model is used`, nodeId: n.id });
        }
        delete values[key];
      }
    }
    if (n.type === 'triggerNode' && n.data['schema'] && values['advance_schema'] === undefined) {
      values['advance_schema'] = typeof n.data['schema'] === 'string' ? n.data['schema'] : JSON.stringify(n.data['schema']);
    }
    const name = typeof values['nodeName'] === 'string' ? values['nodeName'] : undefined;
    const node: FlowNode = {
      id: n.id,
      type,
      trigger: n.data.trigger === true || n.type === 'triggerNode',
      values,
    };
    if (name !== undefined) node.name = name;
    let logic = logicFromValues(values);
    if (n.data.engineLogic !== undefined) {
      const policy = NodeLogicSchema.safeParse(n.data.engineLogic);
      if (!policy.success) throw new EngineError('COMPILE', `Invalid execution policy on ${n.id}`, { details: [{ severity: 'error', code: 'IMPORT_LOGIC_INVALID', message: policy.error.message, nodeId: n.id }] });
      logic = policy.data;
    } else if (n.data.logic && n.data.logic.length > 0) {
      diagnostics.push({ severity: 'warning', code: 'IMPORT_LOGIC_IGNORED', message: `Node logic steps on ${n.id} use an unpublished format and were not imported`, nodeId: n.id });
    }
    if (logic) node.logic = logic;
    nodes.push(node);
  }
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));

  /* ---- edges ---- */
  let edges: RawEdge[] = [];
  for (const e of flow.edges) {
    if (dropped.has(e.source) || dropped.has(e.target)) continue;
    let kind = EDGE_KINDS[e.type];
    if (!kind) {
      diagnostics.push({ severity: 'warning', code: 'IMPORT_EDGE_KIND', message: `Edge type "${e.type}" treated as defaultEdge`, nodeId: e.source });
      kind = 'default';
    }
    const data = (e['data'] && typeof e['data'] === 'object' ? e['data'] : {}) as Record<string, unknown>;
    edges.push({
      id: e.id ?? undefined, source: e.source, target: e.target, kind, branch: e.branch,
      handle: e.sourceHandle && !['bottom', 'top', 'to-response'].includes(e.sourceHandle) ? e.sourceHandle : undefined,
      label: str(data['condition']) ?? str(data['label']),
    });
  }

  // Splice out "+" placeholders and disabled nodes: every incoming edge continues to every outgoing target.
  // Processing each placeholder once suffices: chains collapse as earlier splices hand their edges on.
  for (const id of passThrough) {
    const incoming = edges.filter((e) => e.target === id && e.kind !== 'loop' && e.kind !== 'response');
    const outgoing = edges.filter((e) => e.source === id && e.kind !== 'loop' && e.kind !== 'response');
    edges = edges.filter((e) => e.source !== id && e.target !== id);
    for (const i of incoming) {
      for (const o of outgoing) {
        if (i.source === o.target) continue;
        edges.push({ ...i, target: o.target });
      }
    }
  }

  const out: FlowEdge[] = [];
  const branchingEdges = new Map<string, { raw: RawEdge; edge: FlowEdge }[]>();
  for (const e of edges) {
    const sourceType = typeOf.get(e.source);
    let kind = e.kind;
    // Loop and batch starts/ends also emit conditionEdges ("Loop Start"/"Loop End"); they are plain dependencies.
    if (kind === 'condition' && (!sourceType || !BRANCHING[sourceType])) kind = 'default';
    const edge: FlowEdge = { source: e.source, target: e.target, kind };
    out.push(edge);
    if (kind === 'condition') {
      const list = branchingEdges.get(e.source) ?? [];
      list.push({ raw: e, edge });
      branchingEdges.set(e.source, list);
    }
  }

  // Map each branch edge to one option: explicit branch, handle, label, edge id, legacy "<cond>-<target>", then position.
  for (const node of nodes) {
    const options = BRANCHING[node.type]?.(node.values);
    if (!options) continue;
    const outgoing = branchingEdges.get(node.id) ?? [];
    const values = options.map((o) => o.value);
    const used = new Set<string>();
    const unmatched: FlowEdge[] = [];
    for (const { raw, edge } of outgoing) {
      const byLabel = raw.label !== undefined ? options.find((o) => o.label === raw.label)?.value : undefined;
      const key = (raw.branch !== undefined && values.includes(raw.branch) ? raw.branch : undefined)
        ?? (raw.handle !== undefined && values.includes(raw.handle) ? raw.handle : undefined)
        ?? byLabel
        ?? (raw.id !== undefined && values.includes(raw.id) ? raw.id : undefined)
        ?? values.find((v) => v === `${node.id}-${edge.target}`);
      if (raw.branch !== undefined && !values.includes(raw.branch)) {
        edge.branch = raw.branch;
        continue;
      }
      if (key) {
        edge.branch = key;
        used.add(key);
      } else unmatched.push(edge);
    }
    const free = values.filter((v): v is string => v !== undefined && !used.has(v));
    unmatched.forEach((edge, i) => {
      const key = free[i];
      if (!key) return;
      edge.branch = key;
      diagnostics.push({
        severity: 'warning',
        code: 'IMPORT_BRANCH_BY_POSITION',
        message: `Branch edge ${node.id} -> ${edge.target} matched to "${options.find((o) => o.value === key)?.label ?? key}" by position (the edge names no option)`,
        nodeId: node.id,
      });
    });
  }

  const definition: FlowDefinition = { id: opts.flowId, nodes, edges: dedupe(out) };
  const name = flow.meta?.name;
  if (name) definition.name = name;
  return { definition, diagnostics };
}

function dedupe(edges: FlowEdge[]): FlowEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.branch ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function unresolvedFileRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' && FILE_REF_RE.test(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) unresolvedFileRefs(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) unresolvedFileRefs(v, out);
  return out;
}

/**
 * Reads a flow file as data: Studio JSON (`{nodes, edges}`) or an AgentKit `flows/*.ts` module
 * (`export const nodes = [...]`). TypeScript files are parsed as text and never executed.
 */
export function parseFlowFile(text: string): { meta?: { name?: string; description?: string }; nodes: unknown[]; edges: unknown[] } {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { nodes?: unknown; edges?: unknown; meta?: { name?: string } };
    if (!Array.isArray(parsed.nodes)) throw new EngineError('BAD_PAYLOAD', 'Flow JSON has no nodes array');
    return { ...(parsed.meta ? { meta: parsed.meta } : {}), nodes: parsed.nodes, edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
  }
  const nodes = extractJsonArray(trimmed, 'nodes');
  if (!nodes) throw new EngineError('BAD_PAYLOAD', 'Could not find `export const nodes = [...]` in the flow file');
  const edges = extractJsonArray(trimmed, 'edges') ?? [];
  const name = /export\s+const\s+meta\s*=\s*\{[\s\S]*?["']?name["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(trimmed)?.[1];
  const description = /export\s+const\s+meta\s*=\s*\{[\s\S]*?["']?description["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(trimmed)?.[1];
  return { meta: { ...(name ? { name } : {}), ...(description ? { description } : {}) }, nodes, edges };
}

export function extractJsonArray(text: string, name: string): unknown[] | undefined {
  const at = text.search(new RegExp(`export\\s+const\\s+${name}\\s*(:[^=]+)?=\\s*\\[`));
  if (at < 0) return undefined;
  const start = text.indexOf('[', at);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as unknown[];
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

import { NodeLogicSchema, StudioFlowSchema, type Diagnostic, type EdgeKind, type FlowDefinition, type FlowEdge, type FlowNode, type NodeLogic } from './schema.ts';
import { EngineError } from '../errors.ts';

const EDGE_KINDS: Record<string, EdgeKind> = {
  defaultEdge: 'default',
  responseEdge: 'response',
  conditionEdge: 'condition',
  loopEdge: 'loop',
  branchEdge: 'branch',
};

/** UI-only placeholders that never execute. */
const PLACEHOLDER_TYPES = new Set(['addNode', 'plusNode']);

const FILE_REF_RE = /^@(prompts|scripts|model-configs|constitutions)\/.+/;

export interface ImportOptions {
  flowId: string;
  /** Resolves `@prompts/x.md`, `@scripts/x.ts`, `@model-configs/x.ts` references from an exported kit. */
  resolveFileRef?: (ref: string) => unknown;
}

export interface ImportResult {
  definition: FlowDefinition;
  diagnostics: Diagnostic[];
}

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

/** apiNode/response nodes keep `retries` / `retry_delay` as strings in values. */
function logicFromValues(values: Record<string, unknown>): NodeLogic | undefined {
  const retries = intOrUndefined(values['retries']);
  if (!retries || retries <= 0) return undefined;
  const delaySeconds = intOrUndefined(values['retry_delay']) ?? 0;
  return {
    retry: { maxAttempts: Math.min(retries + 1, 10), delayMs: Math.min(delaySeconds * 1000, 30_000), backoff: 'fixed', jitter: false },
  };
}

export function isStudioExport(input: unknown): boolean {
  const nodes = (input as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) && nodes.some((n) => typeof (n as { data?: { nodeId?: unknown } })?.data?.nodeId === 'string');
}

export function importStudioFlow(input: unknown, opts: ImportOptions): ImportResult {
  const flow = StudioFlowSchema.parse(input);
  const diagnostics: Diagnostic[] = [];
  const dropped = new Set<string>();
  const nodes: FlowNode[] = [];

  for (const n of flow.nodes) {
    const type = n.data.nodeId;
    if (PLACEHOLDER_TYPES.has(type)) {
      dropped.add(n.id);
      continue;
    }
    const values = resolveFileRefs(n.data.values, opts) as Record<string, unknown>;
    if (n.data.logic && n.data.logic.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'IMPORT_LOGIC_IGNORED',
        message: `Node logic steps on ${n.id} use an undocumented format and were not imported`,
        nodeId: n.id,
      });
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
    }
    if (logic) node.logic = logic;
    nodes.push(node);
  }

  const edges: FlowEdge[] = [];
  const conditionEdges = new Map<string, FlowEdge[]>();
  const branchOverrides = new Map<FlowEdge, string>();
  for (const e of flow.edges) {
    if (dropped.has(e.source) || dropped.has(e.target)) continue;
    const kind = EDGE_KINDS[e.type];
    if (!kind) {
      diagnostics.push({ severity: 'warning', code: 'IMPORT_EDGE_KIND', message: `Edge type "${e.type}" treated as defaultEdge`, nodeId: e.source });
    }
    const edge: FlowEdge = { source: e.source, target: e.target, kind: kind ?? 'default' };
    edges.push(edge);
    if (edge.kind === 'condition') {
      if (e.branch !== undefined) { edge.branch = e.branch; branchOverrides.set(edge, e.branch); }
      else if (e.sourceHandle && e.sourceHandle !== 'bottom' && e.sourceHandle !== 'top') branchOverrides.set(edge, e.sourceHandle);
      const list = conditionEdges.get(e.source) ?? [];
      list.push(edge);
      conditionEdges.set(e.source, list);
    }
  }

  // A condition's `value` is "<conditionNodeId>-<targetNodeId>". When the target was a placeholder that
  // was later replaced, the suffix goes stale; fall back to positional matching and say so.
  for (const node of nodes) {
    if (node.type !== 'conditionNode') continue;
    const outgoing = conditionEdges.get(node.id) ?? [];
    const conditions = Array.isArray(node.values['conditions']) ? (node.values['conditions'] as { value?: unknown }[]) : [];
    const keys = conditions.map((c) => (typeof c.value === 'string' ? c.value : undefined));
    const unmatchedEdges: FlowEdge[] = [];
    const used = new Set<string>();
    for (const edge of outgoing) {
      if (edge.branch !== undefined && !keys.includes(edge.branch)) continue;
      const explicit = branchOverrides.get(edge);
      const key = explicit && keys.includes(explicit) ? explicit : keys.find((k) => k === `${node.id}-${edge.target}`);
      if (key) {
        edge.branch = key;
        used.add(key);
      } else unmatchedEdges.push(edge);
    }
    const freeKeys = keys.filter((k): k is string => k !== undefined && !used.has(k));
    unmatchedEdges.forEach((edge, i) => {
      const key = freeKeys[i];
      if (key) {
        edge.branch = key;
        diagnostics.push({
          severity: 'warning',
          code: 'IMPORT_BRANCH_BY_POSITION',
          message: `Condition edge ${node.id} -> ${edge.target} matched to "${key}" by position (condition value names another target)`,
          nodeId: node.id,
        });
      }
    });
  }

  const definition: FlowDefinition = { id: opts.flowId, nodes, edges };
  const name = flow.meta?.name;
  if (name) definition.name = name;
  return { definition, diagnostics };
}

export function unresolvedFileRefs(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' && FILE_REF_RE.test(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) unresolvedFileRefs(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) unresolvedFileRefs(v, out);
  return out;
}

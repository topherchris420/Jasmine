import { versionOf } from '../canonical.ts';
import type { NodeHandler, NodeKind, NodeRegistry } from '../nodes/types.ts';
import { unresolvedFileRefs } from './import.ts';
import { FlowDefinitionSchema, type Diagnostic, type FlowDefinition, type FlowEdge, type FlowNode } from './schema.ts';
import { collectRefs, RESERVED_ROOTS } from './template.ts';

export interface InEdge {
  source: string;
  branch: string | undefined;
}

/** One schedulable scope: the whole flow (root = trigger) or one loop body (root = loop start). */
export interface ScopePlan {
  rootId: string;
  /** Topological order, excluding the root and the bodies of nested loops. */
  members: string[];
  preds: Map<string, InEdge[]>;
  succs: Map<string, string[]>;
  loops: Map<string, LoopPlan>;
}

export interface LoopPlan {
  startId: string;
  endId: string;
  /** `agent` loops re-run the body until the supervisor finishes; `loop` iterates a list. */
  type: 'loop' | 'agent';
  body: ScopePlan;
  /** Body nodes feeding the loop end; their outputs form one `loopOutput` entry per iteration. */
  sinks: string[];
}

export interface CompiledNode {
  node: FlowNode;
  handler: NodeHandler;
  kind: NodeKind;
  sideEffect: boolean;
  idempotent: boolean;
}

export interface ExecutionPlan {
  flowId: string;
  version: string;
  definition: FlowDefinition;
  triggerId: string;
  responseIds: string[];
  responseType: 'realtime' | 'async';
  nodes: Map<string, CompiledNode>;
  root: ScopePlan;
  diagnostics: Diagnostic[];
}

export type CompileResult =
  | { ok: true; plan: ExecutionPlan; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

const EXEC_KINDS = new Set<FlowEdge['kind']>(['default', 'condition', 'branch']);

export interface CompileOptions {
  /** Warn above 20 nodes for realtime flows or 50 for async flows. */
  maxRecommendedNodes?: number;
}

export function compileFlow(input: unknown, registry: NodeRegistry, opts: CompileOptions = {}): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, nodeId?: string) =>
    diagnostics.push(nodeId ? { severity: 'error', code, message, nodeId } : { severity: 'error', code, message });
  const warn = (code: string, message: string, nodeId?: string) =>
    diagnostics.push(nodeId ? { severity: 'warning', code, message, nodeId } : { severity: 'warning', code, message });
  const failed = () => diagnostics.some((d) => d.severity === 'error');

  const parsed = FlowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) error('SCHEMA_INVALID', `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return { ok: false, diagnostics };
  }
  const def = parsed.data;

  /* ---- nodes ---- */
  const byId = new Map<string, FlowNode>();
  const index = new Map<string, number>();
  const compiled = new Map<string, CompiledNode>();
  def.nodes.forEach((node, i) => {
    if (byId.has(node.id)) {
      error('DUPLICATE_NODE_ID', `Node id "${node.id}" is used more than once`, node.id);
      return;
    }
    byId.set(node.id, node);
    index.set(node.id, i);
    const handler = registry.get(node.type);
    if (!handler) {
      error('UNSUPPORTED_NODE_TYPE', `No runtime handler for node type "${node.type}"`, node.id);
      return;
    }
    for (const d of handler.validate?.(node) ?? []) diagnostics.push(d.nodeId ? d : { ...d, nodeId: node.id });
    for (const ref of unresolvedFileRefs(node.values)) {
      error('FILE_REF_UNRESOLVED', `File reference ${ref} was not resolved at import`, node.id);
    }
    compiled.set(node.id, {
      node,
      handler,
      kind: node.trigger && handler.kind === 'action' ? 'trigger' : handler.kind,
      sideEffect: handler.sideEffect?.(node) ?? false,
      idempotent: handler.idempotent?.(node) ?? !(handler.sideEffect?.(node) ?? false),
    });
  });

  /* ---- edges ---- */
  const preds = new Map<string, FlowEdge[]>();
  const succs = new Map<string, FlowEdge[]>();
  for (const id of byId.keys()) {
    preds.set(id, []);
    succs.set(id, []);
  }
  const seen = new Set<string>();
  for (const edge of def.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      error('EDGE_UNKNOWN_NODE', `Edge ${edge.source} -> ${edge.target} references a missing node`);
      continue;
    }
    if (!EXEC_KINDS.has(edge.kind)) continue;
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.branch ?? ''}`;
    if (seen.has(key)) {
      warn('DUPLICATE_EDGE', `Duplicate edge ${edge.source} -> ${edge.target} ignored`, edge.source);
      continue;
    }
    seen.add(key);
    const src = compiled.get(edge.source);
    if (edge.kind === 'condition') {
      if (src && !src.handler.branchKeys) error('BRANCH_ON_NON_CONDITION', `Condition edge leaves non-branching node ${edge.source}`, edge.source);
      else if (src && edge.branch === undefined) error('BRANCH_UNMAPPED', `Condition edge ${edge.source} -> ${edge.target} is not tied to any condition`, edge.source);
      else if (src && edge.branch !== undefined && !(src.handler.branchKeys?.(src.node) ?? []).includes(edge.branch)) {
        error('BRANCH_UNKNOWN', `Condition edge ${edge.source} -> ${edge.target} names unknown condition "${edge.branch}"`, edge.source);
      }
    }
    preds.get(edge.target)!.push(edge);
    succs.get(edge.source)!.push(edge);
  }

  /* ---- trigger / response ---- */
  const triggers = [...compiled.values()].filter((c) => c.kind === 'trigger');
  if (triggers.length === 0) error('NO_TRIGGER', 'Flow has no trigger node');
  if (triggers.length > 1) error('MULTIPLE_TRIGGERS', `Flow has ${triggers.length} trigger nodes: ${triggers.map((t) => t.node.id).join(', ')}`);
  const trigger = triggers[0];
  if (trigger && preds.get(trigger.node.id)!.length > 0) error('TRIGGER_HAS_INCOMING', 'Trigger node cannot have incoming edges', trigger.node.id);
  const responses = [...compiled.values()].filter((c) => c.kind === 'response');
  // Background flows (schedules, folder syncs, indexing jobs) need no response; their runs return an empty result.
  if (responses.length === 0) warn('NO_RESPONSE', 'Flow has no response node; runs succeed with an empty result');

  /* ---- cycles ---- */
  const cycle = findCycle([...byId.keys()], succs);
  if (cycle) error('CYCLE', `Cycle detected: ${cycle.join(' -> ')} (only loopEdge may close a loop)`, cycle[0]);

  if (failed() || !trigger) return { ok: false, diagnostics };
  const triggerId = trigger.node.id;

  /* ---- reachability + order ---- */
  const reachable = new Set<string>([triggerId]);
  const stack = [triggerId];
  while (stack.length) {
    for (const e of succs.get(stack.pop()!)!) {
      if (!reachable.has(e.target)) {
        reachable.add(e.target);
        stack.push(e.target);
      }
    }
  }
  for (const id of byId.keys()) if (!reachable.has(id)) warn('UNREACHABLE_NODE', `Node ${id} is not reachable from the trigger and will never run`, id);
  const reachableResponses = responses.filter((r) => reachable.has(r.node.id));
  if (responses.length > 0 && reachableResponses.length === 0) error('NO_RESPONSE', 'No response node is reachable from the trigger');

  const order = topoOrder([...reachable], preds, succs, index);
  const execPreds = (id: string) => preds.get(id)!.filter((e) => reachable.has(e.source));

  const ancestors = new Map<string, Set<string>>();
  const dominators = new Map<string, Set<string>>();
  const skippable = new Map<string, boolean>();
  for (const id of order) {
    const ps = execPreds(id);
    const anc = new Set<string>();
    let dom: Set<string> | undefined;
    for (const e of ps) {
      anc.add(e.source);
      for (const a of ancestors.get(e.source)!) anc.add(a);
      const pd = dominators.get(e.source)!;
      dom = dom ? new Set([...dom].filter((x) => pd.has(x))) : new Set(pd);
    }
    dom = dom ?? new Set();
    dom.add(id);
    ancestors.set(id, anc);
    dominators.set(id, dom);
    skippable.set(id, ps.length > 0 && ps.every((e) => e.kind === 'condition' || skippable.get(e.source)));
  }

  /* ---- loops ---- */
  interface LoopInfo { startId: string; endId: string; type: 'loop' | 'agent'; body: Set<string>; sinks: string[] }
  const loops: LoopInfo[] = [];
  for (const id of order) {
    const c = compiled.get(id)!;
    if (c.kind !== 'loopStart' && c.kind !== 'agentStart') continue;
    const endKind = c.kind === 'loopStart' ? 'loopEnd' : 'agentEnd';
    const endId = c.node.values['connectedTo'];
    const end = typeof endId === 'string' ? compiled.get(endId) : undefined;
    if (!end || end.kind !== endKind || end.node.values['connectedTo'] !== id || typeof endId !== 'string') {
      error('LOOP_UNPAIRED', `Loop start ${id} is not paired with a loop end that points back to it`, id);
      continue;
    }
    if (!ancestors.get(endId)?.has(id)) {
      error('LOOP_DISCONNECTED', `Loop end ${endId} is not downstream of loop start ${id}`, id);
      continue;
    }
    const body = new Set([...ancestors.get(endId)!].filter((x) => x !== id && ancestors.get(x)!.has(id)));
    for (const x of body) {
      for (const e of succs.get(x)!) if (!body.has(e.target) && e.target !== endId) error('LOOP_BODY_ESCAPES', `Loop body node ${x} has an edge leaving the loop to ${e.target}`, x);
      for (const e of execPreds(x)) if (!body.has(e.source) && e.source !== id) error('LOOP_BODY_ENTERED', `Loop body node ${x} has an edge entering from outside the loop (${e.source})`, x);
    }
    for (const e of execPreds(endId)) if (!body.has(e.source) && e.source !== id) error('LOOP_BODY_ENTERED', `Loop end ${endId} has an edge from outside the loop (${e.source})`, endId);
    loops.push({ startId: id, endId, type: c.kind === 'agentStart' ? 'agent' : 'loop', body, sinks: execPreds(endId).map((e) => e.source).filter((s) => body.has(s)) });
  }
  const contains = (outer: LoopInfo, inner: LoopInfo) =>
    outer.body.has(inner.startId) && outer.body.has(inner.endId) && [...inner.body].every((x) => outer.body.has(x));
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const a = loops[i]!;
      const b = loops[j]!;
      const touches = [...a.body].some((x) => b.body.has(x)) || a.body.has(b.startId) || b.body.has(a.startId);
      if (touches && !contains(a, b) && !contains(b, a)) error('LOOP_OVERLAP', `Loops ${a.startId} and ${b.startId} partially overlap`, a.startId);
    }
  }
  const innermostLoop = (id: string): LoopInfo | undefined =>
    loops.filter((l) => l.body.has(id)).sort((x, y) => x.body.size - y.body.size)[0];

  /* ---- references ---- */
  for (const id of order) {
    const node = byId.get(id)!;
    const reported = new Set<string>();
    for (const ref of collectRefs(node.values)) {
      if (reported.has(ref.nodeId) || RESERVED_ROOTS.has(ref.nodeId)) continue;
      // Bare names that are not nodes (`{{language}}` in imported prompts) stay as literal text at run time.
      if (ref.path.length === 0 && !byId.has(ref.nodeId)) continue;
      reported.add(ref.nodeId);
      const target = ref.nodeId;
      if (!byId.has(target)) error('UNKNOWN_REFERENCE', `{{${ref.raw}}} references node "${target}" which does not exist`, id);
      else if (target === id) error('SELF_REFERENCE', `{{${ref.raw}}} references the node itself`, id);
      else if (!reachable.has(target)) error('REFERENCE_UNREACHABLE', `{{${ref.raw}}} references ${target}, which never runs`, id);
      else if (!ancestors.get(id)!.has(target)) error('REFERENCE_NOT_UPSTREAM', `{{${ref.raw}}} references ${target}, which is not upstream of ${id}; its value would depend on timing`, id);
      else {
        const loop = innermostLoop(target);
        if (loop && !loop.body.has(id)) error('REFERENCE_INTO_LOOP', `{{${ref.raw}}} reads a per-iteration value from outside loop ${loop.startId}; use ${loop.endId}.output.loopOutput`, id);
        else if (skippable.get(target) && !dominators.get(id)!.has(target)) {
          warn('CONDITIONAL_REFERENCE', `{{${ref.raw}}} references ${target}, which may be skipped by a branch while ${id} still runs`, id);
        }
      }
    }
  }

  const max = opts.maxRecommendedNodes ?? 50;
  if (reachable.size > max) warn('FLOW_TOO_LARGE', `Flow has ${reachable.size} nodes; recommended maximum is at most ~${max}`);
  if (failed()) return { ok: false, diagnostics };

  /* ---- scope plans ---- */
  const buildScope = (rootId: string, memberSet: Set<string>): ScopePlan => {
    const direct = loops.filter(
      (l) => memberSet.has(l.startId) && !loops.some((o) => o !== l && memberSet.has(o.startId) && o.body.has(l.startId)),
    );
    const hidden = new Set<string>();
    for (const l of direct) for (const x of l.body) hidden.add(x);
    const members = order.filter((id) => id !== rootId && memberSet.has(id) && !hidden.has(id));
    const visible = new Set([rootId, ...members]);
    const scopePreds = new Map<string, InEdge[]>();
    const scopeSuccs = new Map<string, string[]>([[rootId, []]]);
    for (const id of members) scopeSuccs.set(id, []);
    for (const id of members) {
      const list: InEdge[] = [];
      const add = (source: string, branch: string | undefined) => {
        if (!list.some((e) => e.source === source && e.branch === branch)) list.push({ source, branch });
      };
      for (const e of execPreds(id)) {
        if (visible.has(e.source)) add(e.source, e.branch);
        else {
          const owner = direct.find((l) => l.body.has(e.source) && l.endId === id);
          if (owner) add(owner.startId, undefined);
        }
      }
      const ownLoop = direct.find((l) => l.endId === id);
      if (ownLoop) add(ownLoop.startId, undefined);
      scopePreds.set(id, list);
      for (const e of list) {
        const s = scopeSuccs.get(e.source)!;
        if (!s.includes(id)) s.push(id);
      }
    }
    const loopPlans = new Map<string, LoopPlan>();
    for (const l of direct) {
      loopPlans.set(l.startId, { startId: l.startId, endId: l.endId, type: l.type, body: buildScope(l.startId, l.body), sinks: l.sinks });
    }
    return { rootId, members, preds: scopePreds, succs: scopeSuccs, loops: loopPlans };
  };

  const plan: ExecutionPlan = {
    flowId: def.id,
    version: versionOf(def),
    definition: def,
    triggerId,
    responseIds: reachableResponses.map((r) => r.node.id),
    responseType: (trigger.node.values['responeType'] ?? trigger.node.values['responseType']) === 'async' ? 'async' : 'realtime',
    nodes: new Map([...compiled].filter(([id]) => reachable.has(id))),
    root: buildScope(triggerId, reachable),
    diagnostics,
  };
  return { ok: true, plan, diagnostics };
}

function findCycle(ids: string[], succs: Map<string, FlowEdge[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    path.push(id);
    for (const e of succs.get(id)!) {
      const s = state.get(e.target);
      if (s === 1) return [...path.slice(path.indexOf(e.target)), e.target];
      if (s === undefined) {
        const found = visit(e.target);
        if (found) return found;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Kahn's algorithm with ties broken by definition order, so plans are reproducible. */
function topoOrder(ids: string[], preds: Map<string, FlowEdge[]>, succs: Map<string, FlowEdge[]>, index: Map<string, number>): string[] {
  const set = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, preds.get(id)!.filter((e) => set.has(e.source)).length]));
  const ready = ids.filter((id) => indeg.get(id) === 0).sort((a, b) => index.get(a)! - index.get(b)!);
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const e of succs.get(id)!) {
      if (!set.has(e.target)) continue;
      const d = indeg.get(e.target)! - 1;
      indeg.set(e.target, d);
      if (d === 0) {
        const at = ready.findIndex((r) => index.get(r)! > index.get(e.target)!);
        ready.splice(at < 0 ? ready.length : at, 0, e.target);
      }
    }
  }
  return out;
}

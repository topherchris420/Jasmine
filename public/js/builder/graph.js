/* Operations on a flow definition in Studio export shape: { meta, notes, viewport, nodes: [{ id, type, position, data: { nodeId, trigger, values } }], edges }. */

export const NODE_W = 260;
const PAIRS = { forLoopNode: 'forLoopEndNode', batchNode: 'batchEndNode', agentNode: 'agentLoopEndNode' };
const PAIR_ENDS = Object.fromEntries(Object.entries(PAIRS).map(([a, b]) => [b, a]));
const KIND_TO_EDGE = { default: 'defaultEdge', condition: 'conditionEdge', loop: 'loopEdge', response: 'responseEdge', branch: 'branchEdge' };

/** Accepts Studio exports and engine definitions ({ nodes: [{ id, type, values }], edges: [{ kind }] }). */
export function normalize(definition, catalog) {
  const def = structuredClone(definition ?? {});
  def.nodes = Array.isArray(def.nodes) ? def.nodes : [];
  def.edges = Array.isArray(def.edges) ? def.edges : [];
  def.nodes = def.nodes.map((n, i) => {
    if (n.data) return { ...n, position: n.position ?? { x: 0, y: i * 150 } };
    const spec = catalog.byType.get(n.type);
    return {
      id: n.id, type: spec?.rfType ?? (n.trigger ? 'triggerNode' : 'dynamicNode'), position: { x: 0, y: i * 150 },
      data: { nodeId: n.type, ...(n.trigger ? { trigger: true } : {}), values: { ...(n.name ? { nodeName: n.name } : {}), ...(n.values ?? {}) }, ...(n.logic ? { engineLogic: n.logic } : {}) },
    };
  });
  def.edges = def.edges.map((e, i) => {
    const out = { ...e, id: e.id ?? `edge_${i}_${e.source}_${e.target}` };
    if (!out.type) out.type = KIND_TO_EDGE[e.kind] ?? 'defaultEdge';
    delete out.kind;
    return out;
  });
  def.notes = Array.isArray(def.notes) ? def.notes : [];
  if (!def.nodes.some((n) => n.position && (n.position.x || n.position.y)) && def.nodes.length > 1) autoLayout(def);
  return def;
}

export const typeOf = (node) => node?.data?.nodeId;
export const isTrigger = (node, catalog) => node?.data?.trigger === true || node?.type === 'triggerNode' || catalog?.byType.get(typeOf(node))?.kind === 'trigger';

export function newId(def, type) {
  const taken = new Set(def.nodes.map((n) => n.id));
  for (;;) {
    const id = `${type}_${Math.floor(100 + Math.random() * 900)}`;
    if (!taken.has(id)) return id;
  }
}

export function nodeName(node, catalog) {
  return node.data.values?.nodeName || catalog.byType.get(typeOf(node))?.label || typeOf(node);
}

/** Options a branching node routes on: condition branches, classifier categories, or supervisor sub-agents. */
export function branchOptions(node) {
  const v = node?.data?.values ?? {};
  switch (typeOf(node)) {
    case 'conditionNode': return (Array.isArray(v.conditions) ? v.conditions : []).map((c) => ({ label: c.label || c.value, value: c.value }));
    case 'agentClassifierNode': return (Array.isArray(v.classifier) ? v.classifier : []).map((c) => ({ label: c.label, value: c.value || c.label }));
    case 'agentNode': return (Array.isArray(v.agents) ? v.agents : []).map((a) => ({ label: a.name, value: a.name }));
    default: return [];
  }
}

export const isBranching = (node) => ['conditionNode', 'agentClassifierNode', 'agentNode'].includes(typeOf(node));

/** The option an edge belongs to (explicit branch, handle, label or edge id). */
export function edgeOption(edge, node) {
  const options = branchOptions(node);
  return options.find((o) => o.value === edge.branch) ?? options.find((o) => o.value === edge.sourceHandle)
    ?? options.find((o) => o.label === edge.data?.condition) ?? options.find((o) => o.value === edge.id);
}

export function addNode(def, catalog, type, position, { after, branch } = {}) {
  const spec = catalog.byType.get(type);
  const id = newId(def, type);
  const node = {
    id, type: spec?.rfType ?? (spec?.kind === 'trigger' ? 'triggerNode' : 'dynamicNode'), position: { ...position },
    data: { nodeId: type, ...(spec?.kind === 'trigger' ? { trigger: true } : {}), values: structuredClone(spec?.defaults ?? {}) },
  };
  if (type === 'conditionNode') {
    node.data.values.conditions = (node.data.values.conditions ?? []).map((c, i) => ({ ...c, value: `${id}-${i === 0 ? 'condition-1' : 'else'}` }));
  }
  def.nodes.push(node);
  const added = [node];
  const endType = PAIRS[type];
  if (endType) {
    const endSpec = catalog.byType.get(endType);
    const endId = newId(def, endType);
    const end = { id: endId, type: endSpec?.rfType ?? endType, position: { x: position.x, y: position.y + 300 }, data: { nodeId: endType, values: { ...(endSpec?.defaults ?? {}), connectedTo: id } } };
    node.data.values.connectedTo = endId;
    def.nodes.push(end);
    def.edges.push({ id: `loop-${id}-${endId}`, source: id, target: endId, type: type === 'agentNode' ? 'agentLoopEdge' : 'loopEdge', sourceHandle: 'bottom', targetHandle: 'top' });
    def.edges.push({ id: `loop-${endId}-${id}`, source: endId, target: id, type: type === 'agentNode' ? 'agentLoopEdge' : 'loopEdge', sourceHandle: 'bottom', targetHandle: 'top', data: { invisible: true } });
    added.push(end);
  }
  if (after) connect(def, catalog, after, id, branch);
  return added;
}

export function connect(def, catalog, sourceId, targetId, branchValue) {
  if (sourceId === targetId) return null;
  const source = def.nodes.find((n) => n.id === sourceId);
  const target = def.nodes.find((n) => n.id === targetId);
  if (!source || !target) return null;
  if (isTrigger(target, catalog)) return null;
  const exists = def.edges.find((e) => e.source === sourceId && e.target === targetId && !['loopEdge', 'agentLoopEdge', 'responseEdge'].includes(e.type) && (e.branch ?? null) === (branchValue ?? null));
  if (exists) return exists;
  const edge = { id: `edge-${sourceId}-${targetId}${branchValue ? `-${branchValue}` : ''}`.slice(0, 200), source: sourceId, target: targetId, type: 'defaultEdge', sourceHandle: 'bottom', targetHandle: 'top' };
  if (branchValue && isBranching(source)) {
    const option = branchOptions(source).find((o) => o.value === branchValue);
    edge.type = typeOf(source) === 'agentClassifierNode' ? 'agentClassifierEdge' : 'conditionEdge';
    edge.sourceHandle = branchValue;
    edge.branch = branchValue;
    edge.data = { condition: option?.label ?? branchValue };
  } else if (typeOf(source) === 'branchNode') {
    edge.type = 'branchEdge';
  }
  def.edges.push(edge);
  return edge;
}

export function removeEdge(def, edgeId) {
  def.edges = def.edges.filter((e) => e.id !== edgeId);
}

export function removeNode(def, nodeId) {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const pair = PAIRS[typeOf(node)] || PAIR_ENDS[typeOf(node)] ? node.data.values?.connectedTo : undefined;
  const ids = new Set([nodeId, ...(pair ? [pair] : [])]);
  def.nodes = def.nodes.filter((n) => !ids.has(n.id));
  def.edges = def.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
}

export function duplicateNode(def, nodeId) {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node || PAIRS[typeOf(node)] || PAIR_ENDS[typeOf(node)]) return null;
  const copy = structuredClone(node);
  copy.id = newId(def, typeOf(node));
  copy.position = { x: node.position.x + 40, y: node.position.y + 40 };
  if (copy.data.values?.nodeName) copy.data.values.nodeName = `${copy.data.values.nodeName} copy`;
  delete copy.data.trigger;
  def.nodes.push(copy);
  return copy;
}

const EXEC = new Set(['defaultEdge', 'conditionEdge', 'agentClassifierEdge', 'branchEdge']);

/** Every node that runs before `nodeId` (what its templates may reference). */
export function upstream(def, nodeId) {
  const preds = new Map();
  for (const e of def.edges) {
    if (!EXEC.has(e.type)) continue;
    if (!preds.has(e.target)) preds.set(e.target, []);
    preds.get(e.target).push(e.source);
  }
  // Nodes inside a loop also see the loop start, which reaches them through the loop edge pair.
  const seen = new Set();
  const stack = [...(preds.get(nodeId) ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(preds.get(id) ?? []));
  }
  seen.delete(nodeId);
  return def.nodes.filter((n) => seen.has(n.id));
}

/** Layered top-to-bottom layout: depth = longest path from the trigger; siblings spread horizontally. */
export function autoLayout(def) {
  const succ = new Map(def.nodes.map((n) => [n.id, []]));
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  for (const e of def.edges) {
    if (!EXEC.has(e.type) || !succ.has(e.source) || !succ.has(e.target)) continue;
    succ.get(e.source).push(e.target);
    indeg.set(e.target, indeg.get(e.target) + 1);
  }
  // Loop ends sit after their bodies: give them an edge from the loop start for ordering.
  for (const n of def.nodes) {
    const pair = PAIRS[typeOf(n)];
    if (pair && succ.has(n.data.values?.connectedTo) && !succ.get(n.id).includes(n.data.values.connectedTo)) {
      succ.get(n.id).push(n.data.values.connectedTo);
      indeg.set(n.data.values.connectedTo, indeg.get(n.data.values.connectedTo) + 1);
    }
  }
  const depth = new Map();
  const queue = def.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  queue.forEach((id) => depth.set(id, 0));
  const remaining = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    for (const s of succ.get(id)) {
      depth.set(s, Math.max(depth.get(s) ?? 0, depth.get(id) + 1));
      remaining.set(s, remaining.get(s) - 1);
      if (remaining.get(s) === 0) queue.push(s);
    }
  }
  const rows = new Map();
  for (const n of def.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }
  const gapX = NODE_W + 60;
  for (const [d, nodes] of rows) {
    nodes.forEach((n, i) => {
      n.position = { x: Math.round((i - (nodes.length - 1) / 2) * gapX), y: d * 170 };
    });
  }
}

export function triggerOf(def, catalog) {
  return def.nodes.find((n) => isTrigger(n, catalog));
}

/** A sample payload for the trigger (from its input schema or its type). */
export function samplePayload(def, catalog) {
  const trigger = triggerOf(def, catalog);
  if (!trigger) return {};
  const type = typeOf(trigger);
  if (type === 'chatTriggerNode' || type === 'askTriggerNode') return { chatMessage: 'Hello!' };
  if (type === 'searchTriggerNode') return { searchQuery: 'how do I reset my password' };
  if (type === 'localFolderNode') return { document_key: 'example.md', document_name: 'example.md', content: '# Example\n\nSome document text.' };
  let schema = trigger.data.values?.advance_schema;
  try {
    schema = typeof schema === 'string' && schema.trim() ? JSON.parse(schema) : schema;
  } catch {
    schema = undefined;
  }
  if (!schema || typeof schema !== 'object') return {};
  const props = schema.properties && typeof schema.properties === 'object' ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v?.type ?? 'string'])) : schema;
  const sample = (t, key) => (t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : typeof t === 'string' && t.startsWith('[') ? [] : Array.isArray(t) ? [] : t && typeof t === 'object' ? {} : key === 'url' ? 'https://example.com' : '');
  return Object.fromEntries(Object.entries(props).map(([k, t]) => [k, sample(t, k)]));
}

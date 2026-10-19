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
  if (spec?.kind !== 'trigger') applySmartDefaults(def, catalog, node, after);
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

/** Exec successors of a node (what runs after it). */
function successors(def) {
  const succ = new Map(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) if (EXEC.has(e.type) && succ.has(e.source) && succ.has(e.target)) succ.get(e.source).push(e.target);
  return succ;
}

/** True when connecting source → target would create a cycle (target already reaches source). */
export function wouldCycle(def, sourceId, targetId) {
  const succ = successors(def);
  const stack = [targetId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === sourceId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(succ.get(id) ?? []));
  }
  return false;
}

/** Why a connection is not allowed, or null when it is. */
export function connectionProblem(def, catalog, sourceId, targetId, branch) {
  if (sourceId === targetId) return 'A step cannot connect to itself.';
  const target = def.nodes.find((n) => n.id === targetId);
  if (!target) return 'That step no longer exists.';
  if (isTrigger(target, catalog)) return 'Triggers start a workflow, so nothing can connect into them.';
  if (def.edges.some((e) => e.source === sourceId && e.target === targetId && (e.branch ?? null) === (branch ?? null) && EXEC.has(e.type))) return 'These steps are already connected.';
  if (wouldCycle(def, sourceId, targetId)) return 'That would make a loop. Use a Loop step to repeat work.';
  return null;
}

/** Steps in run order (trigger first), with unconnected steps last. */
export function runOrder(def) {
  const succ = successors(def);
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  for (const list of succ.values()) for (const t of list) indeg.set(t, indeg.get(t) + 1);
  const queue = def.nodes.filter((n) => indeg.get(n.id) === 0).sort((a, b) => (a.data?.trigger ? -1 : 0) - (b.data?.trigger ? -1 : 0)).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    if (order.includes(id)) continue;
    order.push(id);
    for (const t of succ.get(id) ?? []) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  for (const n of def.nodes) if (!order.includes(n.id)) order.push(n.id);
  return order.map((id) => def.nodes.find((n) => n.id === id));
}

/**
 * Layered top-to-bottom layout: depth = longest path from the trigger, then a few barycenter sweeps order
 * each layer to reduce crossing edges, and rows are centred under their parents.
 */
export function autoLayout(def) {
  const succ = new Map(def.nodes.map((n) => [n.id, []]));
  const pred = new Map(def.nodes.map((n) => [n.id, []]));
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  const link = (a, b) => {
    succ.get(a).push(b);
    pred.get(b).push(a);
    indeg.set(b, indeg.get(b) + 1);
  };
  for (const e of def.edges) {
    if (!EXEC.has(e.type) || !succ.has(e.source) || !succ.has(e.target)) continue;
    link(e.source, e.target);
  }
  // Loop ends sit after their bodies: give them an edge from the loop start for ordering.
  for (const n of def.nodes) {
    const pair = PAIRS[typeOf(n)];
    if (pair && succ.has(n.data.values?.connectedTo) && !succ.get(n.id).includes(n.data.values.connectedTo)) link(n.id, n.data.values.connectedTo);
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
  const rows = [];
  for (const n of def.nodes) {
    const d = depth.get(n.id) ?? 0;
    (rows[d] ??= []).push(n.id);
  }
  const layers = rows.filter(Boolean);
  const index = new Map();
  const reindex = () => layers.forEach((layer) => layer.forEach((id, i) => index.set(id, i)));
  reindex();
  const sweep = (from, neighbours) => {
    for (const layer of from) {
      const bary = new Map(layer.map((id) => {
        const ns = neighbours.get(id).filter((x) => index.has(x));
        return [id, ns.length ? ns.reduce((sum, x) => sum + index.get(x), 0) / ns.length : index.get(id)];
      }));
      layer.sort((a, b) => bary.get(a) - bary.get(b) || index.get(a) - index.get(b));
      layer.forEach((id, i) => index.set(id, i));
    }
  };
  for (let i = 0; i < 4; i++) {
    sweep(layers.slice(1), pred);
    sweep(layers.slice(0, -1).reverse(), succ);
  }
  const gapX = NODE_W + 64;
  const gapY = 190;
  const xs = new Map();
  layers.forEach((layer, d) => {
    // Centre a row under its parents' mean position, then spread it so cards never overlap.
    const parents = layer.flatMap((id) => pred.get(id)).filter((p) => xs.has(p));
    const centre = parents.length ? parents.reduce((sum, p) => sum + xs.get(p), 0) / parents.length : 0;
    layer.forEach((id, i) => {
      const x = Math.round(centre + (i - (layer.length - 1) / 2) * gapX);
      xs.set(id, x);
      const node = def.nodes.find((n) => n.id === id);
      node.position = { x: Math.round(x / 10) * 10, y: d * gapY };
    });
  });
}

const RESPONSE_FOR = { chatTriggerNode: 'chatResponseNode', searchTriggerNode: 'searchResponseNode', askTriggerNode: 'askResponseNode' };

/** The response step that matches a workflow's trigger. */
export function responseTypeFor(def, catalog) {
  return RESPONSE_FOR[typeOf(triggerOf(def, catalog))] ?? 'graphqlResponseNode';
}

/** The most useful output of a step, as a reference later steps can use. */
export function mainOutputRef(node) {
  if (!node) return '';
  const id = node.id;
  const v = node.data.values ?? {};
  switch (typeOf(node)) {
    case 'chatTriggerNode': return `{{${id}.output.chatMessage}}`;
    case 'searchTriggerNode': return `{{${id}.output.searchQuery}}`;
    case 'askTriggerNode': return `{{${id}.output.message}}`;
    case 'graphqlNode': case 'webhookTriggerNode': {
      let schema = v.advance_schema;
      try { schema = typeof schema === 'string' && schema.trim() ? JSON.parse(schema) : schema; } catch { schema = undefined; }
      const keys = schema && typeof schema === 'object' ? Object.keys(schema.properties ?? schema) : [];
      return keys[0] ? `{{${id}.output.${keys[0]}}}` : `{{${id}.output}}`;
    }
    case 'cronNode': return `{{${id}.output.scheduledAt}}`;
    case 'localFolderNode': return `{{${id}.output.content}}`;
    case 'LLMNode': case 'multiModalLLMNode': case 'mcpNode': return `{{${id}.output.generatedResponse}}`;
    case 'RAGNode': return `{{${id}.output.modelResponse}}`;
    case 'agentClassifierNode': return `{{${id}.output.class}}`;
    case 'scraperNode': return `{{${id}.output.markdown}}`;
    case 'extractFromFileNode': return `{{${id}.output.text}}`;
    case 'rssNode': return `{{${id}.output.items}}`;
    case 'searchNode': case 'hybridSearchNode': case 'fullTextSearchNode': return `{{${id}.output.searchResults[:].content}}`;
    case 'memoryRetrieveNode': return `{{${id}.output.memories}}`;
    case 'chunkNode': return `{{${id}.output.chunks}}`;
    case 'agenticDocExtractionNode': return `{{${id}.output.extractedText}}`;
    case 'forLoopEndNode': return `{{${id}.output.loopOutput}}`;
    case 'batchEndNode': return `{{${id}.output.batchOutput}}`;
    default: return `{{${id}.output}}`;
  }
}

/**
 * Replaces catalog placeholders (which assume a node named triggerNode_1) with references to the steps that
 * actually feed the new node, so a freshly added step is wired to real data instead of failing validation.
 */
export function applySmartDefaults(def, catalog, node, sourceId) {
  const source = def.nodes.find((n) => n.id === sourceId) ?? triggerOf(def, catalog);
  const trigger = triggerOf(def, catalog);
  const ref = mainOutputRef(source);
  const v = node.data.values;
  const fixPrompts = () => {
    if (!Array.isArray(v.prompts)) return;
    v.prompts = v.prompts.map((p) => (p.role === 'user' && /\{\{triggerNode_1\./.test(p.content ?? '') ? { ...p, content: ref } : p));
  };
  switch (typeOf(node)) {
    case 'LLMNode': case 'multiModalLLMNode': case 'InstructorLLMNode': case 'agentClassifierNode': case 'mcpNode':
      fixPrompts();
      if (typeOf(trigger) === 'chatTriggerNode' && typeOf(node) === 'LLMNode') v.messages = `{{${trigger.id}.output.chatHistory}}`;
      break;
    case 'RAGNode': v.queryField = mainOutputRef(trigger) || ref; if (typeOf(trigger) === 'chatTriggerNode') v.messages = `{{${trigger.id}.output.chatHistory}}`; break;
    case 'searchNode': case 'hybridSearchNode': case 'fullTextSearchNode': v.searchQuery = ref; break;
    case 'memoryRetrieveNode': if (trigger) v.searchQuery = mainOutputRef(trigger); break;
    case 'chunkNode': v.chunkField = ref; break;
    case 'vectorizeNode': v.inputText = ref; break;
    case 'chatResponseNode': case 'askResponseNode': v.content = ref; break;
    case 'graphqlResponseNode': v.outputMapping = JSON.stringify({ result: ref }, null, 2); break;
    case 'codeNode': v.code = `// Read earlier values with {{step.output.field}} references.\nconst input = ${ref || 'null'};\noutput = { input };`; break;
    case 'slackNode': case 'telegramNode': v.text = ref; break;
    case 'discordNode': v.content = ref; break;
    case 'teamsNode': v.message = ref; break;
    case 'smtpNode': v.body = ref; break;
    default: break;
  }
  // Memory nodes default to triggerNode_1 references; point them at the real trigger.
  if (trigger && trigger.id !== 'triggerNode_1') {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') v[k] = val.replaceAll('{{triggerNode_1.', `{{${trigger.id}.`);
  }
}

const SUGGEST = {
  trigger: ['LLMNode', 'RAGNode', 'agentClassifierNode', 'InstructorLLMNode', 'extractFromFileNode', 'apiNode'],
  LLMNode: ['@response', 'conditionNode', 'slackNode', 'codeNode'],
  multiModalLLMNode: ['@response', 'LLMNode'],
  RAGNode: ['@response', 'LLMNode'],
  InstructorLLMNode: ['@response', 'conditionNode', 'tablesNode'],
  agentClassifierNode: ['LLMNode', '@response'],
  searchNode: ['LLMNode', '@response'], hybridSearchNode: ['LLMNode', '@response'], fullTextSearchNode: ['LLMNode', '@response'],
  extractFromFileNode: ['LLMNode', 'chunkNode', 'InstructorLLMNode'], scraperNode: ['LLMNode', 'chunkNode', 'InstructorLLMNode'],
  rssNode: ['LLMNode', 'forLoopNode'], apiNode: ['LLMNode', 'codeNode', '@response'], codeNode: ['LLMNode', '@response'],
  chunkNode: ['IndexNode', 'vectorizeNode'], vectorizeNode: ['IndexNode'], IndexNode: ['@response'],
  memoryRetrieveNode: ['LLMNode'], conditionNode: ['LLMNode', '@response'],
};

/** Steps that usually come next after `node`, best first. */
export function suggestedNext(def, catalog, node) {
  if (!node) return ['trigger'];
  const key = isTrigger(node, catalog) ? 'trigger' : typeOf(node);
  return (SUGGEST[key] ?? ['LLMNode', '@response']).map((t) => (t === '@response' ? responseTypeFor(def, catalog) : t)).filter((t) => catalog.byType.has(t));
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

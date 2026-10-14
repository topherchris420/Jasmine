const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (value) => structuredClone(value);
const pretty = (value) => JSON.stringify(value, null, 2);
const catalog = [
  ['chatTriggerNode', 'Chat Widget', 'Widget', '▢'], ['graphqlNode', 'API Request', 'Interface', '〈〉'], ['webhookTriggerNode', 'Webhook', 'Interface', '♧'],
  ['LLMNode', 'Generate Text', 'AI', '♙'], ['InstructorLLMNode', 'Structured Output', 'AI', '{}'], ['apiNode', 'API Call', 'App', '⌁'],
  ['codeNode', 'Code', 'Data', '〈〉'], ['variablesNode', 'Variables', 'Data', '{ }'], ['conditionNode', 'Condition', 'Logic', '⑂'],
  ['forLoopNode', 'For Loop', 'Logic', '↻'], ['forLoopEndNode', 'Loop End', 'Logic', '↻'], ['chatResponseNode', 'Chat Response', 'Response', '▢'], ['graphqlResponseNode', 'API Response', 'Response', '〈〉'],
];
const defaults = (type) => {
  if (type.endsWith('TriggerNode') || type === 'graphqlNode') return { responeType: 'realtime', advance_schema: '' };
  if (type === 'LLMNode') return { max_tokens: 512, prompts: [{ role: 'system', content: 'You are a helpful cybersecurity teaching assistant.' }, { role: 'user', content: '{{triggerNode_1.output.message}}' }] };
  if (type === 'InstructorLLMNode') return { max_tokens: 512, prompts: [{ role: 'user', content: '{{triggerNode_1.output.message}}' }], schema: '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}' };
  if (type === 'apiNode') return { url: 'https://example.com', method: 'GET', headers: '', body: '', retries: '0', retry_delay: '0' };
  if (type === 'codeNode') return { code: 'output = { message: "Hello from Jasmine" };' };
  if (type === 'variablesNode') return { mapping: '{}' };
  if (type === 'conditionNode') return { conditions: [{ label: 'Yes', value: 'yes', condition: '{"operator":"and","operands":[{"name":"{{triggerNode_1.output.message}}","operator":"isNotEmpty"}]}' }, { label: 'Else', value: 'else', condition: '{}' }] };
  if (type === 'forLoopNode') return { connectedTo: '', iterateOver: 'list', iteratorValue: '{{triggerNode_1.output.items}}' };
  if (type === 'forLoopEndNode') return { connectedTo: '' };
  if (type === 'chatResponseNode') return { content: '' };
  return { outputMapping: '{}' };
};
const triggerType = (type) => type === 'graphqlNode' || type.endsWith('TriggerNode');
let flows = [], current, config = {}, view = 'flows', selected, pendingPort, requestId, running = false;
let viewport = { x: 280, y: 155, zoom: .36 }, undoStack = [], redoStack = [], tab = 'editor';
const saveQueues = new Map();
let toastTimer, saveTimer;

function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
function credentials() { return JSON.parse(sessionStorage.getItem('jasmine.credentials') ?? '{}'); }
async function request(url, method = 'GET', body) {
  const keys = credentials();
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(keys.apiKey ? { authorization: `Bearer ${keys.apiKey}` } : {}), ...(keys.projectId ? { 'x-project-id': keys.projectId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.errors?.length) {
    const error = new Error(result.errors?.map((e) => e.message).join('\n') ?? `HTTP ${response.status}`);
    error.details = result.errors; throw error;
  }
  return result;
}
async function graphql(query, variables = {}) { return (await request('/graphql', 'POST', { query, variables })).data; }
function dialog(title, html, onOpen) { $('dialog-title').textContent = title; $('dialog-body').innerHTML = html; if (!$('dialog').open) $('dialog').showModal(); onOpen?.(); }
$('close-dialog').onclick = () => $('dialog').close();
function showError(error) { toast(error.message); if (error.details?.some((e) => e.extensions?.diagnostics)) dialog('Flow diagnostics', `<pre>${esc(pretty(error.details))}</pre>`); }

async function load() {
  try {
    const data = await request('/api/studio'); flows = data.flows; config = data;
    $('flow-count').textContent = flows.length;
    const flow = new URLSearchParams(location.search).get('flow');
    if (flow && flows.some((f) => f.id === flow)) openFlow(flow); else renderView('flows');
  } catch (error) { $('list-view').innerHTML = `<div class="view-content"><h1>Connect to Jasmine</h1><p>${esc(error.message)}</p><button id="open-credentials">Configure credentials</button></div>`; $('open-credentials').onclick = settings; }
}
function normalize(definition) {
  if (definition.nodes.every((node) => node.data)) return definition;
  return { meta: { name: definition.name }, nodes: definition.nodes.map((node, i) => ({ id: node.id, type: triggerType(node.type) ? 'triggerNode' : 'dynamicNode', position: { x: -125, y: i * 130 }, data: { nodeId: node.type, trigger: node.trigger, values: node.values, ...(node.logic ? { engineLogic: node.logic } : {}) } })), edges: definition.edges.map((edge, i) => ({ ...edge, id: `edge_${i}`, type: ({ default: 'defaultEdge', condition: 'conditionEdge', loop: 'loopEdge', response: 'responseEdge', branch: 'branchEdge' })[edge.kind] ?? 'defaultEdge', sourceHandle: edge.branch ?? 'bottom', targetHandle: 'top' })) };
}
function openFlow(id) {
  current = flows.find((f) => f.id === id); if (!current) return;
  current.definition = normalize(current.definition);
  selected = undefined; pendingPort = undefined; undoStack = []; redoStack = []; tab = 'editor';
  viewport = clone(current.definition.viewport ?? { x: 282.656, y: 154.746, zoom: .36086 });
  $('list-view').hidden = true; $('editor-view').hidden = false; $('inspector').hidden = true; $('test-panel').hidden = true;
  $('flow-name').value = current.name; $('updated').textContent = 'Saved locally'; $('save').textContent = '▣ Saved';
  $('deployment-status').textContent = current.deployedVersion ? 'Project Deployed' : 'Not deployed';
  setTab('editor'); renderGraph();
  history.replaceState({}, '', `/studio?flow=${encodeURIComponent(id)}`);
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'flows'));
}
function checkpoint() { undoStack.push(clone(current.definition)); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
function changed() { $('save').textContent = '▣ Unsaved'; clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(showError), 700); renderGraph(); }
async function save() {
  if (!current) return;
  const flow = current, definition = clone(flow.definition), name = $('flow-name').value.trim() || flow.name;
  definition.meta = { ...definition.meta, name };
  const prior = saveQueues.get(flow.id) ?? Promise.resolve();
  const saving = prior.then(async () => {
    const saved = await request(`/api/studio/flows/${flow.id}`, 'PUT', { name, definition, expectedRevision: flow.revision });
    flow.revision = saved.revision; flow.name = saved.name; flow.updatedAt = saved.updatedAt;
    if (current === flow && pretty(flow.definition) === pretty(definition)) $('save').textContent = '▣ Saved';
    if (current === flow) $('updated').textContent = 'Just now';
    return saved;
  });
  saveQueues.set(flow.id, saving.catch(() => {}));
  return saving;
}
function nodeInfo(node) { return catalog.find((item) => item[0] === node.data.nodeId) ?? [node.data.nodeId, node.data.nodeId, 'Node', '□']; }
function position(node, index) { return node.position ?? { x: -125, y: index * 130 }; }
function renderGraph() {
  if (!current) return;
  $('graph').style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  current.definition.viewport = clone(viewport);
  const nodes = current.definition.nodes.filter((node) => node.data.nodeId !== 'stickyNoteNode' && node.data.nodeId !== 'addNode');
  $('nodes').innerHTML = nodes.map((node, i) => {
    const info = nodeInfo(node), p = position(node, i);
    return `<article class="node ${selected === node.id ? 'selected' : ''}" data-node="${esc(node.id)}" style="left:${Number(p.x)}px;top:${Number(p.y)}px" tabindex="0" role="button" aria-label="Configure ${esc(node.data.values.nodeName ?? info[1])}"><div class="ready">Ready to Test</div><div class="node-body"><span class="node-icon">${esc(info[3])}</span><div><small>${esc(info[2])}</small><strong>${esc(node.data.values.nodeName ?? info[1])}</strong></div></div><button class="delete-node" data-delete="${esc(node.id)}" title="Delete node">×</button>${!triggerType(info[0]) ? `<button class="port input" data-input="${esc(node.id)}" aria-label="Connect to ${esc(node.id)}"></button>` : ''}<button class="port output ${pendingPort === node.id ? 'pending' : ''}" data-output="${esc(node.id)}" aria-label="Connect from ${esc(node.id)}"></button><button class="insert-step" data-insert="${esc(node.id)}" aria-label="Insert step here">+</button></article>`;
  }).join('');
  const notes = current.definition.notes ?? [];
  $('notes').innerHTML = notes.map((note, i) => `<article class="note ${esc(note.color ?? 'yellow')}" data-note="${i}" style="left:${Number(note.x)}px;top:${Number(note.y)}px;width:${Number(note.width ?? 640)}px"><h3>${esc(note.title)}</h3><div>${esc(note.text)}</div></article>`).join('');
  const byId = new Map(nodes.map((node, i) => [node.id, position(node, i)]));
  $('edges').innerHTML = current.definition.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => byId.has(edge.source) && byId.has(edge.target) && edge.type !== 'responseEdge').map(({ edge, index }) => {
    const from = byId.get(edge.source), to = byId.get(edge.target);
    const x1 = from.x + 100, y1 = from.y + 80, x2 = to.x + 100, y2 = to.y;
    return `<path data-edge="${index}" d="M${x1},${y1} C${x1},${y1 + 35} ${x2},${y2 - 35} ${x2},${y2}"><title>${esc(edge.source)} → ${esc(edge.target)} (double-click to remove)</title></path>`;
  }).join('');
  $('empty').hidden = nodes.length > 0;
  $('minimap').innerHTML = nodes.map((node, i) => `<i style="left:${15 + i % 5 * 22}px;top:${12 + Math.floor(i / 5) * 13}px"></i>`).join('');
}
function selectNode(id) { selected = id; renderGraph(); inspector(); }
function inspector() {
  const node = current.definition.nodes.find((n) => n.id === selected); if (!node) return;
  const [type, name] = nodeInfo(node), values = node.data.values;
  $('inspector-title').textContent = values.nodeName ?? name; $('inspector').hidden = false;
  let fields = `<label>Node name</label><input data-field="nodeName" value="${esc(values.nodeName ?? name)}"><p class="field-help">Node ID: ${esc(node.id)}</p>`;
  const text = (key, label, large = false) => `<label>${esc(label)}</label>${large ? `<textarea data-field="${key}">${esc(values[key] ?? '')}</textarea>` : `<input data-field="${key}" value="${esc(values[key] ?? '')}">`}`;
  if (triggerType(type)) fields += `<label>Response type</label><select data-field="responeType"><option ${values.responeType === 'realtime' ? 'selected' : ''}>realtime</option><option ${values.responeType === 'async' ? 'selected' : ''}>async</option></select>` + text('advance_schema', 'Input schema (JSON)', true);
  if (type === 'LLMNode' || type === 'InstructorLLMNode') {
    fields += `<label>Model</label><div class="info-box">Local model: <strong>${esc(config.model)}</strong><br>Provider: ${esc(config.provider)}</div><label>Prompts</label>`;
    fields += (values.prompts ?? []).map((prompt, i) => `<select data-prompt-role="${i}">${['system', 'user', 'assistant'].map((role) => `<option ${role === prompt.role ? 'selected' : ''}>${role}</option>`).join('')}</select><textarea class="prompt-content" data-prompt="${i}">${esc(prompt.content)}</textarea>`).join('');
    fields += `<button id="add-prompt">+ Add message</button>` + text('max_tokens', 'Maximum tokens');
    if (type === 'InstructorLLMNode') fields += text('schema', 'Response JSON schema', true);
  }
  if (type === 'apiNode') fields += text('url', 'URL') + `<label>Method</label><select data-field="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => `<option ${values.method === method ? 'selected' : ''}>${method}</option>`).join('')}</select>` + text('headers', 'Headers (JSON)', true) + text('body', 'Body', true) + text('retries', 'Retries') + text('retry_delay', 'Retry delay (seconds)');
  if (type === 'codeNode') fields += text('code', 'JavaScript', true);
  if (type === 'variablesNode') fields += text('mapping', 'Output mapping (JSON)', true);
  if (type === 'chatResponseNode') fields += text('content', 'Response content', true);
  if (type === 'graphqlResponseNode') fields += text('outputMapping', 'Output mapping (JSON)', true);
  if (type === 'forLoopNode' || type === 'forLoopEndNode') fields += text('connectedTo', 'Paired loop node ID') + (type === 'forLoopNode' ? text('iteratorValue', 'Array reference') : '');
  fields += `<label>All values (JSON)</label><textarea id="raw-values">${esc(pretty(values))}</textarea><div class="button-row"><button id="apply-values" class="black">Apply JSON</button><button id="remove-node" class="danger">Delete node</button></div><p class="field-help">References use {{nodeId.output.path}}. Select an output connector, then an input connector to connect nodes.</p>`;
  $('inspector-body').innerHTML = fields;
  $('inspector-body').querySelectorAll('[data-field],[data-prompt],[data-prompt-role]').forEach((input) => input.onchange = () => {
    checkpoint();
    if (input.dataset.field) values[input.dataset.field] = input.value;
    if (input.dataset.prompt) values.prompts[Number(input.dataset.prompt)].content = input.value;
    if (input.dataset.promptRole) values.prompts[Number(input.dataset.promptRole)].role = input.value;
    $('raw-values').value = pretty(values); changed();
  });
  if ($('add-prompt')) $('add-prompt').onclick = () => { checkpoint(); (values.prompts ??= []).push({ role: 'user', content: '' }); changed(); inspector(); };
  $('apply-values').onclick = () => { try { const raw = JSON.parse($('raw-values').value); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Values must be a JSON object'); checkpoint(); node.data.values = raw; changed(); inspector(); } catch (error) { showError(error); } };
  $('remove-node').onclick = () => removeNode(node.id);
}
function removeNode(id) { checkpoint(); current.definition.nodes = current.definition.nodes.filter((n) => n.id !== id); current.definition.edges = current.definition.edges.filter((e) => e.source !== id && e.target !== id); selected = undefined; $('inspector').hidden = true; changed(); }
function addNodeMenu(after) {
  dialog('Add a node', `<div class="dialog-grid">${catalog.map(([type, name, category, icon]) => `<button data-type="${type}">${esc(icon)} ${esc(name)}<small>${esc(category)}</small></button>`).join('')}</div>`, () => {
    $('dialog-body').querySelectorAll('[data-type]').forEach((button) => button.onclick = () => {
      checkpoint(); const type = button.dataset.type, info = catalog.find((c) => c[0] === type);
      const id = triggerType(type) && !current.definition.nodes.some((n) => n.id === 'triggerNode_1') ? 'triggerNode_1' : `${type}_${crypto.randomUUID().slice(0, 8)}`;
      const anchor = current.definition.nodes.find((n) => n.id === after);
      const point = anchor?.position ?? { x: -125, y: current.definition.nodes.length * 130 - 130 };
      const node = { id, type: triggerType(type) ? 'triggerNode' : 'dynamicNode', position: { x: point.x, y: point.y + 130 }, data: { nodeId: type, trigger: triggerType(type), values: { nodeName: info[1], ...defaults(type) } } };
      current.definition.nodes.push(node);
      if (after) current.definition.edges.push({ id: `edge_${crypto.randomUUID()}`, source: after, target: id, type: 'defaultEdge', sourceHandle: 'bottom', targetHandle: 'top' });
      $('dialog').close(); changed(); selectNode(id);
    });
  });
}
let drag;
$('canvas').addEventListener('pointerdown', (event) => {
  if (event.target.closest('button,path')) return;
  const element = event.target.closest('[data-node],[data-note]');
  if (element?.dataset.node) {
    const node = current.definition.nodes.find((n) => n.id === element.dataset.node), i = current.definition.nodes.indexOf(node);
    drag = { kind: 'node', node, x: event.clientX, y: event.clientY, origin: clone(position(node, i)), before: clone(current.definition), moved: false };
  } else if (element?.dataset.note) {
    const note = current.definition.notes[Number(element.dataset.note)];
    drag = { kind: 'note', note, x: event.clientX, y: event.clientY, origin: { x: note.x, y: note.y }, before: clone(current.definition), moved: false };
  } else drag = { kind: 'pan', x: event.clientX, y: event.clientY, origin: clone(viewport) };
  $('canvas').setPointerCapture(event.pointerId);
});
$('canvas').addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (drag.kind === 'pan') { viewport.x = drag.origin.x + dx; viewport.y = drag.origin.y + dy; }
  else { drag.moved ||= Math.abs(dx) + Math.abs(dy) > 3; const position = { x: drag.origin.x + dx / viewport.zoom, y: drag.origin.y + dy / viewport.zoom }; if (drag.kind === 'node') drag.node.position = position; else Object.assign(drag.note, position); }
  renderGraph();
});
$('canvas').addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.moved) { undoStack.push(drag.before); redoStack = []; changed(); }
  else if (drag.kind === 'node') selectNode(drag.node.id);
  if (drag.kind === 'pan') current.definition.viewport = clone(viewport);
  drag = undefined;
});
$('canvas').addEventListener('wheel', (event) => { event.preventDefault(); const rect = $('canvas').getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top, factor = Math.exp(-event.deltaY * .001); zoom(viewport.zoom * factor, x, y); }, { passive: false });
function zoom(value, x = $('canvas').clientWidth / 2, y = $('canvas').clientHeight / 2) { const next = Math.min(2, Math.max(.15, value)), factor = next / viewport.zoom; viewport.x = x - (x - viewport.x) * factor; viewport.y = y - (y - viewport.y) * factor; viewport.zoom = next; renderGraph(); }
function fit() {
  const nodes = current.definition.nodes; if (!nodes.length) { viewport = { x: 200, y: 180, zoom: 1 }; renderGraph(); return; }
  const points = nodes.map(position), minX = Math.min(...points.map((p) => p.x)), minY = Math.min(...points.map((p) => p.y)), maxX = Math.max(...points.map((p) => p.x)) + 200, maxY = Math.max(...points.map((p) => p.y)) + 80;
  viewport.zoom = Math.min(1.2, ($('canvas').clientWidth - 100) / (maxX - minX), ($('canvas').clientHeight - 160) / (maxY - minY));
  viewport.x = ($('canvas').clientWidth - (maxX - minX) * viewport.zoom) / 2 - minX * viewport.zoom;
  viewport.y = ($('canvas').clientHeight - (maxY - minY) * viewport.zoom) / 2 - minY * viewport.zoom; renderGraph();
}
$('canvas').onclick = (event) => {
  const output = event.target.closest('[data-output]'), input = event.target.closest('[data-input]'), remove = event.target.closest('[data-delete]'), insert = event.target.closest('[data-insert]');
  if (output) { pendingPort = output.dataset.output; renderGraph(); }
  else if (input && pendingPort) {
    if (pendingPort === input.dataset.input) return toast('A node cannot connect to itself');
    checkpoint(); const source = current.definition.nodes.find((n) => n.id === pendingPort);
    let edge = { id: `edge_${crypto.randomUUID()}`, source: pendingPort, target: input.dataset.input, type: 'defaultEdge', sourceHandle: 'bottom', targetHandle: 'top' };
    if (source.data.nodeId === 'conditionNode') {
      const conditions = source.data.values.conditions ?? [];
      if (!conditions.length) return toast('Configure this condition before connecting it');
      const label = prompt(`Branch value (${conditions.map((c) => c.value).join(', ')}):`, conditions[0].value);
      if (!conditions.some((c) => c.value === label)) return toast('Select a configured branch value');
      edge.type = 'conditionEdge'; edge.sourceHandle = label; edge.branch = label;
    }
    if (!current.definition.edges.some((e) => e.source === edge.source && e.target === edge.target && e.sourceHandle === edge.sourceHandle)) current.definition.edges.push(edge);
    pendingPort = undefined; changed();
  } else if (remove) removeNode(remove.dataset.delete); else if (insert) addNodeMenu(insert.dataset.insert);
};
$('edges').ondblclick = (event) => { const edge = event.target.closest('[data-edge]'); if (!edge) return; const actual = current.definition.edges[Number(edge.dataset.edge)]; checkpoint(); current.definition.edges = current.definition.edges.filter((e) => e !== actual); changed(); };
$('nodes').onkeydown = (event) => { if (event.key === 'Enter' && event.target.dataset.node) selectNode(event.target.dataset.node); };
async function deploy() { await save(); const deployed = await request(`/api/studio/flows/${current.id}/deploy`, 'POST', {}); current.deployedVersion = deployed.version; $('deployment-status').textContent = 'Project Deployed'; toast(`Deployed ${current.name}`); return deployed; }
$('deploy').onclick = () => { if (!current) return toast('Open a flow to deploy it'); deploy().catch(showError); };
function showTest() { if (!current) return; $('test-panel').hidden = false; $('inspector').hidden = true; }
$('test').onclick = showTest; $('debug').onclick = showTest; $('show-test').onclick = () => $('test-panel').hidden = !$('test-panel').hidden;
$('close-test').onclick = () => $('test-panel').hidden = true; $('close-inspector').onclick = () => $('inspector').hidden = true;
const runFields = 'status requestId result error { code message nodeId retryable }';
async function run() {
  if (running) return; let payload;
  try { payload = JSON.parse($('payload').value); } catch { return toast('Input payload must be valid JSON'); }
  running = true; $('run').disabled = true; $('run-status').textContent = 'Deploying…'; $('test-output').textContent = ''; requestId = undefined;
  const flowId = current.id;
  try {
    await deploy();
    const data = await graphql(`mutation($id:String!,$payload:JSON){executeWorkflow(workflowId:$id,payload:$payload,mode:async){${runFields}}}`, { id: flowId, payload });
    let response = data.executeWorkflow; requestId = response.requestId; $('cancel').disabled = false; $('run-status').textContent = 'Running locally…';
    while (response.status === 'in-progress') { await new Promise((resolve) => setTimeout(resolve, 500)); response = (await graphql(`query($id:String!){checkStatus(requestId:$id){${runFields}}}`, { id: requestId })).checkStatus; }
    $('run-status').textContent = response.status;
    const trace = (await graphql('query($id:String!){runTrace(requestId:$id)}', { id: requestId })).runTrace;
    $('test-output').innerHTML = `<div class="test-result-title"><strong class="${esc(response.status)}">${esc(response.status)}</strong><span>${esc(response.result?.timeTakenInSeconds ?? 0)}s</span></div><pre>${esc(pretty(response.result?.output ?? response.error))}</pre><details open><summary>Node execution</summary><table><thead><tr><th>Node</th><th>Status</th><th>Time</th></tr></thead><tbody>${(response.result?.nodes ?? []).map((n) => `<tr><td>${esc(n.nodeId)}</td><td>${esc(n.statusCode)}</td><td>${esc(n.durationMs)}ms</td></tr>`).join('')}</tbody></table></details><details><summary>Execution trace</summary><pre>${esc(pretty(trace))}</pre></details><details><summary>Full response</summary><pre>${esc(pretty(response))}</pre></details>`;
  } catch (error) { $('run-status').textContent = 'Failed'; $('test-output').innerHTML = `<pre class="failed">${esc(error.message)}</pre>`; }
  finally { running = false; $('run').disabled = false; $('cancel').disabled = true; }
}
$('run').onclick = run; $('cancel').onclick = () => { if (requestId) graphql('mutation($id:String!){cancelWorkflow(requestId:$id)}', { id: requestId }).then(() => $('run-status').textContent = 'Cancelling…').catch(showError); };
async function historyView(target, reports = false) {
  if (!current) { target.innerHTML = '<p>Open a flow to inspect its runs.</p>'; return; }
  const data = await graphql(`query($id:String!){runHistory(workflowId:$id){${runFields}}}`, { id: current.id });
  const runs = data.runHistory;
  if (reports) {
    const sum = (key) => runs.reduce((total, run) => total + (run.result?.usage?.[key] ?? 0), 0);
    target.innerHTML = `<h1>Reports</h1><div class="metric-row"><div class="metric"><small>Runs</small><strong>${runs.length}</strong></div><div class="metric"><small>LLM calls</small><strong>${sum('llmCalls')}</strong></div><div class="metric"><small>Input tokens</small><strong>${sum('inputTokens')}</strong></div><div class="metric"><small>Output tokens</small><strong>${sum('outputTokens')}</strong></div></div><p>Local model token usage across retained runs.</p>`;
  } else target.innerHTML = `<h1>Logs</h1><p>Runs for ${esc(current.name)}</p><table><thead><tr><th>Request</th><th>Status</th><th>Duration</th><th>Version</th></tr></thead><tbody>${runs.map((run) => `<tr><td>${esc(run.requestId)}</td><td>${esc(run.status)}</td><td>${esc(run.result?.timeTakenInSeconds ?? '—')}s</td><td>${esc(run.result?.version ?? '—')}</td></tr>`).join('')}</tbody></table>${runs.length ? `<pre>${esc(pretty(runs[0]))}</pre>` : '<p>No runs yet. Use Test to execute this flow.</p>'}`;
}
function setTab(next) { tab = next; $('canvas').hidden = next !== 'editor'; $('report-view').hidden = next === 'editor'; document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('selected', b.dataset.tab === next)); if (next !== 'editor') historyView($('report-view'), next === 'reports').catch(showError); }
document.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => setTab(button.dataset.tab));
async function renderView(next) {
  view = next; $('editor-view').hidden = true; $('list-view').hidden = false; $('inspector').hidden = true; $('test-panel').hidden = true;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === next));
  const target = $('list-view');
  if (next === 'flows') {
    target.innerHTML = `<div class="list-intro"><h1>What is a Flow in Jasmine?</h1><p>Flows are the core building blocks of Jasmine, enabling you to connect various modules (nodes) in a meaningful sequence to achieve your desired outcomes. This guide provides a comprehensive overview of understanding and creating flows in Jasmine.</p><button id="flow-docs">See Docs ▣</button></div><div class="list-title">${flows.length === 1 ? 'Starter Flows' : 'Flows'}<button id="import">Import JSON</button></div>${flows.map((flow) => `<div class="flow-row" data-flow="${esc(flow.id)}" tabindex="0" role="button"><span class="dot">●</span><span class="row-name">${esc(flow.name)}</span><span class="row-icons">${esc((flow.definition.nodes ?? []).slice(0, 4).map((node) => catalog.find((c) => c[0] === node.data?.nodeId)?.[3] ?? '□').join('　'))}</span><span class="row-time">${esc(new Date(flow.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span><button data-edit="${esc(flow.id)}">Edit</button></div>`).join('')}`;
    target.querySelectorAll('[data-flow]').forEach((row) => { row.ondblclick = () => openFlow(row.dataset.flow); row.onkeydown = (e) => { if (e.key === 'Enter') openFlow(row.dataset.flow); }; });
    target.querySelectorAll('[data-edit]').forEach((button) => button.onclick = () => openFlow(button.dataset.edit));
    $('import').onclick = () => $('import-file').click(); $('flow-docs').onclick = docs;
  } else if (next === 'deployments') {
    target.innerHTML = `<div class="view-content"><h1>Deployments</h1><p>Active local workflow versions are restored when Jasmine restarts.</p><table><thead><tr><th>Flow</th><th>Active version</th><th></th></tr></thead><tbody>${flows.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.deployedVersion ?? 'Not deployed')}</td><td><button data-open="${esc(f.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`;
    target.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openFlow(b.dataset.open));
  } else if (next === 'connections') target.innerHTML = `<div class="view-content"><h1>Connections</h1><div class="info-box"><strong>Local AI</strong><p>Provider: ${esc(config.provider)}<br>Model: ${esc(config.model)}</p><p>Configure LLM_BASE_URL and LLM_MODEL on the server. Cloud-labelled nodes use this selected model.</p></div></div>`;
  else if (next === 'prompts') {
    target.innerHTML = `<div class="view-content"><h1>Prompts</h1>${flows.flatMap((f) => f.definition.nodes.filter((n) => n.data?.values?.prompts).map((n) => `<h3>${esc(f.name)} / ${esc(n.data.values.nodeName ?? n.id)}</h3><pre>${esc(pretty(n.data.values.prompts))}</pre>`)).join('') || '<p>Add a Generate Text node to create a prompt.</p>'}</div>`;
  } else if (next === 'data') target.innerHTML = `<div class="view-content"><h1>Data</h1><p>Variable mappings and structured output are supported in the local engine. Vector data sources and RAG ingestion have not yet been reconstructed.</p><button id="data-flow">Open flow</button></div>`;
  else if (next === 'logs' || next === 'reports' || next === 'jobs') { target.innerHTML = '<div class="view-content" id="history-view"></div>'; await historyView($('history-view'), next === 'reports'); }
  else if (next === 'playground') {
    target.innerHTML = `<div class="view-content"><h1>API Playground</h1><label>GraphQL query</label><textarea id="query" class="query">query { flowVersions(workflowId: "${esc(current?.id ?? flows[0]?.id ?? 'getting-started')}") { version deployedAt active } }</textarea><label>Variables (JSON)</label><textarea id="variables">{}</textarea><button id="execute-query" class="black">Run query</button><pre id="query-result"></pre></div>`;
    $('execute-query').onclick = async () => { try { $('query-result').textContent = pretty(await request('/graphql', 'POST', { query: $('query').value, variables: JSON.parse($('variables').value) })); } catch (error) { $('query-result').textContent = error.message; } };
  }
  if ($('data-flow')) $('data-flow').onclick = () => flows[0] && openFlow(flows[0].id);
}
document.querySelectorAll('[data-view]').forEach((button) => button.onclick = () => renderView(button.dataset.view).catch(showError));
async function createFlow(definition = { meta: { name: 'Untitled Flow' }, nodes: [], edges: [], notes: [] }) {
  const name = definition.meta?.name ?? 'Untitled Flow', id = `flow-${crypto.randomUUID().slice(0, 8)}`;
  const saved = await request(`/api/studio/flows/${id}`, 'PUT', { name, definition, expectedRevision: 0 }); flows.push(saved); $('flow-count').textContent = flows.length; openFlow(id); if (!definition.nodes.length) { viewport = { x: 250, y: 200, zoom: 1 }; renderGraph(); addNodeMenu(); }
}
$('create').onclick = () => dialog('Create', '<div class="dialog-grid"><button id="new-flow">♧ Flow<small>Connect nodes into a workflow</small></button><button id="import-flow">↑ Import flow<small>Open a Studio JSON export</small></button></div>', () => { $('new-flow').onclick = () => { $('dialog').close(); createFlow().catch(showError); }; $('import-flow').onclick = () => { $('dialog').close(); $('import-file').click(); }; });
$('import-file').onchange = async (event) => { const file = event.target.files[0]; if (!file) return; try { const definition = normalize(JSON.parse(await file.text())); if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new Error('Import requires nodes and edges'); await createFlow(definition); toast('Flow imported'); } catch (error) { showError(error); } event.target.value = ''; };
function exportFlow() { const blob = new Blob([pretty(current.definition)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `${current.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
$('config').onclick = () => dialog('Flow configuration', `<p>Studio export. Editing here updates the local draft.</p><textarea id="flow-json" spellcheck="false">${esc(pretty(current.definition))}</textarea><div class="test-actions"><button id="apply-flow" class="black">Apply</button><button id="export-flow">Export JSON</button></div>`, () => { $('export-flow').onclick = exportFlow; $('apply-flow').onclick = () => { try { const definition = normalize(JSON.parse($('flow-json').value)); if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new Error('Configuration requires nodes and edges'); checkpoint(); current.definition = definition; selected = undefined; changed(); $('dialog').close(); } catch (error) { showError(error); } }; });
$('more').onclick = () => dialog('Flow actions', '<div class="dialog-grid"><button id="export-action">Export JSON</button><button id="add-action">Add node</button></div>', () => { $('export-action').onclick = exportFlow; $('add-action').onclick = () => { $('dialog').close(); addNodeMenu(); }; });
$('templates').onclick = () => dialog('Templates', '<p>The Getting Started template runs locally. Other upstream templates have not been verified against the local engine.</p><button id="clone-starter">1 - Getting Started</button>', () => $('clone-starter').onclick = () => { $('dialog').close(); const starter = flows.find((f) => f.id === 'getting-started') ?? flows[0]; if (starter) createFlow(clone(starter.definition)).catch(showError); });
$('add-note').onclick = () => dialog('Add note', '<label>Title</label><input id="note-title" value="Note"><label>Text</label><textarea id="note-text"></textarea><button id="save-note" class="black">Add note</button>', () => $('save-note').onclick = () => { checkpoint(); (current.definition.notes ??= []).push({ title: $('note-title').value, text: $('note-text').value, color: 'yellow', x: 200, y: 0, width: 400 }); changed(); $('dialog').close(); });
$('undo').onclick = () => { if (!undoStack.length) return; redoStack.push(clone(current.definition)); current.definition = undoStack.pop(); changed(); };
$('redo').onclick = () => { if (!redoStack.length) return; undoStack.push(clone(current.definition)); current.definition = redoStack.pop(); changed(); };
$('zoom-in').onclick = () => zoom(viewport.zoom * 1.25); $('zoom-out').onclick = () => zoom(viewport.zoom / 1.25); $('fit').onclick = fit;
$('save').onclick = () => save().catch(showError); $('flow-name').onchange = () => { current.definition.meta = { ...current.definition.meta, name: $('flow-name').value }; changed(); };
$('back').onclick = () => { history.replaceState({}, '', '/studio'); renderView('flows').catch(showError); };
$('collapse').onclick = () => document.body.classList.toggle('collapsed');
$('search').onclick = () => dialog('Search flows', '<input id="flow-search" placeholder="Search by flow name"><div id="search-results"></div>', () => { const render = () => { $('search-results').innerHTML = flows.filter((f) => f.name.toLowerCase().includes($('flow-search').value.toLowerCase())).map((f) => `<p><button data-search-flow="${esc(f.id)}">${esc(f.name)}</button></p>`).join(''); $('search-results').querySelectorAll('button').forEach((b) => b.onclick = () => { $('dialog').close(); openFlow(b.dataset.searchFlow); }); }; $('flow-search').oninput = render; render(); });
function docs() { dialog('Jasmine API documentation', '<p>POST /graphql. Use Authorization: Bearer &lt;key&gt; and x-project-id when configured.</p><pre>mutation($id: String!, $payload: JSON) {\n  executeWorkflow(workflowId: $id, payload: $payload) {\n    status requestId result error { code message }\n  }\n}</pre><p>Flows use {{nodeId.output.path}} references. Save persists the draft; Deploy activates a validated version; Test deploys and executes the current draft with the local model.</p><p>Supported nodes: Chat/API/Webhook triggers, Generate Text, Structured Output, API Call, Code, Variables, Conditions, For Loop and Responses.</p>'); }
$('api-docs').onclick = docs; $('help').onclick = docs;
function settings() { const keys = credentials(); dialog('Settings', `<label>API key</label><input id="api-key" type="password" value="${esc(keys.apiKey ?? '')}" autocomplete="off"><label>Project ID</label><input id="project-id" value="${esc(keys.projectId ?? '')}"><p>Credentials stay in this browser session. The inference endpoint and model are configured on the server.</p><button id="save-settings" class="black">Save settings</button>`, () => $('save-settings').onclick = () => { sessionStorage.setItem('jasmine.credentials', JSON.stringify({ apiKey: $('api-key').value, projectId: $('project-id').value })); $('dialog').close(); load(); }); }
$('settings').onclick = settings;
$('setup').onclick = () => dialog('Setup', `<p>Run this flow from your local application:</p><pre>POST http://127.0.0.1:8787/graphql\nContent-Type: application/json\n\n${esc(pretty({ query: 'mutation($id:String!,$payload:JSON){executeWorkflow(workflowId:$id,payload:$payload){status requestId result}}', variables: { id: current.id, payload: { message: 'Hello' } } }))}</pre>`);
$('github').onclick = () => dialog('GitHub', '<p>Jasmine source and releases are managed in your private GitHub repository. This local instance does not connect to or modify another provider’s workspace.</p>');
$('project').onclick = () => toast('Jasmine Project · local workspace'); $('organization').onclick = () => toast('Jasmine Organization · local workspace'); $('tags').onclick = () => dialog('Tags', `<label>Comma-separated tags</label><input id="flow-tags" value="${esc((current.definition.meta?.tags ?? []).join(', '))}"><button id="apply-tags" class="black">Apply</button>`, () => $('apply-tags').onclick = () => { checkpoint(); current.definition.meta = { ...current.definition.meta, tags: $('flow-tags').value.split(',').map((s) => s.trim()).filter(Boolean) }; changed(); $('dialog').close(); });
document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save().catch(showError); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.target.matches('input,textarea') && current) { event.preventDefault(); $(event.shiftKey ? 'redo' : 'undo').click(); } if (event.key === 'Escape') { pendingPort = undefined; $('inspector').hidden = true; renderGraph(); } });
window.addEventListener('beforeunload', (event) => { if ($('save').textContent.includes('Unsaved')) { event.preventDefault(); event.returnValue = ''; } });
load();

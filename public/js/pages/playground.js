import { api, getKey, projectId } from '../api.js';
import { button, card, emptyState, field, fill, h, icon, input, jsonPanel, ms, page, pretty, select, statusBadge, textarea, toast } from '../ui.js';
import { samplePayload, snippets, snippetTabs, triggerInfo } from './deployment.js';

const QUERY = `mutation Run($workflowId: String!, $payload: JSON, $mode: RunMode) {
  executeWorkflow(workflowId: $workflowId, payload: $payload, mode: $mode) {
    status
    requestId
    result
    statusCode
    timeTakenInSeconds
    usage
    error { code message nodeId }
  }
}`;

export async function render(container, _params, { navigate, query }) {
  const flows = (await api.get('/api/flows')).filter((f) => f.deployedVersion);
  if (!flows.length) {
    container.append(page('API Playground', 'Call deployed flows exactly as your application will.', [],
      emptyState('playground', 'No deployed flows', 'Deploy a flow first; then run it here over GraphQL or REST and copy working code.', button('Go to flows', { kind: 'primary', onClick: () => navigate('/flows') }))));
    return;
  }
  const state = { flowId: flows.some((f) => f.id === query.get('flow')) ? query.get('flow') : flows[0].id, transport: 'graphql', mode: 'realtime', key: '', payload: '{}' };
  const project = await projectId();
  const out = h('div', { class: 'stack' });
  const code = h('div');
  const payloadBox = h('div');
  const payloadFor = async (flowId) => {
    const f = await api.get(`/api/flows/${encodeURIComponent(flowId)}/versions`);
    if (!f.active) return {};
    const v = await api.get(`/api/flows/${encodeURIComponent(flowId)}/versions/${f.active}`);
    return samplePayload(triggerInfo(v.definition));
  };
  const drawCode = () => {
    let payload = {};
    try {
      payload = JSON.parse(state.payload || '{}');
    } catch {
      /* keep last good */
    }
    fill(code, snippetTabs(snippets({ flowId: state.flowId, payload, key: state.key || null, projectId: project })));
  };
  const drawPayload = () => fill(payloadBox, field('Payload (JSON)', textarea(state.payload, (v) => { state.payload = v; drawCode(); }, { mono: true, rows: 10 }), 'Tab indents. Press Escape, then Tab, to move on.'));
  const choose = async (flowId) => {
    state.flowId = flowId;
    history.replaceState(null, '', `/playground?flow=${encodeURIComponent(flowId)}`);
    state.payload = pretty(await payloadFor(flowId));
    drawPayload();
    drawCode();
  };

  const run = async (e) => {
    const btn = e.currentTarget;
    let payload;
    try {
      payload = JSON.parse(state.payload || '{}');
    } catch (err) {
      return toast(`Payload is not valid JSON: ${err.message}`, 'error');
    }
    btn.disabled = true;
    fill(out, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), 'Running…'));
    const t0 = performance.now();
    try {
      const key = state.key || getKey();
      const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(project ? { 'x-project-id': project } : {}) };
      const res = state.transport === 'graphql'
        ? await fetch('/graphql', { method: 'POST', headers, body: JSON.stringify({ query: QUERY, variables: { workflowId: state.flowId, payload, mode: state.mode } }) })
        : await fetch(`/api/v1/flows/${encodeURIComponent(state.flowId)}/execute`, { method: 'POST', headers, body: JSON.stringify({ payload, mode: state.mode }) });
      const elapsed = performance.now() - t0;
      const body = await res.json().catch(() => null);
      const result = state.transport === 'graphql' ? body?.data?.executeWorkflow : body;
      const requestId = result?.requestId;
      fill(out, 
        h('div', { class: 'row' }, h('span', { class: 'badge badge-neutral' }, `HTTP ${res.status}`), result?.status ? statusBadge(result.status) : null, h('span', { class: 'muted small' }, `${ms(elapsed)} round trip`),
          requestId ? h('a', { href: `/logs/${requestId}`, 'data-link': '', class: 'small' }, 'View run log →') : null,
          requestId && result?.status === 'in-progress' ? button('Check status', { size: 'sm', icon: 'refresh', onClick: async () => {
            const s = await api.get(`/api/v1/runs/${requestId}`);
            fill(out, h('div', { class: 'row' }, statusBadge(s.status), h('a', { href: `/logs/${requestId}`, 'data-link': '', class: 'small' }, 'View run log →')), jsonPanel(s, 'checkStatus'));
          } }) : null),
        res.status === 403 ? h('div', { class: 'callout callout-danger' }, icon('lock'), h('div', {}, h('strong', {}, 'Access Denied'), h('p', {}, 'The key is missing, revoked, or lacks the execute scope.'))) : null,
        jsonPanel(body, 'Response'));
    } catch (err) {
      fill(out, h('div', { class: 'callout callout-danger' }, icon('alert'), err.message));
    } finally {
      btn.disabled = false;
    }
  };

  container.append(page('API Playground', 'Call deployed flows exactly as your application will, then copy the request as code.', [],
    h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
      card(h('div', { class: 'stack' },
        h('div', { class: 'grid grid-2' },
          field('Flow', select(flows.map((f) => ({ value: f.id, label: f.name })), state.flowId, (v) => void choose(v))),
          field('Transport', select([{ value: 'graphql', label: 'GraphQL (executeWorkflow)' }, { value: 'rest', label: 'REST (/api/v1/flows/…/execute)' }], state.transport, (v) => (state.transport = v)))),
        h('div', { class: 'grid grid-2' },
          field('Mode', select([{ value: 'realtime', label: 'Realtime (wait for result)' }, { value: 'async', label: 'Async (return requestId)' }], state.mode, (v) => (state.mode = v))),
          field('API key (optional)', input('', (v) => { state.key = v.trim(); drawCode(); }, { type: 'password', placeholder: 'Uses your Studio key when empty', autocomplete: 'off' }))),
        payloadBox,
        h('div', {}, button('Run', { kind: 'primary', icon: 'play', onClick: run })),
        out)),
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Code')), code))));
  await choose(state.flowId);
}

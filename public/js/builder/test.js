import { api } from '../api.js';
import { badge, button, clear, h, icon, jsonPanel, ms, textarea, toast } from '../ui.js';
import { samplePayload, triggerOf, typeOf } from './graph.js';

/**
 * Test panel. Runs the current draft (not the deployment), streams live node status into the canvas,
 * and keeps each node's last output for the config panel.
 */
export function createTester({ flowId, getDefinition, catalog, onStatuses, onNodeOutputs, onSelectNode, beforeRun }) {
  const el = h('div', { class: 'panel-body' });
  const state = { payloadText: null, chat: [], running: false, abort: null, statuses: new Map(), result: null, live: '', diagnostics: [], runId: null };

  const run = async (payload) => {
    if (state.running) return;
    try {
      await beforeRun?.();
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    state.running = true;
    state.result = null;
    state.live = '';
    state.statuses = new Map();
    onStatuses(state.statuses);
    draw();
    let started;
    try {
      started = await api.post(`/api/flows/${flowId}/test`, { payload, definition: getDefinition() });
    } catch (e) {
      state.running = false;
      state.result = { status: 'failed', error: { code: e.code ?? 'ERROR', message: e.message }, diagnostics: e.diagnostics };
      draw();
      return;
    }
    state.runId = started.requestId;
    state.diagnostics = (started.diagnostics ?? []).filter((d) => d.severity === 'warning');
    state.abort = api.stream(`/api/runs/${started.requestId}/events`, undefined, (event, data) => {
      if (event === 'trace' && data.nodeId) {
        if (data.iteration?.length && data.type !== 'node.failed') return;
        const map = state.statuses;
        if (data.type === 'node.start') map.set(data.nodeId, { status: 'running' });
        else if (data.type === 'node.success' || data.type === 'node.reused') map.set(data.nodeId, { status: 'success', durationMs: data.durationMs });
        else if (data.type === 'node.failed') map.set(data.nodeId, { status: 'failed', error: data.error });
        else if (data.type === 'node.skipped') map.set(data.nodeId, { status: 'skipped' });
        onStatuses(map);
      } else if (event === 'node.token') {
        state.live += data.data;
        const box = el.querySelector('.output-tokens, .bubble-pending');
        if (box) box.textContent = state.live;
      } else if (event === 'done') {
        state.result = data;
      }
    }, async (error) => {
      state.running = false;
      state.abort = null;
      if (error) state.result = { status: 'failed', error: { code: 'STREAM', message: error.message } };
      try {
        const log = await api.get(`/api/runs/${state.runId}`);
        onNodeOutputs(new Map((log.nodes ?? []).map((n) => [n.nodeId, n])));
        for (const n of log.nodes ?? []) {
          if (n.status === 'failed' && !state.statuses.has(n.nodeId)) state.statuses.set(n.nodeId, { status: 'failed', error: n.error });
        }
        onStatuses(state.statuses);
      } catch {
        /* the log may lag; outputs stay as streamed */
      }
      if (isChat()) {
        const content = state.result?.output?.content ?? (state.result?.error ? `⚠ ${state.result.error.message}` : '');
        state.chat.push({ role: 'assistant', content: String(content), failed: state.result?.status !== 'success' });
      }
      draw();
    });
    draw();
  };

  const isChat = () => ['chatTriggerNode', 'askTriggerNode'].includes(typeOf(triggerOf(getDefinition(), catalog)));

  const resultView = () => {
    const r = state.result;
    if (!r) return null;
    const nodes = (r.nodes ?? []).filter((n) => n.statusCode !== 0);
    return h('div', { class: 'stack' },
      h('div', { class: 'row' }, badge(r.status, r.status === 'success' ? 'success' : 'danger'), r.timeTakenInSeconds !== undefined ? h('span', { class: 'muted small' }, ms(r.timeTakenInSeconds * 1000)) : null,
        r.usage?.inputTokens || r.usage?.outputTokens ? h('span', { class: 'muted small' }, `${r.usage.inputTokens + r.usage.outputTokens} tokens`) : null,
        h('span', { class: 'grow' }), state.runId ? h('a', { href: `/logs/${state.runId}`, 'data-link': '', class: 'small' }, 'Open log →') : null),
      r.error ? h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, r.error.code), h('p', {}, r.error.message), r.error.nodeId ? button('Show node', { size: 'sm', onClick: () => onSelectNode(r.error.nodeId) }) : null)) : null,
      r.diagnostics?.length ? h('div', { class: 'stack-sm' }, r.diagnostics.map((d) => h('div', { class: `diag diag-${d.severity}`, onClick: () => d.nodeId && onSelectNode(d.nodeId) }, icon('alert', 14), h('span', {}, `${d.code}: ${d.message}`)))) : null,
      !isChat() && r.status === 'success' ? jsonPanel(r.output, 'Response') : null,
      nodes.length ? h('div', {}, h('div', { class: 'field-label' }, 'Nodes'), nodes.map((n) => h('div', { class: 'run-node', onClick: () => onSelectNode(n.nodeId) },
        icon(n.status === 'success' ? 'check' : n.status === 'failed' ? 'alert' : 'dot', 14),
        h('span', { class: 'grow truncate' }, n.nodeName ?? n.nodeId), h('span', { class: 'muted small' }, n.status === 'skipped' ? 'skipped' : ms(n.durationMs))))) : null);
  };

  const draw = () => {
    clear(el);
    const def = getDefinition();
    if (state.diagnostics.length) el.append(h('div', { class: 'stack-sm' }, state.diagnostics.map((d) => h('div', { class: 'diag diag-warning', onClick: () => d.nodeId && onSelectNode(d.nodeId) }, icon('info', 14), h('span', {}, d.message)))));
    if (isChat()) {
      const inputBox = h('textarea', { class: 'input', rows: 2, placeholder: 'Message… (Enter to send)', disabled: state.running });
      const send = () => {
        const text = inputBox.value.trim();
        if (!text) return;
        const history = state.chat.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));
        state.chat.push({ role: 'user', content: text });
        run({ chatMessage: text, message: text, chatHistory: history, sessionId: 'studio-test', userId: 'studio' });
      };
      inputBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      el.append(
        h('div', { class: 'chat-log' }, state.chat.length ? state.chat.map((m) => h('div', { class: ['bubble', m.role === 'user' ? 'bubble-user' : 'bubble-bot'] }, m.content)) : h('p', { class: 'muted' }, 'Chat with your flow. Each message runs the current draft with the conversation so far.'),
          state.running ? h('div', { class: 'bubble bubble-bot bubble-pending' }, state.live || '…') : null),
        h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { class: 'grow' }, inputBox), button('', { icon: 'play', kind: 'primary', title: 'Send', disabled: state.running, onClick: send })),
        state.chat.length ? button('Clear conversation', { size: 'sm', kind: 'ghost', onClick: () => { state.chat = []; state.result = null; draw(); } }) : null,
        resultView());
      setTimeout(() => inputBox.focus());
    } else {
      state.payloadText ??= JSON.stringify(samplePayload(def, catalog), null, 2);
      const area = textarea(state.payloadText, (v) => (state.payloadText = v), { mono: true, rows: 8 });
      el.append(
        h('div', { class: 'field-label' }, 'Input payload'), area,
        h('div', { class: 'row' },
          state.running
            ? button('Stop', { icon: 'stop', kind: 'danger', onClick: async () => { if (state.runId) await api.post(`/api/runs/${state.runId}/cancel`).catch(() => {}); } })
            : button('Run test', { icon: 'play', kind: 'primary', onClick: () => {
              let payload;
              try {
                payload = JSON.parse(state.payloadText || '{}');
              } catch {
                return toast('The payload is not valid JSON', 'error');
              }
              run(payload);
            } }),
          button('Reset payload', { kind: 'ghost', size: 'sm', onClick: () => { state.payloadText = null; draw(); } })),
        state.running ? h('div', {}, h('div', { class: 'row muted small' }, h('span', { class: 'spinner' }), 'Running…'), h('div', { class: 'output-tokens' }, state.live)) : null,
        resultView());
    }
    const trigger = triggerOf(def, catalog);
    if (!trigger) el.prepend(h('div', { class: 'callout callout-warning' }, icon('alert'), 'Add a trigger node to run this flow.'));
  };
  draw();
  return { el, refresh: draw, stop: () => state.abort?.() };
}

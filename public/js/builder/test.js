import { api } from '../api.js';
import { createRunView } from '../runview.js';
import { button, clear, h, icon, input, textarea, toast } from '../ui.js';
import { nodeName, runOrder, samplePayload, triggerOf, typeOf } from './graph.js';

/**
 * Test panel. Runs the current draft (never the deployment), streams each step's status into the canvas and
 * this panel, and keeps every step's last output for the inspector.
 */
export function createTester({ flowId, getDefinition, catalog, onStatuses, onNodeOutputs, onSelectNode, beforeRun }) {
  const el = h('div', { class: 'panel-body' });
  const state = { payloadText: null, form: null, json: false, chat: [], view: null, diagnostics: [], runId: null };

  const isChat = () => ['chatTriggerNode', 'askTriggerNode'].includes(typeOf(triggerOf(getDefinition(), catalog)));
  const running = () => !!state.view?.running;

  const run = async (payload) => {
    if (running()) return;
    try {
      await beforeRun?.();
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    const def = getDefinition();
    const steps = runOrder(def).filter(Boolean).map((n) => ({ id: n.id, name: nodeName(n, catalog), type: typeOf(n) }));
    state.view?.stop();
    state.view = createRunView({ steps, onSelectNode, compact: isChat(), onStatuses: (map) => onStatuses(new Map([...map].map(([id, s]) => [id, { status: s.status, durationMs: s.durationMs }]))) });
    state.view.onFinish((result, detail) => {
      if (detail?.nodes) onNodeOutputs(new Map(detail.nodes.map((n) => [n.nodeId, { ...n, explanation: detail.nodeExplanations?.[n.nodeId] }])));
      if (isChat()) {
        const content = result?.status === 'success' ? (result.output?.content ?? (typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? ''))) : (detail?.explanation?.title ?? result?.error?.message ?? 'The run failed.');
        state.chat.push({ role: 'assistant', content: String(content), failed: result?.status !== 'success' });
      }
      draw();
    });
    draw();
    let started;
    try {
      started = await api.post(`/api/flows/${flowId}/test`, { payload, definition: def });
    } catch (e) {
      state.view.stop();
      state.view = null;
      state.startError = e;
      draw();
      return;
    }
    state.startError = null;
    state.runId = started.requestId;
    state.diagnostics = (started.diagnostics ?? []).filter((d) => d.severity === 'warning');
    state.view.start(started.requestId);
    draw();
  };

  const startErrorView = () => {
    const e = state.startError;
    if (!e) return null;
    const diags = e.diagnostics ?? e.body?.errors?.[0]?.extensions?.diagnostics ?? [];
    return h('div', { class: 'explain', role: 'alert' }, h('h3', {}, icon('alert', 16), diags.length ? 'Fix these before testing' : 'The test could not start'),
      diags.length ? h('div', { class: 'stack-sm' }, diags.filter((d) => d.severity === 'error').map((d) => h('div', { class: 'diag diag-error', onClick: () => d.nodeId && onSelectNode(d.nodeId) }, icon('alert', 14), h('span', {}, d.message)))) : h('p', {}, e.message));
  };

  const payloadFields = () => {
    const sample = samplePayload(getDefinition(), catalog);
    const simple = Object.values(sample).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
    return simple ? Object.keys(sample) : null;
  };

  const runFromInputs = () => {
    let payload;
    if (state.json || !state.form) {
      try {
        payload = JSON.parse(state.payloadText || '{}');
      } catch {
        return toast('The input is not valid JSON', 'error');
      }
    } else payload = { ...state.form };
    void run(payload);
  };

  const draw = () => {
    clear(el);
    const def = getDefinition();
    const trigger = triggerOf(def, catalog);
    if (!trigger) {
      el.append(h('div', { class: 'callout callout-warning' }, icon('alert'), h('div', {}, h('strong', {}, 'Add a trigger first'), h('p', {}, 'A trigger decides how the workflow starts: an API request, chat message, schedule or file.'))));
      return;
    }
    if (state.diagnostics.length) el.append(h('div', { class: 'stack-sm' }, state.diagnostics.map((d) => h('div', { class: 'diag diag-warning', onClick: () => d.nodeId && onSelectNode(d.nodeId) }, icon('info', 14), h('span', {}, d.message)))));
    if (isChat()) {
      const inputBox = h('textarea', { class: 'input', rows: 2, placeholder: 'Type a message, then press Enter', 'aria-label': 'Message', disabled: running() });
      const send = () => {
        const text = inputBox.value.trim();
        if (!text) return;
        const history = state.chat.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));
        state.chat.push({ role: 'user', content: text });
        void run({ chatMessage: text, message: text, chatHistory: history, sessionId: 'studio-test', userId: 'studio' });
      };
      inputBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      el.append(
        h('div', { class: 'chat-log', role: 'log', 'aria-label': 'Conversation' }, state.chat.length ? state.chat.map((m) => h('div', { class: ['bubble', m.role === 'user' ? 'bubble-user' : 'bubble-bot', m.failed ? 'failed' : ''] }, m.failed ? [icon('alert', 13), ' '] : null, m.content)) : h('p', { class: 'muted' }, 'Chat with your workflow. Each message runs the current draft with the conversation so far.'),
          running() ? h('div', { class: 'bubble bubble-bot' }, h('span', { class: 'spinner', style: { width: '12px', height: '12px' } })) : null),
        h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { class: 'grow' }, inputBox), running()
          ? button('', { icon: 'stop', kind: 'danger', title: 'Stop', onClick: async () => { if (state.runId) await api.post(`/api/runs/${state.runId}/cancel`).catch(() => {}); } })
          : button('', { icon: 'play', kind: 'primary', title: 'Send (Enter)', onClick: send })),
        state.chat.length ? button('Clear conversation', { size: 'sm', kind: 'ghost', onClick: () => { state.chat = []; state.view?.clear(); state.view = null; draw(); } }) : null,
        startErrorView(),
        state.view ? h('details', { open: true }, h('summary', { class: 'field-label', style: { cursor: 'pointer' } }, 'What happened in the last message'), h('div', { style: { marginTop: '8px' } }, state.view.el)) : null);
      if (!running()) setTimeout(() => inputBox.focus());
    } else {
      const fields = payloadFields();
      if (fields && !state.form) state.form = Object.fromEntries(Object.entries(samplePayload(def, catalog)).map(([k, v]) => [k, typeof v === 'string' && !v ? (k === 'message' ? 'Hello, Jasmine' : '') : v]));
      state.payloadText ??= JSON.stringify(state.form ?? samplePayload(def, catalog), null, 2);
      const useForm = fields && fields.length && !state.json;
      const label = typeOf(trigger) === 'cronNode' || typeOf(trigger) === 'localFolderNode' || typeOf(trigger) === 'sourceTriggerNode' ? 'Run once now' : 'Run test';
      el.append(
        h('div', { class: 'row spread' }, h('div', { class: 'field-label' }, 'Input'),
          fields?.length ? button(useForm ? 'Edit as JSON' : 'Use simple form', { size: 'sm', kind: 'ghost', onClick: () => { if (!state.json) state.payloadText = JSON.stringify(state.form, null, 2); else { try { state.form = JSON.parse(state.payloadText); } catch { /* keep form */ } } state.json = !state.json; draw(); } }) : null),
        useForm
          ? h('div', { class: 'stack-sm' }, fields.map((k) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, k), input(String(state.form[k] ?? ''), (v) => { state.form[k] = typeof samplePayload(def, catalog)[k] === 'number' ? Number(v) : v; }, { onKeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runFromInputs(); } }))))
          : textarea(state.payloadText, (v) => (state.payloadText = v), { mono: true, rows: 7 }),
        h('div', { class: 'row' },
          running()
            ? button('Stop', { icon: 'stop', kind: 'danger', onClick: async () => { if (state.runId) await api.post(`/api/runs/${state.runId}/cancel`).catch(() => {}); } })
            : button(label, { icon: 'play', kind: 'primary', title: `${label} (Ctrl+Enter)`, onClick: runFromInputs }),
          button('Reset input', { kind: 'ghost', size: 'sm', onClick: () => { state.payloadText = null; state.form = null; draw(); } }),
          h('span', { class: 'muted small grow', style: { textAlign: 'right' } }, 'Runs the draft, not the deployment')),
        startErrorView(),
        state.view ? state.view.el : null);
    }
  };
  draw();
  return {
    el,
    refresh: draw,
    runNow: () => { if (!isChat()) runFromInputs(); },
    stop: () => state.view?.stop(),
  };
}

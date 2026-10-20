import { api } from './api.js';
import { explanationCard } from './shared.js';
import { badge, button, clear, copyButton, fill, h, icon, jsonPanel, ms, num } from './ui.js';

/**
 * Live view of one run: which step is executing, what succeeded or failed, elapsed time, model and token use,
 * streamed text, the final result and, on failure, an explanation. It shows what the engine reports and
 * nothing else: a failed run is never presented as a success.
 */
export function createRunView({ steps = [], onSelectNode, compact = false, onStatuses } = {}) {
  const el = h('div', { class: 'stack', 'aria-live': 'polite' });
  const state = { requestId: null, status: 'idle', t0: 0, elapsed: 0, nodes: new Map(), tokens: '', thinking: 0, thinkingNode: null, result: null, detail: null, timer: null, abort: null, listeners: [] };
  const order = steps.map((s) => s.id);
  const names = new Map(steps.map((s) => [s.id, s.name]));

  const stepIcon = (st) => st === 'running' ? h('span', { class: 'spinner', style: { width: '13px', height: '13px' } })
    : st === 'success' ? icon('check', 12) : st === 'failed' ? icon('close', 12) : st === 'skipped' || st === 'cancelled' ? icon('minus', 12) : icon('dot', 12);
  const label = { pending: 'Waiting', running: 'Running', success: 'Done', failed: 'Failed', skipped: 'Skipped (branch not taken)', cancelled: 'Stopped because an earlier step failed' };

  const textOutput = (output) => {
    if (typeof output === 'string') return output;
    if (output && typeof output === 'object') for (const k of ['content', 'answer', 'summary', 'reply', 'result', 'digest', 'text', 'message']) if (typeof output[k] === 'string' && output[k].trim()) return output[k];
    return null;
  };

  const draw = () => {
    onStatuses?.(state.nodes);
    const r = state.result;
    const detail = state.detail;
    const status = r ? (r.status === 'success' ? 'success' : 'failed') : state.status;
    const usage = detail ? { inputTokens: detail.inputTokens, outputTokens: detail.outputTokens, llmCalls: detail.llmCalls } : r?.usage;
    const models = detail?.models ?? r?.models ?? [];
    const ids = [...order, ...[...state.nodes.keys()].filter((id) => !order.includes(id))];
    const visible = compact ? ids.filter((id) => state.nodes.has(id)) : ids;
    fill(el,
      h('div', { class: 'run-summary' },
        status === 'running' ? badge('Running', 'info') : status === 'success' ? badge('Succeeded', 'success') : status === 'failed' ? badge(r?.error?.code === 'CANCELLED' ? 'Cancelled' : 'Failed', 'danger') : badge('Ready', 'neutral'),
        h('span', {}, icon('clock', 13), ' ', h('strong', { 'data-elapsed': status === 'running' ? '' : undefined }, ms(r?.timeTakenInSeconds !== undefined ? r.timeTakenInSeconds * 1000 : state.elapsed))),
        usage && (usage.inputTokens || usage.outputTokens) ? h('span', { title: `${num(usage.inputTokens)} in · ${num(usage.outputTokens)} out` }, h('strong', {}, num((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))), ' tokens') : null,
        models.length ? h('span', { class: 'truncate', title: models.join(', ') }, icon('models', 13), ' ', models.join(', ')) : null,
        state.requestId && status !== 'running' ? h('a', { href: `/logs/${state.requestId}`, 'data-link': '', class: 'small', style: { marginLeft: 'auto' } }, 'Full trace →') : null),
      visible.length ? h('ol', { class: 'run-steps', 'aria-label': 'Steps' }, visible.map((id) => {
        const n = state.nodes.get(id) ?? { status: 'pending' };
        const record = detail?.nodes?.find?.((x) => x.nodeId === id);
        const tokens = record?.usage ? (record.usage.inputTokens ?? 0) + (record.usage.outputTokens ?? 0) : 0;
        const running = n.status === 'running' ? Math.max(0, performance.now() - n.started) : null;
        return h('li', { class: ['run-step', n.status], role: onSelectNode ? 'button' : undefined, tabindex: onSelectNode ? 0 : undefined, title: label[n.status] ?? n.status,
          onClick: () => onSelectNode?.(id), onKeydown: (e) => { if (e.key === 'Enter') onSelectNode?.(id); } },
          h('span', { class: 'st', 'aria-hidden': 'true' }, stepIcon(n.status)),
          h('span', { class: 'truncate' }, names.get(id) ?? id, h('span', { class: 'sr-only' }, `: ${label[n.status] ?? n.status}`)),
          h('span', { class: 'meta', 'data-started': running !== null ? String(n.started) : undefined }, n.status === 'skipped' ? 'skipped' : n.status === 'cancelled' ? 'stopped' : running !== null ? ms(running) : n.durationMs !== undefined ? ms(n.durationMs) : '', tokens ? ` · ${num(tokens)} tok` : '', n.attempts > 1 ? ` · ${n.attempts} tries` : ''));
      })) : null,
      state.tokens ? h('div', { class: 'output-tokens', 'aria-label': 'Streaming output' }, state.tokens)
        : state.thinking && status === 'running' ? h('div', { class: 'output-tokens muted', role: 'status' }, `The model is thinking before it answers (${num(state.thinking)} characters of reasoning so far)…`) : null,
      r && r.status === 'success' ? resultView(r.output) : null,
      r && r.status !== 'success' ? (detail?.explanation ? explanationCard(detail.explanation, { onShowNode: detail.explanation && r.error?.nodeId && onSelectNode ? () => onSelectNode(r.error.nodeId) : undefined })
        : h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, r.error?.code ?? 'Failed'), h('p', {}, r.error?.message ?? 'The run failed.')))) : null);
  };

  const resultView = (output) => {
    const text = textOutput(output);
    let showJson = text === null;
    const box = h('div', { class: 'stack-sm' });
    const paint = () => fill(box,
      h('div', { class: 'row spread' }, h('div', { class: 'field-label' }, 'Result'),
        h('div', { class: 'row' }, text !== null ? button(showJson ? 'Show text' : 'Show JSON', { size: 'sm', kind: 'ghost', onClick: () => { showJson = !showJson; paint(); } }) : null, copyButton(() => (showJson || text === null ? JSON.stringify(output, null, 2) : text)))),
      showJson ? jsonPanel(output ?? null, 'Output') : h('div', { class: 'text-output' }, text));
    paint();
    return box;
  };

  const finish = async (data) => {
    clearInterval(state.timer);
    state.result = data;
    state.status = data?.status === 'success' ? 'success' : 'failed';
    try {
      state.detail = await api.get(`/api/runs/${encodeURIComponent(state.requestId)}`);
      for (const n of state.detail.nodes ?? []) {
        const known = state.nodes.get(n.nodeId);
        if (!known || known.status === 'running' || known.status === 'pending') state.nodes.set(n.nodeId, { status: n.status, durationMs: n.durationMs, attempts: n.attempts });
      }
    } catch { /* the log can lag behind the stream; the streamed state stays */ }
    draw();
    for (const fn of state.listeners) fn(state.result, state.detail);
  };

  const start = (requestId) => {
    state.abort?.();
    Object.assign(state, { requestId, status: 'running', t0: performance.now(), elapsed: 0, nodes: new Map(), tokens: '', thinking: 0, thinkingNode: null, result: null, detail: null });
    clearInterval(state.timer);
    // The clock ticks in place so focus and screen-reader position survive while a run is live.
    state.timer = setInterval(() => {
      state.elapsed = performance.now() - state.t0;
      const clock = el.querySelector('[data-elapsed]');
      if (clock) clock.textContent = ms(state.elapsed);
      for (const meta of el.querySelectorAll('[data-started]')) meta.firstChild && (meta.firstChild.textContent = ms(performance.now() - Number(meta.dataset.started)));
    }, 250);
    draw();
    state.abort = api.stream(`/api/runs/${encodeURIComponent(requestId)}/events`, undefined, (event, data) => {
      if (event === 'trace' && data.nodeId) {
        if (data.iteration?.length && data.type !== 'node.failed') return;
        const prev = state.nodes.get(data.nodeId);
        if (data.type === 'node.start') state.nodes.set(data.nodeId, { status: 'running', started: performance.now(), attempts: (prev?.attempts ?? 0) + 1 });
        else if (data.type === 'node.retry') {
          // The retry streams its answer again from the start.
          state.nodes.set(data.nodeId, { ...prev, status: 'running' });
          Object.assign(state, { tokens: '', thinking: 0 });
        }
        else if (data.type === 'node.success' || data.type === 'node.reused') state.nodes.set(data.nodeId, { ...prev, status: 'success', durationMs: data.durationMs });
        else if (data.type === 'node.failed') state.nodes.set(data.nodeId, { ...prev, status: 'failed', durationMs: data.durationMs, error: data.error });
        else if (data.type === 'node.cancelled') state.nodes.set(data.nodeId, { ...prev, status: 'cancelled', durationMs: data.durationMs });
        else if (data.type === 'node.skipped') state.nodes.set(data.nodeId, { status: 'skipped' });
        draw();
      } else if (event === 'node.progress' && typeof data.data?.thinking === 'number') {
        state.thinking = data.data.thinking;
        state.thinkingNode = data.nodeId ?? state.thinkingNode;
        draw();
      } else if (event === 'node.token') {
        state.tokens += typeof data.data === 'string' ? data.data : '';
        draw();
      } else if (event === 'done') {
        void finish(data);
      }
    }, (error) => {
      state.abort = null;
      if (error && !state.result) void finish({ status: 'failed', error: { code: error.code ?? 'STREAM', message: `Lost the live connection: ${error.message}. The run may still finish; open its trace in Runs.` } });
    });
  };

  draw();
  return {
    el,
    start,
    onFinish: (fn) => state.listeners.push(fn),
    get running() { return state.status === 'running'; },
    get requestId() { return state.requestId; },
    get detail() { return state.detail; },
    /** The step whose model thought, how much, and how long it took; null when no step reported thinking. */
    get thinking() { return state.thinkingNode ? { nodeId: state.thinkingNode, chars: state.thinking, durationMs: state.nodes.get(state.thinkingNode)?.durationMs } : null; },
    stop: () => { state.abort?.(); clearInterval(state.timer); },
    clear: () => { state.abort?.(); clearInterval(state.timer); clear(el); },
  };
}

import { api, catalog } from '../api.js';
import { button, card, copyButton, dateTime, downloadFile, field, fill, h, input, modal, textarea, icon, jsonPanel, ms, num, page, pretty, statusBadge, tabs, toast } from '../ui.js';
import { explanationCard, nodeIcon } from '../shared.js';

const END_TYPES = new Set(['node.success', 'node.failed', 'node.cancelled', 'node.reused']);

/** Turns trace events into one bar per node execution (per loop iteration). */
function timeline(trace) {
  const t0 = trace.find((e) => e.type === 'run.start')?.ts ?? trace[0]?.ts ?? 0;
  const rows = [];
  const open = new Map();
  const key = (e) => `${e.nodeId}|${(e.iteration ?? []).join('.')}`;
  for (const e of trace) {
    if (!e.nodeId) continue;
    if (e.type === 'node.start') {
      const row = { nodeId: e.nodeId, nodeType: e.nodeType, iteration: e.iteration, start: e.ts - t0, end: null, status: 'running', attempts: 1, events: [e] };
      rows.push(row);
      open.set(key(e), row);
    } else if (e.type === 'node.skipped') {
      rows.push({ nodeId: e.nodeId, nodeType: e.nodeType, iteration: e.iteration, start: e.ts - t0, end: e.ts - t0, status: 'skipped', attempts: 0, events: [e] });
    } else {
      const row = open.get(key(e));
      if (!row) continue;
      row.events.push(e);
      if (e.type === 'node.retry') row.attempts = (e.attempt ?? row.attempts) + 1;
      if (END_TYPES.has(e.type)) {
        row.status = e.type.slice(5);
        row.end = e.durationMs !== undefined ? row.start + e.durationMs : e.ts - t0;
        row.output = e.output;
        row.error = e.error;
        row.statusCode = e.statusCode;
        open.delete(key(e));
      }
    }
  }
  return rows;
}

export async function render(container, { id }, { navigate }) {
  let stop = null;
  let selected = null;
  let tab = 'output';
  const cat = await catalog();
  const load = async () => {
    const [run, flows] = await Promise.all([api.get(`/api/runs/${encodeURIComponent(id)}`), api.get('/api/flows').catch(() => [])]);
    const flow = flows.find((f) => f.id === run.flowId);
    const rows = timeline(run.trace ?? []);
    const total = Math.max(run.durationMs ?? 0, ...rows.map((r) => r.end ?? r.start), 1);
    const nodes = Array.isArray(run.nodes) ? run.nodes : [];
    selected ??= rows.find((r) => r.status === 'failed') ?? rows.find((r) => r.status !== 'skipped') ?? null;

    const detail = h('div', { class: 'stack' });
    const drawDetail = () => {
      if (!selected) return fill(detail, h('p', { class: 'muted' }, 'Select a node to see its output.'));
      const spec = cat.byType.get(selected.nodeType);
      const summary = nodes.find((n) => n.nodeId === selected.nodeId);
      fill(detail, 
        h('div', { class: 'row' }, nodeIcon(spec, 30), h('div', { class: 'grow' }, h('h3', {}, spec?.label ?? selected.nodeType), h('code', { class: 'small muted' }, selected.nodeId)), statusBadge(selected.status)),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Duration'), h('dd', {}, selected.end !== null ? ms(selected.end - selected.start) : 'running…'),
          h('dt', {}, 'Started at'), h('dd', {}, `+${ms(selected.start)}`),
          selected.iteration?.length ? h('dt', {}, 'Iteration') : null, selected.iteration?.length ? h('dd', {}, selected.iteration.map((i) => i + 1).join(' › ')) : null,
          h('dt', {}, 'Attempts'), h('dd', {}, String(selected.attempts)),
          selected.statusCode ? h('dt', {}, 'Status code') : null, selected.statusCode ? h('dd', {}, String(selected.statusCode)) : null,
          summary?.usage?.llmCalls ? h('dt', {}, 'Model usage') : null, summary?.usage?.llmCalls ? h('dd', {}, `${summary.usage.llmCalls} call(s) · ${num(summary.usage.inputTokens)} in / ${num(summary.usage.outputTokens)} out tokens`) : null),
        selected.error ? (run.nodeExplanations?.[selected.nodeId] && selected.status === 'failed' ? explanationCard(run.nodeExplanations[selected.nodeId]) : h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, selected.error.code), h('p', {}, selected.error.message)))) : null,
        flow && selected.status === 'failed' ? h('a', { href: `/flows/${encodeURIComponent(run.flowId)}?node=${encodeURIComponent(selected.nodeId)}`, 'data-link': '', class: 'btn btn-sm btn-secondary' }, icon('edit', 14), h('span', {}, 'Open this step in the builder')) : null,
        tabs([{ id: 'output', label: 'Output' }, { id: 'events', label: `Events (${selected.events.length})` }], tab, (t) => { tab = t; drawDetail(); }),
        tab === 'output'
          ? (selected.output !== undefined ? jsonPanel(selected.output, 'Output') : summary?.output !== undefined ? jsonPanel(summary.output, rows.filter((r) => r.nodeId === selected.nodeId).length > 1 ? 'Output (last iteration)' : 'Output') : h('p', { class: 'muted' }, selected.status === 'skipped' ? 'Skipped: this branch was not taken.' : 'No output recorded.'))
          : h('div', { class: 'trace-list' }, selected.events.map((e) => h('div', { class: 'trace-row' }, h('span', { class: 'muted' }, `+${ms(e.ts - (run.trace[0]?.ts ?? e.ts))}`), h('span', {}, e.type), h('span', { class: 'truncate' }, e.error?.message ?? e.message ?? (e.delayMs ? `retry in ${ms(e.delayMs)}` : e.statusCode ? `status ${e.statusCode}` : ''))))));
    };
    drawDetail();

    const waterfall = h('div', { class: 'waterfall' }, rows.length ? rows.map((r) => {
      const spec = cat.byType.get(r.nodeType);
      const end = r.end ?? total;
      return h('div', { class: ['wf-row', selected === r ? 'selected' : ''], role: 'button', tabindex: 0, onClick: (e) => {
        selected = r;
        tab = 'output';
        waterfall.querySelectorAll('.wf-row').forEach((el) => el.classList.remove('selected'));
        e.currentTarget.classList.add('selected');
        drawDetail();
      } },
      h('div', { class: 'row truncate' }, nodeIcon(spec, 20), h('span', { class: 'truncate' }, spec?.label ?? r.nodeType), r.iteration?.length ? h('span', { class: 'muted small' }, `#${r.iteration.map((i) => i + 1).join('.')}`) : null),
      h('div', { class: 'wf-track' }, h('div', { class: ['wf-bar', r.status], style: { left: `${(r.start / total) * 100}%`, width: `${Math.max(0.4, ((end - r.start) / total) * 100)}%` } })),
      h('div', { class: 'num small' }, r.status === 'skipped' ? h('span', { class: 'muted' }, 'skipped') : r.end === null ? h('span', { class: 'spinner' }) : ms(r.end - r.start)));
    }) : h('p', { class: 'muted' }, 'No node events recorded.'));

    const error = run.error ?? (run.errorMessage ? { code: run.errorCode, message: run.errorMessage } : null);
    fill(container, page(flow?.name ?? run.flowId,
      h('span', { class: 'row row-wrap' }, statusBadge(run.status), h('span', {}, dateTime(run.startedAt)), h('span', { class: 'muted' }, `· ${run.source} · ${run.mode} · version ${run.version?.slice(0, 12) ?? '—'}`)),
      [
        run.status === 'in-progress' ? button('Cancel', { icon: 'stop', kind: 'danger', onClick: async () => { await api.post(`/api/runs/${encodeURIComponent(id)}/cancel`); toast('Cancellation requested', 'info'); } }) : null,
        ['failed', 'error', 'cancelled'].includes(run.status) ? button('Retry', { icon: 'refresh', title: 'Run again with the same input; successful nodes are reused when their input is unchanged', onClick: async () => {
          try {
            const res = await api.post(`/api/runs/${encodeURIComponent(id)}/retry`);
            navigate(`/logs/${res.requestId}`);
          } catch (e) {
            toast(e.message, 'error');
          }
        } }) : null,
        button('Give feedback',{onClick:()=>{let rating='5',comment='';modal({title:'Run feedback',body:h('div',{class:'stack'},field('Rating (0–255)',input(rating,v=>rating=v,{type:'number',min:0,max:255})),field('Comment',textarea('',v=>comment=v))),actions:[{label:'Cancel',onClick:close=>close()},{label:'Save',kind:'primary',onClick:async close=>{try{await api.post('/api/feedback',{requestId:id,rating:Number(rating),comment});toast('Feedback saved','success');close();}catch(e){toast(e.message,'error');}}}]});}}),
        button('Export trace', { icon: 'download', title: 'OpenTelemetry-style spans as JSON', onClick: async () => downloadFile(`run-${id}.otel.json`, pretty(await api.get(`/api/runs/${encodeURIComponent(id)}/otel`))) }),
        flow ? button('Open flow', { icon: 'edit', onClick: () => navigate(`/flows/${encodeURIComponent(run.flowId)}`) }) : null,
      ].filter(Boolean),
      run.feedback?.length ? card(h('h3',{},'Feedback'),...run.feedback.map(f=>h('p',{},`${f.rating??'unrated'} · ${f.comment||'No comment'}`))) : null,
      h('div', { class: 'row small muted' }, 'Request ID ', h('code', {}, run.id), copyButton(run.id), run.retryOf ? h('span', {}, ' · retry of ', h('a', { href: `/logs/${run.retryOf}`, 'data-link': '' }, run.retryOf.slice(0, 8))) : null),
      h('div', { class: 'grid grid-4 stats' },
        stat('Duration', ms(run.durationMs)),
        stat('Steps', String(rows.filter((r) => r.status !== 'skipped').length), `${rows.filter((r) => r.status === 'skipped').length} skipped`),
        stat('Model calls', num(run.llmCalls), run.models?.length ? run.models.join(', ') : 'none'),
        stat('Tokens', num(run.inputTokens + run.outputTokens), `${num(run.inputTokens)} in · ${num(run.outputTokens)} out`)),
      run.explanation ? explanationCard(run.explanation, { onShowNode: run.explanation && error?.nodeId ? () => { selected = rows.find((r) => r.nodeId === error.nodeId && r.status === 'failed') ?? rows.find((r) => r.nodeId === error.nodeId) ?? selected; tab = 'output'; drawDetail(); detail.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); } : undefined })
        : error ? h('div', { class: 'callout callout-danger' }, icon('alert'), h('div', {}, h('strong', {}, error.code ?? 'Error'), h('p', {}, error.message), error.nodeId ? h('p', { class: 'small' }, `Step: ${error.nodeId}`) : null)) : null,
      h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
        card(h('div', { class: 'card-head' }, h('h2', {}, 'Timeline'), h('span', { class: 'muted small' }, ms(total))), waterfall),
        card(detail)),
      h('div', { class: 'grid grid-2', style: { alignItems: 'start' } }, jsonPanel(run.input ?? null, 'Input'), jsonPanel(run.output ?? null, 'Output'))));

    if (run.status === 'in-progress' && !stop) {
      stop = api.stream(`/api/runs/${encodeURIComponent(id)}/events`, undefined, (event) => {
        if (event === 'trace' || event === 'done') refresh();
      }, () => { stop = null; void load(); });
    }
  };
  let pending = null;
  const refresh = () => {
    pending ??= setTimeout(() => { pending = null; void load(); }, 400);
  };
  await load();
  return () => {
    stop?.();
    clearTimeout(pending);
  };
}

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), note ? h('div', { class: 'stat-note truncate', title: note }, note) : null);
}

import { api } from '../api.js';
import { card, emptyState, fill, h, ms, num, page, select, table, timeAgo } from '../ui.js';
import { barList, columnChart, compact, lineChart } from '../charts.js';

const RANGES = [{ value: '1', label: 'Last 24 hours' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }];

/** Every bucket in the range, so quiet periods show as zero instead of disappearing. */
function buckets(from, to, hourly) {
  const step = hourly ? 3_600_000 : 86_400_000;
  const start = new Date(from);
  if (hourly) start.setUTCMinutes(0, 0, 0);
  else start.setUTCHours(0, 0, 0, 0);
  const out = [];
  for (let t = start.getTime(); t <= Date.parse(to); t += step) out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  return out;
}

export async function render(container, _params, { navigate, query }) {
  const flows = await api.get('/api/flows');
  const f = { days: query.get('days') ?? '7', flowId: query.get('flowId') ?? '' };
  const body = h('div', { class: 'stack' });

  const draw = async () => {
    const hourly = Number(f.days) <= 2;
    const p = new URLSearchParams({ days: f.days, bucket: hourly ? 'hour' : 'day' });
    if (f.flowId) p.set('flowId', f.flowId);
    history.replaceState(null, '', `/reports?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
    body.style.opacity = '0.6';
    const r = await api.get(`/api/reports?${p}`);
    body.style.opacity = '';
    const t = r.totals;
    if (!t.runs) {
      fill(body, emptyState('reports', 'No runs in this period', 'Reports fill in as flows run. Test a flow in the builder or call a deployed flow.'));
      return;
    }
    const byKey = new Map(r.series.map((s) => [s.t, s]));
    const series = buckets(r.range.from, r.range.to, hourly).map((key) => {
      const s = byKey.get(key);
      return { t: key, success: s ? s.runs - s.failed : 0, failed: s?.failed ?? 0, avg: s?.avg ?? null, tokens: s?.tokens ?? 0 };
    });
    const labelFor = (d) => (hourly ? new Date(d.t).toLocaleTimeString(undefined, { hour: 'numeric' }) : new Date(d.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    const tipFor = (d) => (hourly ? new Date(d.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : new Date(d.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
    const flowName = (id) => flows.find((x) => x.id === id)?.name ?? id;

    fill(body, 
      h('div', { class: 'grid grid-4' },
        stat('Runs', compact(t.runs), `${num(t.success)} succeeded · ${num(t.failed)} failed`),
        stat('Success rate', t.successRate === null ? '—' : `${(t.successRate * 100).toFixed(1)}%`, t.failed ? `${num(t.failed)} failed or cancelled` : 'no failures'),
        stat('Latency (p50)', ms(t.p50Ms), `p95 ${ms(t.p95Ms)} · p99 ${ms(t.p99Ms)}`),
        stat('Tokens', compact(t.inputTokens + t.outputTokens), `${compact(t.inputTokens)} in · ${compact(t.outputTokens)} out · ${num(t.llmCalls)} model calls`)),
      h('div', { class: 'grid grid-2' },
        card(columnChart({ title: 'Runs', series: [{ key: 'success', label: 'Succeeded', color: 'var(--viz-1)' }, { key: 'failed', label: 'Failed', color: 'var(--viz-critical)' }], data: series, labelFor, tipFor })),
        card(lineChart({ title: 'Average duration', label: 'Avg duration', color: 'var(--viz-1)', data: series, valueKey: 'avg', labelFor, tipFor, format: (v) => ms(v) }))),
      h('div', { class: 'grid grid-2' },
        card(columnChart({ title: 'Tokens', series: [{ key: 'tokens', label: 'Tokens', color: 'var(--viz-1)' }], data: series, labelFor, tipFor })),
        card(h('div', { class: 'card-head' }, h('h2', {}, 'Runs by flow')),
          barList(r.byFlow.map((x) => ({ label: flowName(x.flowId), value: x.runs, title: `${x.failed} failed · avg ${ms(x.avg)}` }))))),
      h('div', { class: 'grid grid-2' },
        card(h('div', { class: 'card-head' }, h('h2', {}, 'Runs by source')), barList(r.bySource.map((x) => ({ label: x.source, value: x.runs })))),
        card(h('div', { class: 'card-head' }, h('h2', {}, 'Tokens by model')), r.byModel.length ? barList(r.byModel.map((x) => ({ label: x.model, value: x.tokens, title: `${x.runs} runs` }))) : h('p', { class: 'muted' }, 'No model calls in this period.'))),
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Flows')),
        table([
          { label: 'Flow', render: (x) => h('span', { class: 'cell-title' }, flowName(x.flowId)) },
          { label: 'Runs', class: 'num', render: (x) => num(x.runs) },
          { label: 'Failed', class: 'num', render: (x) => (x.failed ? h('span', { style: { color: 'var(--danger)' } }, num(x.failed)) : '0') },
          { label: 'Success', class: 'num', render: (x) => `${(((x.runs - x.failed) / x.runs) * 100).toFixed(1)}%` },
          { label: 'Avg duration', class: 'num', render: (x) => ms(x.avg) },
          { label: 'Tokens', class: 'num', render: (x) => num(x.tokens ?? 0) },
        ], r.byFlow, { onRowClick: (x) => navigate(`/logs?flowId=${encodeURIComponent(x.flowId)}`) })),
      h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
        card(h('div', { class: 'card-head' }, h('h2', {}, 'Slowest nodes')),
          table([
            { label: 'Node', render: (x) => h('div', {}, h('div', { class: 'cell-title' }, x.node.split('/').slice(1).join('/')), h('div', { class: 'cell-sub' }, `${flowName(x.node.split('/')[0])} · ${x.nodeType}`)) },
            { label: 'Runs', class: 'num', render: (x) => num(x.runs) },
            { label: 'Failed', class: 'num', render: (x) => num(x.failed) },
            { label: 'Avg', class: 'num', render: (x) => ms(x.avgMs) },
          ], r.slowestNodes, { empty: h('p', { class: 'muted' }, 'No node timings yet.') })),
        card(h('div', { class: 'card-head' }, h('h2', {}, 'Errors')),
          table([
            { label: 'Code', render: (x) => h('code', {}, x.code) },
            { label: 'Message', render: (x) => h('span', { class: 'small' }, x.message ?? '') },
            { label: 'Runs', class: 'num', render: (x) => num(x.runs) },
            { label: 'Last', render: (x) => h('span', { class: 'nowrap muted' }, timeAgo(x.lastAt)) },
          ], r.errors, { onRowClick: () => navigate(`/logs?status=failed${f.flowId ? `&flowId=${encodeURIComponent(f.flowId)}` : ''}`), empty: h('p', { class: 'muted' }, 'No errors in this period.') }))),
    );
  };

  container.append(page('Reports', 'Volume, reliability, latency and model usage across your flows.', [],
    h('div', { class: 'filters' },
      select(RANGES, f.days, (v) => { f.days = v; void draw(); }, { 'aria-label': 'Time range' }),
      select([{ value: '', label: 'All flows' }, ...flows.map((x) => ({ value: x.id, label: x.name }))], f.flowId, (v) => { f.flowId = v; void draw(); }, { 'aria-label': 'Flow' })),
    body));
  await draw();
}

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-note' }, note));
}

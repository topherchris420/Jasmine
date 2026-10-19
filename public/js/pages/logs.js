import { api } from '../api.js';
import { button, debounce, emptyState, fill, h, input, ms, num, page, select, statusBadge, table, timeAgo, toggle } from '../ui.js';

const RANGES = [{ value: '1', label: 'Last 24 hours' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '', label: 'All time' }];
const SOURCES = ['api', 'studio', 'chat', 'ask', 'search', 'webhook', 'cron', 'folder', 'retry', 'flow'];

export async function render(container, _params, { navigate, query }) {
  const flows = await api.get('/api/flows');
  const f = { flowId: query.get('flowId') ?? '', status: query.get('status') ?? '', source: query.get('source') ?? '', search: query.get('search') ?? '', days: query.get('days') ?? '7' };
  let rows = [];
  let next = null;
  let live = false;
  let timer = null;
  const list = h('div');
  const more = h('div', { class: 'row', style: { justifyContent: 'center' } });

  const params = (before) => {
    const p = new URLSearchParams({ limit: '50' });
    for (const k of ['flowId', 'status', 'source', 'search']) if (f[k]) p.set(k, f[k]);
    if (f.days) p.set('from', new Date(Date.now() - Number(f.days) * 86_400_000).toISOString());
    if (before) p.set('before', before);
    return p;
  };
  const syncUrl = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v && !(k === 'days' && v === '7')) p.set(k, v);
    history.replaceState(null, '', `/logs${p.size ? `?${p}` : ''}`);
  };
  const draw = () => {
    fill(list, table([
      { label: 'Started', render: (r) => h('span', { class: 'nowrap', title: new Date(r.startedAt).toLocaleString() }, timeAgo(r.startedAt)) },
      { label: 'Flow', render: (r) => h('div', {}, h('div', { class: 'cell-title' }, flows.find((x) => x.id === r.flowId)?.name ?? r.flowId), h('code', { class: 'cell-sub' }, r.id.slice(0, 8))) },
      { label: 'Status', render: (r) => h('div', { class: 'row' }, statusBadge(r.status), r.retryOf ? h('span', { class: 'muted small' }, 'retry') : null) },
      { label: 'Source', class: 'hide-sm', render: (r) => h('span', { class: 'muted' }, r.source) },
      { label: 'Duration', class: 'num', render: (r) => ms(r.durationMs) },
      { label: 'Tokens', class: 'num hide-sm', render: (r) => (r.inputTokens + r.outputTokens ? num(r.inputTokens + r.outputTokens) : h('span', { class: 'muted' }, '—')) },
      { label: 'Error', class: 'hide-sm', render: (r) => r.errorMessage ? h('span', { class: 'small truncate', style: { color: 'var(--danger)', display: 'block', maxWidth: '280px' }, title: r.errorMessage }, r.errorMessage) : null },
    ], rows, {
      onRowClick: (r) => navigate(`/logs/${r.id}`),
      empty: emptyState('logs', 'No runs match', 'Runs from the API, widgets, webhooks, schedules and the builder\'s Test panel are logged here.'),
    }));
    fill(more, next ? button('Load more', { onClick: async () => {
      const res = await api.get(`/api/runs?${params(next)}`);
      rows = rows.concat(res.runs);
      next = res.nextBefore;
      draw();
    } }) : null);
  };
  const load = async () => {
    syncUrl();
    const res = await api.get(`/api/runs?${params()}`);
    rows = res.runs;
    next = res.nextBefore;
    draw();
  };
  const set = (k) => (v) => { f[k] = v; void load(); };

  container.append(page('Logs', 'Every run with its input, output, per-node timings, model usage and errors.', [
    toggle(false, (on) => {
      live = on;
      clearInterval(timer);
      if (live) timer = setInterval(() => void load(), 4000);
    }, 'Live'),
    button('Refresh', { icon: 'refresh', onClick: () => void load() }),
  ],
  h('div', { class: 'filters' },
    select([{ value: '', label: 'All flows' }, ...flows.map((x) => ({ value: x.id, label: x.name }))], f.flowId, set('flowId'), { 'aria-label': 'Flow' }),
    select([{ value: '', label: 'Any status' }, 'success', 'failed', 'error', 'cancelled', 'in-progress'].map((x) => (typeof x === 'string' ? { value: x, label: x } : x)), f.status, set('status'), { 'aria-label': 'Status' }),
    select([{ value: '', label: 'Any source' }, ...SOURCES.map((s) => ({ value: s, label: s }))], f.source, set('source'), { 'aria-label': 'Source' }),
    select(RANGES, f.days, set('days'), { 'aria-label': 'Time range' }),
    input(f.search, debounce(set('search'), 300), { placeholder: 'Search run id, input or output…', 'aria-label': 'Search', style: 'min-width:240px' })),
  list, more));
  await load();
  return () => clearInterval(timer);
}

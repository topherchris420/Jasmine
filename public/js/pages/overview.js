import { api } from '../api.js';
import { composer } from '../planner.js';
import { lifecycleBadge, triggerChip } from '../shared.js';
import { badge, button, card, fill, h, icon, ms, num, statusBadge, table, timeAgo } from '../ui.js';
import { openCreate } from './flows.js';

export async function render(container, _params, { navigate, query }) {
  const overview = await api.get('/api/overview');
  const attention = h('div', { class: 'attention' }, h('div', { class: 'thinking' }, h('span', { class: 'spinner' }), 'Checking your workspace…'));
  const progress = h('div');
  const flowsBox = h('div');
  const modelsBox = h('div', { class: 'stack-sm' }, h('span', { class: 'spinner' }));
  const w = overview.week;

  container.append(h('div', { class: 'page' },
    h('section', { class: 'hero', 'aria-labelledby': 'home-title' },
      h('span', { class: 'eyebrow' }, `${overview.project.name} · Jasmine`),
      h('h1', { id: 'home-title' }, 'Describe what you want to build.'),
      h('p', { class: 'lede' }, 'Jasmine turns it into a working workflow using your models, documents and tools. You review every step before anything is created, and nothing goes live until you deploy it.'),
      composer({ navigate, initial: query?.get('describe') || undefined }),
      h('div', { class: 'hero-alt' }, h('span', {}, 'Or:'),
        h('a', { href: '/templates', 'data-link': '' }, 'Start from a template'),
        h('a', { href: '#', onClick: (e) => { e.preventDefault(); void openCreate(navigate, 'blank'); } }, 'Start with a blank canvas'),
        h('a', { href: '/setup?path=connect', 'data-link': '' }, 'Connect a model'),
        h('a', { href: '/setup?path=explore', 'data-link': '' }, 'Explore a working demo'))),
    progress,
    h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
      card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Needs attention'), h('p', {}, 'What is failing, offline or waiting on you.'))), attention),
      card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Your workflows'), h('p', {}, `${overview.flows} total · ${overview.deployed} deployed`)), h('a', { href: '/flows', 'data-link': '', class: 'small' }, 'All workflows →')), flowsBox)),
    h('div', { class: 'grid grid-4 stats', role: 'group', 'aria-label': 'Last 7 days' },
      stat('Runs · 7 days', num(w.runs), w.runs ? `${Math.round((w.successRate ?? 0) * 100)}% succeeded` : 'No runs yet'),
      stat('Median latency', ms(w.p50Ms), w.p95Ms ? `p95 ${ms(w.p95Ms)}` : 'Appears after your first run'),
      stat('Tokens · 7 days', num(w.inputTokens + w.outputTokens), `${num(w.llmCalls)} model calls`),
      stat('Knowledge', num(overview.collections), overview.collections ? 'collections' : 'Upload documents under Knowledge')),
    h('div', { class: 'grid grid-2', style: { alignItems: 'start' } },
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Model connections'), h('a', { href: '/models', 'data-link': '', class: 'small' }, 'Manage →')), modelsBox),
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Recent runs'), h('a', { href: '/logs', 'data-link': '', class: 'small' }, 'All runs →')),
        table([
          { label: 'When', render: (r) => h('span', { class: 'nowrap' }, timeAgo(r.startedAt)) },
          { label: 'Workflow', render: (r) => r.flowId },
          { label: 'Source', render: (r) => h('span', { class: 'muted' }, r.source) },
          { label: 'Status', render: (r) => statusBadge(r.status) },
          { label: 'Duration', class: 'num', render: (r) => ms(r.durationMs) },
        ], overview.recent, { onRowClick: (r) => navigate(`/logs/${r.id}`), empty: h('p', { class: 'muted' }, 'Runs appear here as soon as a workflow is tested or called.') })))));

  // Slower checks (model reachability) fill in after the page is usable.
  const [flows, models, alerts] = await Promise.all([
    api.get('/api/flows').catch(() => []),
    api.get('/api/models').catch(() => []),
    api.get('/api/alerts?unread=true&limit=50').catch(() => ({ events: [] })),
  ]);
  const real = models.filter((m) => m.kind !== 'builtin' && m.kind !== 'mock');
  const realChat = real.some((m) => m.ok && m.models.some((x) => x.kind === 'chat'));
  const ranOk = overview.recent.some((r) => r.status === 'success') || (w.success ?? 0) > 0;

  const steps = [
    { done: realChat, label: 'Connect a model', href: '/setup?path=connect' },
    { done: flows.length > 0, label: 'Create a workflow', href: '/' },
    { done: ranOk, label: 'Run a successful test', href: flows[0] ? `/flows/${encodeURIComponent(flows[0].id)}?panel=test` : '/setup?path=explore' },
    { done: overview.deployed > 0, label: 'Deploy it', href: '/deployments' },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done < steps.length) {
    fill(progress, card(h('div', { class: 'row spread row-wrap' },
      h('div', {}, h('h2', {}, 'Your first working application'), h('p', { class: 'small muted', style: { margin: '2px 0 0' } }, `${done} of ${steps.length} done. Each step links to where you finish it.`)),
      h('div', { class: 'progress-track' }, steps.map((s) => h('a', { href: s.href, 'data-link': '', class: ['progress-step', s.done ? 'done' : ''], style: { textDecoration: 'none' } }, h('span', { class: 'dot' }, icon('check', 11)), s.label)))),
    h('div', { class: 'progress-bar', style: { marginTop: '12px' }, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': steps.length, 'aria-valuenow': done, 'aria-label': 'Setup progress' }, h('span', { style: { width: `${(done / steps.length) * 100}%` } }))));
  }

  const items = [];
  for (const f of flows.filter((x) => x.lifecycle?.state === 'failed')) items.push({ kind: 'danger', icon: 'alert', title: `${f.name} needs attention`, detail: f.lifecycle.detail, href: f.lifecycle.runId ? `/logs/${f.lifecycle.runId}` : `/flows/${encodeURIComponent(f.id)}`, action: f.lifecycle.runId ? 'See what failed' : 'Open' });
  for (const m of real.filter((x) => !x.ok)) items.push({ kind: 'warning', icon: 'wifiOff', title: `${m.name} is not reachable`, detail: m.error ?? 'The model server did not answer.', href: `/models?diagnose=${encodeURIComponent(m.connection)}`, action: 'Diagnose' });
  if (!realChat) items.push({ kind: 'info', icon: 'models', title: 'No AI model is connected yet', detail: real.length ? 'Your connections are offline or have no chat model.' : 'Workflows can run with demo responses, but no AI inference happens until you connect a model.', href: '/setup?path=connect', action: 'Connect a model' });
  if (alerts.events?.length) items.push({ kind: 'warning', icon: 'logs', title: `${alerts.events.length} unread monitoring alert${alerts.events.length === 1 ? '' : 's'}`, detail: alerts.events[0]?.ruleName ? `Latest: ${alerts.events[0].ruleName}` : '', href: '/alerts', action: 'Review' });
  for (const f of flows.filter((x) => x.lifecycle?.state === 'deployed' && x.draftChanged)) items.push({ kind: 'info', icon: 'deploy', title: `${f.name} has undeployed changes`, detail: 'Callers still get the live version until you deploy the draft.', href: `/flows/${encodeURIComponent(f.id)}`, action: 'Review' });
  fill(attention, items.length
    ? items.slice(0, 8).map((i) => h('div', { class: ['attention-item', i.kind] }, h('span', { class: 'icon-wrap' }, icon(i.icon, 16)), h('div', { class: 'grow' }, h('strong', {}, i.title), i.detail ? h('div', { class: 'small muted truncate', title: i.detail }, i.detail) : null), h('a', { href: i.href, 'data-link': '', class: 'btn btn-sm btn-secondary' }, i.action)))
    : h('div', { class: 'callout callout-success' }, icon('checkCircle'), h('div', {}, h('strong', {}, 'Everything looks good'), h('p', {}, overview.deployed ? `${overview.deployed} deployed workflow${overview.deployed === 1 ? ' is' : 's are'} live and your models are reachable.` : 'Models are reachable and nothing is failing.'))));

  const recent = [...flows].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 4);
  fill(flowsBox, recent.length
    ? h('div', { class: 'stack-sm' }, recent.map((f) => h('a', { href: `/flows/${encodeURIComponent(f.id)}`, 'data-link': '', class: 'attention-item', style: { color: 'inherit', textDecoration: 'none' } },
      h('div', { class: 'grow' }, h('strong', { class: 'truncate', style: { display: 'block' } }, f.name), h('div', { class: 'small muted row' }, triggerChip(f.trigger), h('span', {}, `· edited ${timeAgo(f.updatedAt)}`))), lifecycleBadge(f))))
    : h('div', { class: 'empty', style: { padding: '24px 8px' } }, h('div', { class: 'empty-icon' }, icon('wand', 26)), h('h3', {}, 'Nothing built yet'), h('p', {}, 'Describe an idea above, or start from a template.'), button('Browse templates', { onClick: () => navigate('/templates') })));

  fill(modelsBox, models.length ? models.map((m) => h('div', { class: 'row' },
    badge(m.ok ? 'online' : 'offline', m.ok ? 'success' : 'danger'),
    h('strong', {}, m.name), m.kind === 'mock' ? badge('demo only', 'warning') : null,
    h('span', { class: 'muted small grow truncate' }, m.ok ? `${m.models.length} model(s)${m.models.length ? `: ${m.models.slice(0, 3).map((x) => x.id).join(', ')}` : ''}` : (m.error ?? '')),
    overview.defaults.chat === m.connection ? badge('default', 'accent') : null)) : h('p', { class: 'muted' }, 'No connections yet.'));
}

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-note' }, note));
}

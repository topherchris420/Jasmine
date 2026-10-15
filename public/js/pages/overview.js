import { api } from '../api.js';
import { button, card, h, icon, ms, num, page, statusBadge, table, timeAgo, toast } from '../ui.js';
import { openCreate } from './flows.js';

export async function render(container, _params, { navigate }) {
  const [overview, models, templates] = await Promise.all([api.get('/api/overview'), api.get('/api/models').catch(() => []), api.get('/api/templates')]);
  const chatReady = models.some((m) => m.ok && m.kind !== 'builtin' && m.models.some((x) => x.kind === 'chat'));
  const embedReady = models.some((m) => m.ok && m.models.some((x) => x.kind === 'embedding'));
  const steps = [
    { done: chatReady, title: 'Connect a model', text: chatReady ? 'A chat model is reachable.' : 'Connect a hosted API or a model server you control.', href: '/models' },
    { done: overview.flows > 0, title: 'Create a flow', text: 'Start from a template or a blank canvas.', action: () => openCreate(navigate) },
    { done: overview.collections > 0, title: 'Add knowledge (optional)', text: embedReady ? 'Create a vector database and upload documents for RAG.' : 'RAG works with the built-in embeddings; pull an embedding model (e.g. nomic-embed-text) for semantic search.', href: '/context' },
    { done: overview.deployed > 0, title: 'Deploy and call it', text: 'Deploy a flow, then use the API, webhook, chat widget or a schedule.', href: '/deployments' },
  ];
  const w = overview.week;
  container.append(page(`Welcome to ${overview.project.name}`, 'Build, test, deploy and improve your AI applications in one workspace.',
    [button('Create flow', { kind: 'primary', icon: 'plus', onClick: () => openCreate(navigate) })],
    h('section', { class: 'workspace-hero' },
      h('div', {}, h('span', { class: 'eyebrow' }, 'THE SPACE BETWEEN IDEA AND EXECUTION'), h('h2', {}, 'Make intelligence useful.'),
        h('p', {}, 'Connect a trigger to your models, knowledge and tools. See every step. Ship something that works.'),
        h('div', { class: 'row row-wrap' }, h('a', { href: '/templates', 'data-link': '', class: 'btn btn-primary' }, 'Explore templates →'), h('a', { href: '/setup', 'data-link': '', class: 'btn btn-secondary' }, 'Getting started'))),
      h('div', { class: 'hero-flow', 'aria-label': 'Build, test, ship' }, ['Trigger', 'Intelligence', 'Your application'].map((label, i) => h('div', {}, h('span', {}, `0${i + 1}`), h('strong', {}, label))))),
    h('div', { class: 'grid grid-4' },
      stat('Flows', num(overview.flows), `${overview.deployed} deployed`),
      stat('Runs (7 days)', num(w.runs), w.runs ? `${Math.round((w.successRate ?? 0) * 100)}% succeeded` : 'No runs yet'),
      stat('Median latency', ms(w.p50Ms), w.p95Ms ? `p95 ${ms(w.p95Ms)}` : ''),
      stat('Tokens (7 days)', num(w.inputTokens + w.outputTokens), `${num(w.llmCalls)} model calls`)),
    h('div', { class: 'grid grid-2' },
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Get started')),
        h('div', { class: 'checklist' }, steps.map((s) => h('div', { class: ['check-item', s.done ? 'done' : ''] },
          h('span', { class: 'check-dot' }, icon('check', 12)),
          h('div', { class: 'grow' }, h('div', { class: 'check-title', style: { fontWeight: 600 } }, s.title), h('div', { class: 'muted small' }, s.text)),
          s.href ? h('a', { href: s.href, 'data-link': '', class: 'small' }, 'Open →') : button('Start', { size: 'sm', onClick: s.action }))))),
      card(h('div', { class: 'card-head' }, h('h2', {}, 'Model connections'), h('a', { href: '/models', 'data-link': '', class: 'small' }, 'Manage →')),
        h('div', { class: 'stack-sm' }, models.map((m) => h('div', { class: 'row' },
          h('span', { class: 'badge', style: { background: m.ok ? 'var(--success-soft)' : 'var(--danger-soft)', color: m.ok ? 'var(--success)' : 'var(--danger)' } }, m.ok ? 'online' : 'offline'),
          h('strong', {}, m.name), h('span', { class: 'muted small grow truncate' }, m.ok ? `${m.models.length} model(s)${m.models.length ? `: ${m.models.slice(0, 3).map((x) => x.id).join(', ')}` : ''}` : (m.error ?? '')),
          overview.defaults.chat === m.connection ? statusBadge('default chat') : null))))),
    h('div', { class: 'row spread' }, h('h2', {}, 'A starting point for your next idea'), h('a', { href: '/templates', 'data-link': '' }, 'All templates →')),
    h('div', { class: 'grid grid-3' }, templates.slice(0, 3).map(template => card(h('span', { class: 'eyebrow' }, template.category), h('h3', {}, template.name), h('p', { class: 'muted' }, template.description), button('Use template →', { onClick: async event => { const btn = event.currentTarget; btn.disabled = true; try { const flow = await api.post('/api/flows', { templateId: template.id }); navigate(`/flows/${flow.id}`); } catch (error) { toast(error.message, 'error'); } finally { btn.disabled = false; } } })))),
    card(h('div', { class: 'card-head' }, h('h2', {}, 'Recent runs'), h('a', { href: '/logs', 'data-link': '', class: 'small' }, 'All logs →')),
      table([
        { label: 'When', render: (r) => h('span', { class: 'nowrap' }, timeAgo(r.startedAt)) },
        { label: 'Flow', render: (r) => r.flowId },
        { label: 'Source', render: (r) => r.source },
        { label: 'Status', render: (r) => statusBadge(r.status) },
        { label: 'Duration', class: 'num', render: (r) => ms(r.durationMs) },
      ], overview.recent, { onRowClick: (r) => navigate(`/logs/${r.id}`), empty: h('p', { class: 'muted' }, 'Runs appear here as soon as a flow is tested or called.') }))));
}

function stat(label, value, note) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-note' }, note));
}

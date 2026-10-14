import { api } from '../api.js';
import { badge, button, card, emptyState, h, num, page, statusBadge, table, timeAgo, toast } from '../ui.js';
import { TRIGGER_LABEL, triggerChip } from '../shared.js';

export async function render(container, _params, { navigate }) {
  const [flows, schedules, report] = await Promise.all([api.get('/api/flows'), api.get('/api/schedules'), api.get('/api/reports?days=1').catch(() => null)]);
  const deployed = flows.filter((f) => f.deployedVersion);
  const drafts = flows.filter((f) => !f.deployedVersion);
  const stats = new Map((report?.byFlow ?? []).map((r) => [r.flowId, r]));
  container.append(page('Deployments', 'Deployed flows are live: callable over the API, from webhooks and widgets, and on schedules. Each deploy creates an immutable version you can roll back to.', [],
    table([
      { label: 'Flow', render: (f) => h('div', {}, h('div', { class: 'cell-title' }, f.name), h('code', { class: 'cell-sub' }, f.id)) },
      { label: 'Trigger', render: (f) => triggerChip(f.trigger) },
      { label: 'Version', render: (f) => h('div', { class: 'row' }, h('code', {}, f.deployedVersion.slice(0, 12)), f.draftChanged ? badge('draft has changes', 'warning') : null) },
      { label: 'Deployed', render: (f) => h('span', { class: 'muted nowrap' }, timeAgo(f.deployedAt)) },
      { label: 'Runs (24 h)', class: 'num', render: (f) => {
        const s = stats.get(f.id);
        return s ? h('span', {}, num(s.runs), s.failed ? h('span', { style: { color: 'var(--danger)' } }, ` · ${s.failed} failed`) : null) : h('span', { class: 'muted' }, '0');
      } },
    ], deployed, {
      onRowClick: (f) => navigate(`/deployments/${encodeURIComponent(f.id)}`),
      empty: emptyState('deploy', 'Nothing deployed yet', 'Open a flow and press Deploy. Its API endpoint, webhook URL or widget code then appears here.', button('Go to flows', { kind: 'primary', icon: 'flows', onClick: () => navigate('/flows') })),
    }),
    schedules.length ? card(h('div', { class: 'card-head' }, h('h2', {}, 'Schedules')),
      table([
        { label: 'Flow', render: (s) => h('a', { href: `/deployments/${encodeURIComponent(s.flowId)}`, 'data-link': '' }, s.flowId) },
        { label: 'Trigger', render: (s) => TRIGGER_LABEL[s.trigger] ?? s.trigger },
        { label: 'Schedule', render: (s) => h('div', {}, h('code', {}, s.expression), s.timezone ? h('span', { class: 'muted small' }, ` ${s.timezone}`) : null, s.error ? h('div', { class: 'small', style: { color: 'var(--danger)' } }, s.error) : null) },
        { label: 'Next run', render: (s) => s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—' },
        { label: 'Last run', render: (s) => s.lastFiredAt ? h('span', { class: 'row' }, s.lastStatus ? statusBadge(s.lastStatus) : null, s.lastRunId ? h('a', { href: `/logs/${s.lastRunId}`, 'data-link': '', class: 'small' }, timeAgo(s.lastFiredAt)) : timeAgo(s.lastFiredAt)) : h('span', { class: 'muted' }, 'never') },
        { label: '', class: 'num', render: (s) => button('Run now', { size: 'sm', icon: 'play', onClick: async () => {
          const r = await api.post(`/api/schedules/${encodeURIComponent(s.flowId)}/run`);
          toast(r.requestId ? 'Run started' : 'Nothing to run', r.requestId ? 'success' : 'info');
          if (r.requestId) navigate(`/logs/${r.requestId}`);
        } }) },
      ], schedules)) : null,
    drafts.length ? card(h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Not deployed'), h('p', {}, 'Draft flows run only from the builder\'s Test panel.'))),
      h('div', { class: 'row row-wrap' }, drafts.map((f) => h('a', { href: `/flows/${encodeURIComponent(f.id)}`, 'data-link': '', class: 'badge badge-neutral' }, f.name)))) : null));
}
